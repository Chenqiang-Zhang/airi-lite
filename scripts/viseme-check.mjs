// Turns stored MiniMax streams (.sse captures) into the JSON /api/speech would
// have returned for them, for the debug page's "Play capture…"
// (stage.html?debug=performance): a real clip then plays with its real word
// timings through the browser's own MP3 decoder and src/visemes.ts. Offline:
// the server's own collectMinimaxStream parses each capture, nothing is sent
// anywhere and nothing is billed.
//
//   node scripts/viseme-check.mjs [--out=.data/viseme-check] [--dry-run] [capture.sse | directory ...]
//
// Without paths it reads server/fixtures/*.sse and .data/p5b-check/*/sse/*.sse.
// A capture next to a results.jsonl (scripts/minimax-p5b-check.mjs) takes its
// text, tone and act from there; otherwise they are rebuilt from the words.
// Writes <out>/<name>.json, only inside .data/ (the audio is the provider's,
// so it stays out of git). Each JSON is the server's response plus a
// `capture` note, which the client decoder ignores. Prints every word with
// its vowel reading, and the stale-tail check, which needs only the words and
// the stream's audio_length. The lead check needs the decoded envelope, so
// the debug page shows it (Mouth readout, "clip tracks").
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { collectMinimaxStream } from '../server/minimax.mjs'
import { isAct, normaliseEmotion } from '../shared/performance-cues.mjs'
import { readingOf, STALE_TAIL } from '../src/visemes.ts'

export const ROOT = fileURLToPath(new URL('..', import.meta.url))
export const DEFAULT_OUT = '.data/viseme-check'
const DEFAULT_INPUTS = ['server/fixtures', '.data/p5b-check']
const ACT_TAGS = Object.freeze({ '(laughs)': 'laugh', '(sighs)': 'sigh' })

// The stream's own facts the response leaves out: the audio length the
// stale check compares against, and the largest text offset (the bound
// collectMinimaxStream checks subtitles against; the sent text is not here).
export function streamFacts(raw) {
  let audioLength = null
  let textLength = 0
  for (const event of raw.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n').trim()
    if (!data.startsWith('{')) continue
    let chunk
    try { chunk = JSON.parse(data) }
    catch { continue }
    if (Number.isFinite(chunk?.extra_info?.audio_length)) audioLength = chunk.extra_info.audio_length / 1_000
    for (const subtitle of [chunk?.data?.subtitle, ...(Array.isArray(chunk?.data?.subtitles) ? chunk.data.subtitles : [])]) {
      if (Number.isSafeInteger(subtitle?.text_end)) textLength = Math.max(textLength, subtitle.text_end)
    }
  }
  return { audioLength, textLength }
}

// The p5b check keeps one results.jsonl per run, next to its sse/ folder; a
// request that was rerun has several lines, and the last one wrote the file.
export function requestFor(file) {
  const results = join(dirname(file), '..', 'results.jsonl')
  if (basename(dirname(file)) !== 'sse' || !existsSync(results)) return null
  const id = basename(file, '.sse')
  let found = null
  for (const line of readFileSync(results, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line)
      if (entry?.id === id && entry.request) found = { ...entry.request, ...(entry.sent?.model ? { model: entry.sent.model } : {}) }
    }
    catch { /* a torn line is not this capture's */ }
  }
  return found
}

// The text as the stage would have had it, from the words: the act tag goes
// back to an act, and a dictionary name (one word per unit) is said once.
export function textFromWords(words) {
  const texts = words.map(word => word.text)
  const act = ACT_TAGS[texts[0]]
  const spoken = (act ? texts.slice(1) : texts).filter((text, index, list) => text.length < 2 || text !== list[index - 1])
  return { text: spoken.join(''), ...(act ? { act } : {}) }
}

export function captureName(file) {
  const id = basename(file, '.sse')
  return basename(dirname(file)) === 'sse' ? `${basename(dirname(dirname(file)))}--${id}` : id
}

// The response the client would have received, with the capture note, and
// what to print about it. Throws what collectMinimaxStream throws (a refused
// request's stream is not a speech stream).
export async function buildCapture(raw, { name, source = name, request = null } = {}) {
  const { audioLength, textLength } = streamFacts(raw)
  const response = await collectMinimaxStream(new Response(raw).body, { textLength })
  const rebuilt = textFromWords(response.words)
  const lastEnd = response.words.reduce((end, word) => Math.max(end, word.end), 0)
  const tail = audioLength === null ? null : audioLength - lastEnd
  const stale = tail !== null && tail > STALE_TAIL
  const delivery = normaliseEmotion(request?.delivery) ?? 'neutral'
  const act = isAct(request?.act) ? request.act : rebuilt.act
  const capture = {
    id: name, source, text: typeof request?.text === 'string' ? request.text : rebuilt.text, delivery,
    ...(act ? { act } : {}), ...(request?.model ? { model: request.model } : {}),
    audioLength, lastWordEnd: lastEnd, tail, stale,
  }
  const words = response.words.map(word => `${word.text}${readingOf(word.text) ? `(${readingOf(word.text)})` : ''}@${word.start.toFixed(3)}-${word.end.toFixed(3)}`)
  return {
    response: { ...response, capture },
    report: { name, source, words: response.words.length, audioLength, tail, stale, line: words.join(' ') },
  }
}

function inputsFrom(paths, root) {
  const files = []
  const visit = (path, depth) => {
    if (!existsSync(path)) return
    if (statSync(path).isDirectory()) {
      // Deep enough for .data/p5b-check/<run>/sse/*.sse.
      if (depth > 3) return
      for (const entry of readdirSync(path).sort()) visit(join(path, entry), depth + 1)
    }
    else if (path.endsWith('.sse')) {
      files.push(path)
    }
  }
  for (const path of paths) visit(isAbsolute(path) ? path : resolve(root, path), 0)
  return files
}

function insideData(out, root) {
  const data = resolve(root, '.data')
  const target = resolve(root, out)
  return target === data || target.startsWith(data + sep)
}

// 0 when at least one capture was converted; 1 for nothing to convert or an
// output folder outside .data/.
export async function main(argv = process.argv.slice(2), { root = ROOT, log = console.log } = {}) {
  const flags = argv.filter(arg => arg.startsWith('--'))
  const paths = argv.filter(arg => !arg.startsWith('--'))
  const out = flags.find(flag => flag.startsWith('--out='))?.slice(6) || DEFAULT_OUT
  const dryRun = flags.includes('--dry-run')
  const unknown = flags.filter(flag => !flag.startsWith('--out=') && flag !== '--dry-run')
  if (unknown.length) {
    log(`unknown option ${unknown.join(', ')}`)
    return 1
  }
  if (!insideData(out, root)) {
    log(`--out must be inside ${join(root, '.data')}: captures hold provider audio and stay out of git`)
    return 1
  }
  const files = inputsFrom(paths.length ? paths : DEFAULT_INPUTS, root)
  if (!files.length) {
    log('no .sse captures found')
    return 1
  }
  const target = resolve(root, out)
  let converted = 0
  for (const file of files) {
    const name = captureName(file)
    const source = relative(root, file) || file
    let built
    try {
      built = await buildCapture(readFileSync(file, 'utf8'), { name, source, request: requestFor(file) })
    }
    catch (error) {
      log(`${name}: skipped, not a speech stream (${error?.detail ?? error?.code ?? error?.message ?? error})`)
      continue
    }
    const { report } = built
    const tail = report.tail === null ? 'tail ?' : `tail ${report.tail.toFixed(2)} s`
    const verdict = report.stale ? `STALE (> ${STALE_TAIL} s: no vowel track, audio mouth)` : 'ok'
    const written = dryRun ? '' : ` → ${relative(root, join(target, `${name}.json`))}`
    log(`${name}: ${report.words} words · audio ${report.audioLength?.toFixed(2) ?? '?'} s · ${tail} · ${verdict}${written}`)
    log(`  ${report.line}`)
    if (!dryRun) {
      await mkdir(target, { recursive: true })
      await writeFile(join(target, `${name}.json`), `${JSON.stringify(built.response)}\n`)
    }
    converted++
  }
  log(`${converted} of ${files.length} captures ${dryRun ? 'checked' : `written to ${relative(root, target) || target}`}`)
  return converted ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = await main()
