// The P5b measurement: 21 MiniMax requests through the server's real speech
// path (same tone table, dictionary, request checks and daily ledger as the
// stream), timed from the moment the stage would ask for a clip. It decides
//   (a) how much joining same-tone sentences into one request delays the
//       first audio on the live stage (the server returns a clip only once
//       its whole stream has arrived, so completion is when audio can start),
//   (b) a linear fit total_time = a + b * units over every latency request,
//   (c) whether the pronunciation rules are heard right and whether they are
//       billed (usage with and without a dictionary),
//   (d) whether full-width bracket pinyin is performed or read as text.
//
//   node --env-file-if-exists=.env.local scripts/minimax-p5b-check.mjs [--real] [--voice=ID] [--model=speech-2.8-turbo] [--out=DIR] [--max-requests=N] [--only=ID,ID] [--gap-ms=N]
//
// Billed per character: about 470 characters of text plus 40 in dictionary
// rules, reserved twice (about 1,020) in .data/tts-budget.json like every
// MiniMax call; the dry run prints the exact figures and today's ledger. MiniMax is enabled
// for this run only; .env.local is not changed. Without --real nothing is
// sent and the plan is printed. No request is ever retried: a retry would
// time a second attempt as if it were the first. --max-requests caps the
// paid requests (default: the whole plan). --only runs just the listed
// requests (by id, in plan order) and --gap-ms waits that long between
// requests (default 1000): the account refused requests with status 1002
// "rate limit exceeded(RPM)" after about 14 in 25 s on 2026-10-20.
//
// Writes <out>/results.jsonl (one line per request, no audio), the raw
// stream of each request in <out>/sse/<id>.sse, and <out>/index.html to
// listen to. An existing results.jsonl is never overwritten.
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { planUtterance } from '../server/live/utterance.mjs'
import { buildMinimaxRequest } from '../server/minimax.mjs'
import { MINIMAX_PRONUNCIATION } from '../server/minimax-pronunciation.mjs'
import { createSpeechHandler } from '../server/speech.mjs'
import { readSpeechConfig, resolveSpeechProvider } from '../server/speech-provider.mjs'
import { createTtsBudget } from '../server/tts-budget.mjs'
import { buildAuditionPage, sentFields } from './minimax-audition.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

// Real replies from the 2026-10-20 live-style runs (the `final` field of
// docs/reviews/<run>/results.jsonl, line given), chosen because the stage's
// planner splits each into several sentences of one tone and no act. Of the
// 地铁坏了 replies the first multi-sentence one is used (some are a single
// sentence). Their recorded tone 'bright' is the old name for happy.
export const LATENCY_REPLIES = Object.freeze([
  Object.freeze({ id: 'strawberry', source: '2026-10-20-live-style-3/results.jsonl:105', delivery: 'bright',
    text: '草莓党举手！不过巧克力太甜太腻的我不太行。芒果偶尔吃一次也挺好。' }),
  Object.freeze({ id: 'hospital', source: '2026-10-20-live-style-2/results.jsonl:162', delivery: 'soft',
    text: '大晚上还在医院陪着，辛苦啦。猫猫会好起来的。' }),
  Object.freeze({ id: 'subway', source: '2026-10-20-live-style-2/results.jsonl:123', delivery: 'bright',
    text: '地铁坏了还能跑过去，这波诚意先加十分。下周等你好消息啊。' }),
])
// One request near the 60-unit join limit, so the fit is not drawn from
// short requests only.
export const LONG_REPLY = Object.freeze({ id: 'long', source: '2026-10-20-live-style-2/results.jsonl:75', delivery: 'soft',
  text: '嗯……晚上本来就容易把人往这种情绪里带。睡不着还提不起劲，是挺熬人的。要是这几天一直这样，白天找个信得过的人说说话吧。' })
export const ROUNDS = 2
export const LATENCY_KINDS = Object.freeze(['alone', 'joined', 'long'])

const NAME = '我是日和，今天也请多指教。'
const LATIN_NAME = '大家好，我是Hiyori。'
const BRACKETS = '这是（he2）平，不是（huo4）面。'

// The sentences a reply is spoken as, refused unless they can be bought as
// one request: several sentences, one tone, no act.
async function sameToneSentences(reply, plan) {
  const sentences = await plan({ text: reply.text, delivery: reply.delivery })
  if (sentences.length < 2 || sentences.some(sentence => sentence.delivery !== sentences[0].delivery || sentence.act))
    throw new Error(`${reply.id} is not several sentences of one tone without an act`)
  return sentences
}

// Every request in the order it is sent. The act clip goes first so the
// connection is warm before any timed pair (no latency request pays the
// TLS handshake); the pairs then alternate alone, joined, alone, joined, so
// drift during the run does not bias one side; one long request ends each
// round. Every entry names its dictionary explicitly, so an operator's
// MINIMAX_PRONUNCIATION does not change what is measured.
export async function buildPlan({ replies = LATENCY_REPLIES, long = LONG_REPLY, rounds = ROUNDS, plan = planUtterance } = {}) {
  const pairs = []
  for (const reply of replies) {
    const sentences = await sameToneSentences(reply, plan)
    const delivery = sentences[0].delivery
    pairs.push({ reply, alone: { text: sentences[0].text, delivery },
      // Chinese sentences need no joiner.
      joined: { text: sentences.map(sentence => sentence.text).join(''), delivery } })
  }
  const longSentences = await sameToneSentences(long, plan)
  const longRequest = { text: longSentences.map(sentence => sentence.text).join(''), delivery: longSentences[0].delivery }

  const entries = [{ id: 'act-laugh', group: 'act', kind: 'act', pronunciation: MINIMAX_PRONUNCIATION,
    request: { text: '这个梗我接住了！你们今天弹幕好热闹。', delivery: 'happy', act: 'laugh' } }]
  for (let round = 1; round <= rounds; round++) {
    for (const { reply, alone, joined } of pairs) {
      entries.push({ id: `${reply.id}-${round}-alone`, group: reply.id, kind: 'alone', round, pronunciation: MINIMAX_PRONUNCIATION, request: alone })
      entries.push({ id: `${reply.id}-${round}-joined`, group: reply.id, kind: 'joined', round, pronunciation: MINIMAX_PRONUNCIATION, request: joined })
    }
    entries.push({ id: `${long.id}-${round}`, group: long.id, kind: 'long', round, pronunciation: MINIMAX_PRONUNCIATION, request: longRequest })
  }
  entries.push(
    { id: 'name-none', group: 'name', kind: 'name', pronunciation: [], request: { text: NAME, delivery: 'neutral' } },
    { id: 'name-shipped', group: 'name', kind: 'name', pronunciation: MINIMAX_PRONUNCIATION, request: { text: NAME, delivery: 'neutral' } },
    { id: 'latin-none', group: 'latin', kind: 'latin', pronunciation: [], request: { text: LATIN_NAME, delivery: 'happy' } },
    { id: 'latin-pinyin', group: 'latin', kind: 'latin', pronunciation: ['Hiyori/(ri4)(he2)'], request: { text: LATIN_NAME, delivery: 'happy' } },
    { id: 'latin-kana', group: 'latin', kind: 'latin', pronunciation: ['Hiyori/ひより'], request: { text: LATIN_NAME, delivery: 'happy' } },
    // Already full width, so the adapter sends it exactly as written.
    { id: 'bracket', group: 'bracket', kind: 'bracket', pronunciation: MINIMAX_PRONUNCIATION, request: { text: BRACKETS, delivery: 'neutral' } },
  )
  return entries.map((entry, index) => Object.freeze({ ...entry, order: index + 1,
    pronunciation: Object.freeze([...entry.pronunciation]), request: Object.freeze({ ...entry.request }) }))
}

// The config one request is sent with: the run's config and its dictionary.
export const entryConfig = (config, entry) => Object.freeze({ ...config, pronunciation: entry.pronunciation })

const dictionaryOf = payload => payload.pronunciation_dict?.tone ?? []
const ruleCharacters = payload => dictionaryOf(payload).reduce((sum, rule) => sum + rule.length, 0)

// What the plan sends and reserves, from the adapter and the provider's own
// reservation (the same estimate the ledger is charged).
export function describePlan(plan, config, provider = resolveSpeechProvider(config)) {
  const entries = plan.map((entry) => {
    const selected = entryConfig(config, entry)
    const payload = buildMinimaxRequest(selected, entry.request)
    return { entry, payload, units: payload.text.length, ruleCharacters: ruleCharacters(payload),
      reservation: provider.estimateReservation(selected, entry.request) }
  })
  const sum = field => entries.reduce((total, item) => total + item[field], 0)
  return { requests: entries.length, textCharacters: sum('units'), dictionaryCharacters: sum('ruleCharacters'),
    reservation: sum('reservation'), entries }
}

// Wall-clock timing of each request, from a fetch wrapper the speech handler
// is given. The body passes through a TransformStream, so the collector still
// streams exactly as on the stage while each chunk's arrival time and the raw
// SSE text are noted. `start()` begins a record before synthesise() is
// called (the stage's clock starts there, ledger reservation included).
export function createTimingRecorder({ inner = fetch, now = () => performance.now() } = {}) {
  let current = null
  const recorder = {
    start() {
      current = { startedAt: now(), fetches: 0, chunks: [], raw: [], events: 0, audioEvents: 0, segments: 0 }
      return current
    },
    finish(record) {
      record.resolvedAt = now()
      if (current === record)
        current = null
      return record
    },
    async fetch(url, init) {
      const record = current ?? recorder.start()
      record.fetches++
      record.fetchStartedAt = now()
      record.payload = sentPayload(init?.body)
      const response = await inner(url, init)
      record.headersAt = now()
      record.status = response.status
      record.contentType = response.headers.get('content-type')
      if (!response.body)
        return response
      // The adapter discards an HTTP error's body unread; keep it to read later.
      if (!response.ok) {
        const raw = Buffer.from(await response.arrayBuffer())
        record.raw.push(raw)
        return new Response(raw, { status: response.status, statusText: response.statusText, headers: response.headers })
      }
      const observer = sseObserver(record, now)
      // Generous queues: a chunk is timed when it arrives, not when the
      // collector gets round to reading it.
      const queue = { highWaterMark: 1_024 }
      const body = response.body.pipeThrough(new TransformStream({
        transform(chunk, controller) {
          observer.chunk(chunk)
          controller.enqueue(chunk)
        },
        flush() {
          observer.end()
        },
      }, queue, queue))
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
    },
  }
  return recorder
}

// The request fields worth keeping; never headers (the key is there).
function sentPayload(body) {
  try {
    const payload = JSON.parse(body)
    return { text: payload.text, emotion: payload.voice_setting?.emotion ?? null, speed: payload.voice_setting?.speed,
      pronunciation_dict: payload.pronunciation_dict ?? null, model: payload.model }
  }
  catch {
    return null
  }
}

// Notes, per complete SSE event: the first that carries audio, how the first
// subtitle segment grows (it stops growing when another segment starts or the
// final event arrives), and the final event's extra_info. It only watches;
// anything it cannot parse is left for the collector to judge.
function sseObserver(record, now) {
  const decoder = new TextDecoder()
  let buffer = ''
  let lines = []
  let first = null
  let at = 0
  const seen = new Set()
  const grew = (subtitle) => {
    const words = Array.isArray(subtitle.timestamped_words) ? subtitle.timestamped_words.length : 0
    const grown = !first || subtitle.text_end > first.textEnd || subtitle.time_end > first.timeEnd || words > first.words
    if (grown)
      first = { begin: subtitle.text_begin, textEnd: Math.max(subtitle.text_end, first?.textEnd ?? 0),
        timeEnd: Math.max(subtitle.time_end, first?.timeEnd ?? 0), words: Math.max(words, first?.words ?? 0) }
    return grown
  }
  const consume = () => {
    const data = lines.join('\n').trim()
    lines = []
    if (!data || data === '[DONE]')
      return
    record.events++
    let event
    try {
      event = JSON.parse(data)
    }
    catch {
      return
    }
    const payload = event?.data
    if (typeof payload?.audio === 'string' && payload.audio) {
      record.audioEvents++
      record.firstAudioAt ??= at
    }
    const subtitle = payload?.subtitle
    if (subtitle && Number.isInteger(subtitle.text_begin) && Number.isFinite(subtitle.time_end)) {
      seen.add(subtitle.text_begin)
      record.segments = seen.size
      if (first === null || subtitle.text_begin === first.begin) {
        if (grew(subtitle))
          record.firstSegmentGrewAt = at
      }
      else {
        record.nextSegmentAt ??= at
      }
    }
    if (payload?.status === 2) {
      record.finalAt ??= at
      record.finalInfo = event.extra_info && typeof event.extra_info === 'object' ? event.extra_info : null
    }
  }
  const take = (text) => {
    buffer += text
    const parts = buffer.split('\n')
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      const line = part.replace(/\r$/, '')
      if (!line)
        consume()
      else if (line.startsWith('data:'))
        lines.push(line.slice(5).replace(/^ /, ''))
    }
  }
  return {
    chunk(bytes) {
      at = now()
      record.chunks.push([at, bytes.byteLength])
      record.raw.push(Buffer.from(bytes))
      take(decoder.decode(bytes, { stream: true }))
    },
    end() {
      at = now()
      record.streamEndAt = at
      take(`${decoder.decode()}\n\n`)
    },
  }
}

const round1 = value => Number.isFinite(value) ? Math.round(value * 10) / 10 : null
const since = (record, value) => value === undefined ? null : round1(value - record.startedAt)

// The timings of one record, in ms from the moment synthesise() was called.
export function recordTimings(record) {
  const segmentDone = record.firstSegmentGrewAt !== undefined && (record.nextSegmentAt !== undefined || record.finalAt !== undefined)
  return {
    fetchStartMs: since(record, record.fetchStartedAt),
    headersMs: since(record, record.headersAt),
    firstByteMs: since(record, record.chunks[0]?.[0]),
    firstAudioMs: since(record, record.firstAudioAt),
    firstSegmentDoneMs: segmentDone ? since(record, record.firstSegmentGrewAt) : null,
    streamEndMs: since(record, record.streamEndAt),
    resolvedMs: since(record, record.resolvedAt),
  }
}

function usageOf(result, finalInfo) {
  if (result?.usage)
    return result.usage
  if (!Number.isSafeInteger(finalInfo?.usage_characters))
    return null
  return { billableCharacters: finalInfo.usage_characters,
    ...(Number.isSafeInteger(finalInfo.word_count) ? { textCharacters: finalInfo.word_count } : {}) }
}

// One results.jsonl line: what was sent, when each stage arrived, what came
// back. No audio (it is in the page and the raw stream).
export function resultLine({ entry, planned, record, result, error, reservation, at }) {
  const sent = record?.payload ?? { text: planned.text, emotion: planned.voice_setting.emotion ?? null,
    speed: planned.voice_setting.speed, pronunciation_dict: planned.pronunciation_dict ?? null, model: planned.model }
  const duration = record?.finalInfo?.audio_length / 1_000
  return {
    id: entry.id, order: entry.order, group: entry.group, kind: entry.kind, ...(entry.round ? { round: entry.round } : {}),
    at, request: entry.request, sent, fetched: Boolean(record?.fetches), units: sent.text?.length ?? null, reservation,
    timing: record ? recordTimings(record) : null,
    chunks: record ? record.chunks.map(([time, bytes]) => [round1(time - record.startedAt), bytes]) : [],
    events: record?.events ?? 0, audioEvents: record?.audioEvents ?? 0, segments: record?.segments ?? 0,
    http: record?.status === undefined ? null : { status: record.status, contentType: record.contentType },
    audioBytes: result ? Buffer.from(result.audio, 'base64').length : null,
    durationSeconds: Number.isFinite(duration) ? duration : null,
    usage: usageOf(result, record?.finalInfo),
    outcome: error ? { code: error.code ?? error.name ?? 'ERROR', ...(error.detail ? { detail: error.detail } : {}) } : { code: 'OK' },
  }
}

// No later request can pass where one of these failed, and none was sent.
const STOPPING = new Set(['TTS_DAILY_LIMIT', 'TTS_BUDGET_UNAVAILABLE', 'TTS_NOT_CONFIGURED'])
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

// Sends the plan in order, each request once, saving each line and raw
// stream as it arrives, then writes the page and returns the summary.
// `speechFor(entry)` is the server's speech handler for that entry's config;
// `recorder` is the timing recorder its fetch goes through.
export async function runCheck({ plan, config, out, cap = plan.length, speechFor, recorder, reservationFor = () => null,
  wait = pause, log = console.log, progress = () => process.stdout.write('.'), clock = () => new Date(), gapMs = 1_000 }) {
  await mkdir(join(out, 'sse'), { recursive: true })
  const resultsPath = join(out, 'results.jsonl')
  // A paid run's results are never overwritten.
  await writeFile(resultsPath, '', { flag: 'wx' })
  const lines = []
  const audio = new Map()
  let requests = 0
  let stopped = null
  for (const entry of plan) {
    const planned = buildMinimaxRequest(entryConfig(config, entry), entry.request)
    const reservation = reservationFor(entry)
    if (stopped || requests >= cap) {
      const line = resultLine({ entry, planned, reservation, at: clock().toISOString(),
        error: { code: 'SKIPPED', detail: stopped ? `stopped after ${stopped}` : 'request cap reached' } })
      lines.push(line)
      await appendFile(resultsPath, `${JSON.stringify(line)}\n`)
      continue
    }
    if (requests)
      await wait(gapMs)
    requests++
    const speech = speechFor(entry)
    const at = clock().toISOString()
    const record = recorder.start()
    let result = null
    let error = null
    try {
      result = await speech.synthesise(entry.request)
    }
    catch (caught) {
      error = caught
    }
    recorder.finish(record)
    if (record.raw.length)
      await writeFile(join(out, 'sse', `${entry.id}.sse`), Buffer.concat(record.raw))
    const line = resultLine({ entry, planned, record, result, error, reservation, at })
    lines.push(line)
    await appendFile(resultsPath, `${JSON.stringify(line)}\n`)
    if (result)
      audio.set(entry.id, result.audio)
    if (error) {
      log(`\n${entry.id}: ${line.outcome.code}${line.outcome.detail ? ` (${line.outcome.detail})` : ''}`)
      if (STOPPING.has(error.code))
        stopped = error.code
    }
    else {
      progress()
    }
  }
  const summary = summariseResults(lines)
  const page = join(out, 'index.html')
  await writeFile(page, buildCheckPage({ plan, lines, audio, config, summary, date: clock().toISOString().slice(0, 16).replace('T', ' ') }))
  return { requests, lines, summary, page, resultsPath }
}

export function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length)
    return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

// Ordinary least squares y = a + b x; null without two distinct x values.
export function leastSquares(points) {
  const valid = points.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
  const n = valid.length
  if (n < 2)
    return null
  const meanX = valid.reduce((sum, [x]) => sum + x, 0) / n
  const meanY = valid.reduce((sum, [, y]) => sum + y, 0) / n
  let sxx = 0
  let sxy = 0
  let syy = 0
  for (const [x, y] of valid) {
    sxx += (x - meanX) ** 2
    sxy += (x - meanX) * (y - meanY)
    syy += (y - meanY) ** 2
  }
  if (!sxx)
    return null
  const b = sxy / sxx
  return { a: meanY - b * meanX, b, n, r2: syy ? sxy ** 2 / (sxx * syy) : 1 }
}

const ok = line => line.outcome.code === 'OK'

// The numbers the decision needs, from results.jsonl lines.
export function summariseResults(lines) {
  const pairs = []
  for (const group of [...new Set(lines.filter(line => line.kind === 'alone' || line.kind === 'joined').map(line => line.group))]) {
    const side = kind => {
      const done = lines.filter(line => line.group === group && line.kind === kind && ok(line))
      return { n: done.length, units: lines.find(line => line.group === group && line.kind === kind)?.units ?? null,
        medianMs: median(done.map(line => line.timing.resolvedMs)),
        firstAudioMedianMs: median(done.map(line => line.timing.firstAudioMs)),
        firstSegmentDoneMedianMs: median(done.map(line => line.timing.firstSegmentDoneMs)) }
    }
    const alone = side('alone')
    const joined = side('joined')
    pairs.push({ group, alone, joined,
      deltaMs: alone.medianMs === null || joined.medianMs === null ? null : joined.medianMs - alone.medianMs })
  }
  const deltas = pairs.map(pair => pair.deltaMs).filter(Number.isFinite)
  const fit = leastSquares(lines.filter(line => LATENCY_KINDS.includes(line.kind) && ok(line))
    .map(line => [line.units, line.timing.resolvedMs]))
  const dictionary = []
  for (const group of ['name', 'latin']) {
    const members = lines.filter(line => line.group === group)
    const baseline = members.find(line => !line.sent.pronunciation_dict)
    for (const line of members) {
      const billable = line.usage?.billableCharacters
      const base = baseline?.usage?.billableCharacters
      dictionary.push({ id: line.id, group, rules: line.sent.pronunciation_dict?.tone ?? [], outcome: line.outcome.code,
        usage: line.usage, durationSeconds: line.durationSeconds,
        billableDelta: line === baseline || !Number.isFinite(billable) || !Number.isFinite(base) ? null : billable - base })
    }
  }
  // Sent means it reached fetch (the paid count); a request the server
  // refused first (ledger, config, input) is counted apart, never as sent.
  const skipped = line => line.outcome.code === 'SKIPPED'
  return {
    pairs, maxDeltaMs: deltas.length ? Math.max(...deltas) : null, fit, dictionary,
    requests: { planned: lines.length, sent: lines.filter(line => line.fetched).length,
      ok: lines.filter(ok).length,
      failed: lines.filter(line => line.fetched && !ok(line)).length,
      refused: lines.filter(line => !line.fetched && !skipped(line)).length,
      skipped: lines.filter(skipped).length },
  }
}

const ms = value => value === null || value === undefined ? '—' : `${Math.round(value)} ms`
const signedMs = value => value === null ? '—' : `${value >= 0 ? '+' : ''}${Math.round(value)} ms`

export function formatSummary(summary) {
  const lines = ['Latency (completion = synthesise() resolved: the stage can play nothing before it):']
  for (const { group, alone, joined, deltaMs } of summary.pairs) {
    lines.push(`  ${group.padEnd(11)} alone ${alone.units ?? '?'}u ${ms(alone.medianMs)} (n=${alone.n}) | joined ${joined.units ?? '?'}u ${ms(joined.medianMs)} (n=${joined.n}) | Δ ${signedMs(deltaMs)}`
      + `  · first audio ${ms(alone.firstAudioMedianMs)} / ${ms(joined.firstAudioMedianMs)}, joined first segment done ${ms(joined.firstSegmentDoneMedianMs)}`)
  }
  lines.push(`  max Δ ${signedMs(summary.maxDeltaMs)}`)
  const { fit } = summary
  lines.push(fit ? `Fit over ${fit.n} latency requests: total_time ≈ ${fit.a.toFixed(0)} ms + ${fit.b.toFixed(1)} ms × units (r² ${fit.r2.toFixed(2)})`
    : 'Fit: not enough successful latency requests.')
  lines.push('Dictionary (billable / text characters, billable change vs no dictionary):')
  for (const item of summary.dictionary) {
    const usage = item.usage ? `${item.usage.billableCharacters} / ${item.usage.textCharacters ?? '?'}` : '—'
    lines.push(`  ${item.id.padEnd(13)} ${(item.rules.join(', ') || 'none').padEnd(20)} ${usage}${item.billableDelta === null ? '' : ` (${item.billableDelta >= 0 ? '+' : ''}${item.billableDelta})`}${item.outcome === 'OK' ? '' : ` ${item.outcome}`}`)
  }
  const { requests } = summary
  lines.push(`Requests: ${requests.sent} sent of ${requests.planned} planned, ${requests.ok} ok, ${requests.failed} failed, `
    + `${requests.refused} refused before sending, ${requests.skipped} skipped.`)
  return lines.join('\n')
}

const GROUP_TITLES = {
  act: '整段 + 笑（fixture 候选）',
  long: '长句（接近 60 字上限）',
  name: '名字「日和」：无词典 vs 内置词典',
  latin: '「Hiyori」：无词典 / 拼音 / 假名',
  bracket: '全角括号拼音：会被念成拼音吗？',
}

// The listening page, one section per group in plan order (each pair's
// clips together: round 1 alone, joined, then round 2), titled with its
// median completion times.
export function buildCheckPage({ plan, lines, audio, config, summary, date }) {
  const byId = new Map(lines.map(line => [line.id, line]))
  const groups = [...new Set(plan.map(entry => entry.group))]
  const results = groups.map((group) => {
    const pair = summary.pairs.find(item => item.group === group)
    const reply = LATENCY_REPLIES.find(item => item.id === group)
    const title = pair ? `${reply?.text.slice(0, 6) ?? group}…：单句 / 整段 ×${ROUNDS} · 完成中位数 ${ms(pair.alone.medianMs)} / ${ms(pair.joined.medianMs)} · Δ ${signedMs(pair.deltaMs)}`
      : GROUP_TITLES[group] ?? group
    const parts = plan.filter(entry => entry.group === group).map((entry) => {
      const sent = byId.get(entry.id)?.sent
      return { text: entry.request.text, delivery: entry.request.delivery, ...(entry.request.act ? { act: entry.request.act } : {}),
        audio: audio.get(entry.id),
        sent: sent ? { text: sent.text, emotion: sent.emotion ?? undefined, speed: sent.speed,
          ...(sent.pronunciation_dict ? { dictionary: sent.pronunciation_dict.tone } : {}) }
          : sentFields(buildMinimaxRequest(entryConfig(config, entry), entry.request)) }
    })
    return { id: group, title, parts }
  })
  return buildAuditionPage({ results, voice: config.voiceId, model: config.model, date, heading: 'MiniMax P5b 检查',
    note: '每个请求只发一次，计时从 synthesise() 开始。成对的单句和整段放在一起听；名字、Hiyori 和括号三组用来判断词典和全角括号是否被正确念出。' })
}

// The listed requests in plan order; an unknown id stops the run unbilled.
export function selectPlan(plan, only) {
  if (!only)
    return plan
  const unknown = only.filter(id => !plan.some(entry => entry.id === id))
  if (unknown.length)
    throw new Error(`--only names no planned request: ${unknown.join(', ')}`)
  return plan.filter(entry => only.includes(entry.id))
}

// Strict, so a typo stops the run before anything is billed. An empty value
// is refused too: `--out=$OUT` with OUT unset would otherwise write a paid
// run's files into the working directory instead of .data/.
export function parseArguments(argv) {
  const known = ['real', 'voice', 'model', 'out', 'max-requests', 'only', 'gap-ms']
  const values = {}
  let real = false
  for (const value of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(value)
    if (!match || !known.includes(match[1]) || (match[1] === 'real') !== (match[2] === undefined) || match[2] === '')
      throw new Error(`unknown or malformed argument: ${value} (use --real, --voice=ID, --model=…, --out=DIR, --max-requests=N, --only=ID,ID, --gap-ms=N)`)
    // The first of a repeated flag wins, as before.
    if (match[1] === 'real')
      real = true
    else
      values[match[1]] ??= match[2]
  }
  if (values['max-requests'] !== undefined && !/^\d+$/.test(values['max-requests']))
    throw new Error('--max-requests must be a whole number')
  if (values['gap-ms'] !== undefined && (!/^\d{1,5}$/.test(values['gap-ms']) || Number(values['gap-ms']) > 60_000))
    throw new Error('--gap-ms must be a whole number of milliseconds, at most 60000')
  const only = values.only === undefined ? undefined : values.only.split(',')
  if (only && (only.some(id => !/^[a-z0-9-]+$/.test(id)) || new Set(only).size !== only.length))
    throw new Error('--only must be distinct request ids separated by commas')
  return { real, voice: values.voice, model: values.model, out: values.out,
    maxRequests: values['max-requests'] === undefined ? undefined : Number(values['max-requests']),
    only, gapMs: values['gap-ms'] === undefined ? undefined : Number(values['gap-ms']) }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const env = {
    ...process.env,
    TTS_PROVIDER: 'minimax',
    MINIMAX_TTS_ENABLED: '1',
    ...(options.voice ? { MINIMAX_VOICE_ID: options.voice } : {}),
    ...(options.model ? { MINIMAX_TTS_MODEL: options.model } : {}),
  }
  const config = readSpeechConfig(env)
  const provider = resolveSpeechProvider(config)
  const plan = selectPlan(await buildPlan(), options.only)
  const totals = describePlan(plan, config, provider)
  const out = options.out ?? join(root, '.data', 'p5b-check', `${new Date().toISOString().slice(0, 10)}-${config.model ?? 'model'}`)
  const cap = options.maxRequests ?? plan.length
  for (const { entry, payload, units, reservation } of totals.entries) {
    const rules = dictionaryOf(payload)
    console.log(`${String(entry.order).padStart(2)}. ${entry.id.padEnd(20)} ${entry.request.delivery}${entry.request.act ? `+${entry.request.act}` : ''}`
      + `  「${payload.text}」 ${units}u, reserve ${reservation}${rules.length ? `, dictionary ${rules.join(', ')}` : ''}`)
  }
  // One ledger for every request, whichever dictionary it is sent with.
  const budget = createTtsBudget({ path: join(root, '.data', provider.ledgerFilename), dailyLimit: config.dailyLimit })
  const today = await budget.peek()
  console.log(`Plan: ${totals.requests} requests, ${totals.textCharacters} characters sent (+${totals.dictionaryCharacters} in dictionary rules), `
    + `ledger reservation ${totals.reservation} (${provider.ledgerFilename}: ${today?.reserved ?? '?'} of ${config.dailyLimit || '?'} reserved today), `
    + `at most ${cap} paid requests (${config.model ?? '?'}, region ${config.region ?? '?'}). Folder: ${out}`)
  if (!options.real)
    return console.log('Nothing sent. Add --real to synthesise (billed).')
  if (!config.configured)
    throw new Error('MiniMax is not usable: check MINIMAX_API_KEY, MINIMAX_VOICE_ID, MINIMAX_TTS_DAILY_CHAR_LIMIT and the region/model in .env.local.')
  const recorder = createTimingRecorder()
  const reservations = new Map(totals.entries.map(item => [item.entry.id, item.reservation]))
  const { summary, page, resultsPath } = await runCheck({ plan, config, out, cap, recorder, gapMs: options.gapMs,
    reservationFor: entry => reservations.get(entry.id),
    speechFor: entry => createSpeechHandler({ rootDirectory: root, config: entryConfig(config, entry), budget, fetchImpl: recorder.fetch }),
  }).catch((error) => {
    throw error?.code === 'EEXIST' ? new Error(`${join(out, 'results.jsonl')} already exists; pass another --out`) : error
  })
  console.log(`\n${formatSummary(summary)}`)
  console.log(`Wrote ${resultsPath}, ${join(out, 'sse')} and ${page}.`)
  if (summary.requests.failed || summary.requests.refused || summary.requests.skipped)
    process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main().catch((error) => {
    console.error(`minimax-p5b-check: ${error.message}`)
    process.exitCode = 1
  })
}
