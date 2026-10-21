// A short MiniMax listening test through the server's real speech path: the
// same tone table, act tags, request checks and daily ledger the stream uses.
// It writes one self-contained page (audio embedded) to listen to.
//
//   node --env-file-if-exists=.env.local scripts/minimax-audition.mjs --real [--voice=ID] [--model=speech-2.8-turbo] [--out=DIR] [--max-requests=N]
//
// Billed per character (about 150 here, reserved twice in .data/tts-budget.json
// like every MiniMax call). MiniMax is enabled for this run only; .env.local
// is not changed. Without --real nothing is sent and the plan is printed.
//
// Each clip is saved as soon as it arrives, so a rerun with the same voice,
// model and output folder only asks for the missing ones. A failed request is
// retried once after a pause; --max-requests caps every paid request,
// retries included (default: the missing clips plus 2). A failure's raw
// response is kept next to the page for diagnosis.
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { ACT_PAUSE_SECONDS } from '../shared/performance-cues.mjs'
import { buildMinimaxRequest } from '../server/minimax.mjs'
import { createSpeechHandler } from '../server/speech.mjs'
import { readSpeechConfig } from '../server/speech-provider.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

// Each sample is one or more requests played in order. A part with act
// 'pause' gets the player's silence before it, as on the stage.
export const SAMPLES = Object.freeze([
  { id: 'neutral', title: '平常', parts: [{ text: '晚上好呀，今天也随便聊聊。', delivery: 'neutral' }] },
  { id: 'happy-laugh', title: '开心 + 笑', parts: [{ text: '这个梗我接住了！', delivery: 'happy', act: 'laugh' }] },
  { id: 'soft', title: '温柔', parts: [{ text: '辛苦了，先歇一会儿吧。', delivery: 'soft' }] },
  { id: 'curious-pause', title: '好奇 + 停顿', parts: [{ text: '这个嘛', delivery: 'curious' }, { text: '我猜是草莓味。', delivery: 'curious', act: 'pause' }] },
  { id: 'surprised', title: '惊讶', parts: [{ text: '真的假的？这都被你找到了！', delivery: 'surprised' }] },
  { id: 'sad-sigh', title: '难过 + 叹气', parts: [{ text: '今天的雨下得好大，出不了门了。', delivery: 'sad', act: 'sigh' }] },
  { id: 'pout', title: '假装生气', parts: [{ text: '哼，这局先算你赢，下局可不一定。', delivery: 'pout' }] },
  { id: 'shy', title: '害羞', parts: [{ text: '突然这么夸我，有点不好意思了。', delivery: 'shy' }] },
  { id: 'split', title: '逐句合成（现在的做法）', parts: [
    { text: '晚上好呀！', delivery: 'happy' },
    { text: '今天弹幕好热闹。', delivery: 'happy' },
    { text: '我们先从第一条开始吧。', delivery: 'happy' },
  ] },
  { id: 'joined', title: '整段合成（对比）', parts: [{ text: '晚上好呀！今天弹幕好热闹。我们先从第一条开始吧。', delivery: 'happy' }] },
])

export const plannedCharacters = (samples = SAMPLES) => samples.flatMap(sample => sample.parts).reduce((sum, part) => sum + part.text.length, 0)

// A saved clip is reused only for the same voice, model and request.
export const clipKey = ({ voice, model, part }) => createHash('sha256')
  .update(JSON.stringify([voice, model, part.text, part.delivery, part.act ?? null])).digest('hex').slice(0, 16)

const ACT_LABELS = { laugh: '笑', sigh: '叹气', pause: '停顿' }
const escapeHtml = text => String(text).replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`)

// The listening page: every clip embedded, a play button per sample that
// plays its parts back to back (with the pause act's silence), and what was
// actually sent (emotion, speed, the text with the act tag).
export function buildAuditionPage({ results, voice, model, date }) {
  const sections = results.map((sample) => {
    const parts = sample.parts.map((part, index) => `
      <li>
        ${part.audio
          ? `<audio id="${sample.id}-${index}" preload="auto" controls src="data:audio/mpeg;base64,${part.audio}" data-pause="${part.act === 'pause' ? ACT_PAUSE_SECONDS : 0}"></audio>`
          : '<span class="missing">这一段没有生成成功</span>'}
        <span class="text">${escapeHtml(part.text)}</span>
        <span class="meta">${escapeHtml(part.delivery)}${part.act ? ` · ${ACT_LABELS[part.act]}` : ''} → ${escapeHtml(part.sent.emotion ?? '自动')} · 语速 ${part.sent.speed}${part.sent.text !== part.text ? ` · 发送「${escapeHtml(part.sent.text)}」` : ''}</span>
      </li>`).join('')
    const complete = sample.parts.every(part => part.audio)
    return `
    <section>
      <h2>${escapeHtml(sample.title)} ${complete ? `<button type="button" data-sample="${sample.id}" data-count="${sample.parts.length}">播放</button>` : ''}</h2>
      <ol>${parts}</ol>
    </section>`
  }).join('')
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MiniMax 试听</title>
<style>
  :root { color-scheme: light dark; --fg: #1f2328; --muted: #59636e; --bg: #ffffff; --line: #d1d9e0; }
  @media (prefers-color-scheme: dark) { :root { --fg: #e6edf3; --muted: #9198a1; --bg: #0d1117; --line: #3d444d; } }
  body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg); font: 15px/1.6 system-ui, sans-serif; max-width: 760px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p.note { color: var(--muted); margin: 0 0 16px; }
  section { border-top: 1px solid var(--line); padding: 8px 0; }
  h2 { font-size: 16px; margin: 4px 0; display: flex; gap: 8px; align-items: center; }
  ol { margin: 0; padding-left: 20px; }
  li { margin: 6px 0; }
  audio { width: 100%; max-width: 360px; height: 32px; display: block; }
  .meta { display: block; color: var(--muted); font-size: 13px; }
  .missing { display: block; color: #cf222e; }
  button { font: inherit; padding: 2px 10px; }
</style>
</head>
<body>
<h1>MiniMax 试听（${escapeHtml(model)}）</h1>
<p class="note">${escapeHtml(date)} · 音色 ${escapeHtml(voice)} · 每句都走直播用的同一条服务端路径。「播放」按舞台的方式依次播放各段；停顿是播放器加的 ${ACT_PAUSE_SECONDS} 秒静音。最后两段比较逐句合成和整段合成。</p>
${sections}
<script>
  const wait = seconds => new Promise(resolve => setTimeout(resolve, seconds * 1000))
  const playToEnd = audio => new Promise((resolve) => { audio.currentTime = 0; audio.onended = resolve; audio.play().catch(resolve) })
  document.querySelectorAll('button[data-sample]').forEach((button) => {
    button.addEventListener('click', async () => {
      document.querySelectorAll('audio').forEach(audio => audio.pause())
      for (let index = 0; index < Number(button.dataset.count); index++) {
        const audio = document.getElementById(button.dataset.sample + '-' + index)
        await wait(Number(audio.dataset.pause))
        await playToEnd(audio)
      }
    })
  })
</script>
</body>
</html>
`
}

function argument(name) {
  const found = process.argv.find(value => value.startsWith(`--${name}=`))
  return found ? found.slice(name.length + 3) : undefined
}

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

// Keeps the raw body of the latest response, so a rejected stream can be
// saved and read later. The audition only; the live server streams as before.
export function recordingFetch(inner = fetch) {
  const recorder = { last: null }
  recorder.fetch = async (url, init) => {
    recorder.last = null
    const response = await inner(url, init)
    const raw = await response.text()
    recorder.last = { status: response.status, contentType: response.headers.get('content-type'), raw }
    return new Response(raw, { status: response.status, headers: response.headers })
  }
  return recorder
}

export const clipFile = ({ out, config, part }) => join(out, 'clips', `${clipKey({ voice: config.voiceId, model: config.model, part })}.json`)
export const readClip = async (file) => JSON.parse(await readFile(file, 'utf8').catch(() => 'null'))

// Makes the missing clips one by one (each saved as it arrives), then writes
// the page from every saved clip. `speech` is the server's speech handler;
// `recorder` holds the latest raw response.
export async function runAudition({ config, out, missing, cap, speech, recorder, wait = pause, log = console.log,
  progress = () => process.stdout.write('.') }) {
  const clipPath = part => clipFile({ out, config, part })
  const allParts = SAMPLES.flatMap(sample => sample.parts)
  await mkdir(join(out, 'clips'), { recursive: true })
  let requests = 0
  const failures = []
  for (const part of missing) {
    const request = { text: part.text, delivery: part.delivery, ...(part.act ? { act: part.act } : {}) }
    const built = buildMinimaxRequest(config, request)
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (requests >= cap) {
        failures.push({ part, reason: 'request cap reached' })
        break
      }
      if (requests)
        await wait(attempt === 1 ? 1_000 : 5_000)
      requests++
      recorder.last = null
      try {
        const result = await speech.synthesise(request)
        await writeFile(clipPath(part), JSON.stringify({ text: part.text, delivery: part.delivery, act: part.act ?? null,
          audio: result.audio, sent: { text: built.text, emotion: built.voice_setting.emotion, speed: built.voice_setting.speed } }))
        progress()
        break
      }
      catch (error) {
        const reason = `${error.code ?? error.message}${error.detail ? ` (${error.detail})` : ''}`
        log(`\n「${part.text}」 attempt ${attempt}: ${reason}`)
        if (recorder.last) {
          await mkdir(join(out, 'failed'), { recursive: true })
          const file = join(out, 'failed', `${clipKey({ voice: config.voiceId, model: config.model, part })}-${attempt}.txt`)
          await writeFile(file, `HTTP ${recorder.last.status} ${recorder.last.contentType}\n\n${recorder.last.raw}`)
          log(`  raw response: ${file}`)
        }
        // A spent budget or a bad request will not pass on a retry.
        if (attempt === 2 || ['TTS_DAILY_LIMIT', 'TTS_BUDGET_UNAVAILABLE', 'TTS_INVALID_REQUEST', 'TTS_NOT_CONFIGURED'].includes(error.code)) {
          failures.push({ part, reason })
          break
        }
      }
    }
  }

  const results = []
  for (const sample of SAMPLES) {
    const parts = []
    for (const part of sample.parts) {
      const clip = await readClip(clipPath(part))
      const built = buildMinimaxRequest(config, { text: part.text, delivery: part.delivery, ...(part.act ? { act: part.act } : {}) })
      parts.push({ ...part, audio: clip?.audio, sent: clip?.sent ?? { text: built.text, emotion: built.voice_setting.emotion, speed: built.voice_setting.speed } })
    }
    results.push({ ...sample, parts })
  }
  const date = new Date().toISOString().slice(0, 16).replace('T', ' ')
  const page = join(out, 'index.html')
  await writeFile(page, buildAuditionPage({ results, voice: config.voiceId, model: config.model, date }))
  const made = results.flatMap(sample => sample.parts).filter(part => part.audio).length
  log(`\n${requests} paid requests. ${made} of ${allParts.length} clips ready. Wrote ${page}`)
  for (const { part, reason } of failures)
    log(`  missing 「${part.text}」: ${reason}`)
  return { requests, made, failures, page }
}


async function main() {
  const known = ['real', 'voice', 'model', 'out', 'max-requests']
  for (const value of process.argv.slice(2)) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(value)
    if (!match || !known.includes(match[1]) || (match[1] === 'real') !== (match[2] === undefined))
      throw new Error(`unknown or malformed argument: ${value} (use --real, --voice=ID, --model=…, --out=DIR, --max-requests=N)`)
  }
  const env = {
    ...process.env,
    TTS_PROVIDER: 'minimax',
    MINIMAX_TTS_ENABLED: '1',
    ...(argument('voice') ? { MINIMAX_VOICE_ID: argument('voice') } : {}),
    ...(argument('model') ? { MINIMAX_TTS_MODEL: argument('model') } : {}),
  }
  const config = readSpeechConfig(env)
  const out = argument('out') ?? join(root, '.data', 'audition', `minimax-${new Date().toISOString().slice(0, 10)}-${config.model ?? 'model'}`)
  const allParts = SAMPLES.flatMap(sample => sample.parts)
  const missing = []
  for (const part of allParts) {
    if (!await readClip(clipFile({ out, config, part })))
      missing.push(part)
  }
  const rawCap = argument('max-requests')
  if (rawCap !== undefined && !/^\d+$/.test(rawCap))
    throw new Error('--max-requests must be a whole number')
  const cap = rawCap === undefined ? missing.length + 2 : Number(rawCap)
  console.log(`Plan: ${missing.length} of ${allParts.length} clips to make, ${plannedCharacters([{ parts: missing }])} characters, at most ${cap} paid requests (${config.model ?? '?'}, region ${config.region ?? '?'}). Folder: ${out}`)
  if (!process.argv.includes('--real'))
    return console.log('Nothing sent. Add --real to synthesise (billed).')
  if (missing.length && !config.configured)
    throw new Error('MiniMax is not usable: check MINIMAX_API_KEY, MINIMAX_VOICE_ID, MINIMAX_TTS_DAILY_CHAR_LIMIT and the region/model in .env.local.')

  const recorder = recordingFetch()
  const speech = createSpeechHandler({ rootDirectory: root, config, fetchImpl: recorder.fetch })
  const { failures } = await runAudition({ config, out, missing, cap, speech, recorder })
  if (failures.length)
    process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main().catch((error) => {
    console.error(`minimax-audition: ${error.message}`)
    process.exitCode = 1
  })
}
