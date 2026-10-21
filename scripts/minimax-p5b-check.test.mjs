import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { planUtterance } from '../server/live/utterance.mjs'
import { MINIMAX_PRONUNCIATION } from '../server/minimax-pronunciation.mjs'
import { buildMinimaxRequest, estimateMinimaxReservation, readMinimaxConfig, synthesiseMinimax } from '../server/minimax.mjs'
import { createSpeechHandler } from '../server/speech.mjs'
import { TtsBudgetError } from '../server/tts-budget.mjs'
import { buildPlan, createTimingRecorder, describePlan, entryConfig, formatSummary, LATENCY_REPLIES, leastSquares,
  LONG_REPLY, median, parseArguments, recordTimings, runCheck, summariseResults } from './minimax-p5b-check.mjs'

const env = { MINIMAX_TTS_ENABLED: '1', MINIMAX_API_KEY: 'test-secret-key', MINIMAX_VOICE_ID: 'test-voice',
  MINIMAX_TTS_DAILY_CHAR_LIMIT: '100000' }
const config = readMinimaxConfig(env)
// Structural fake MPEG-1 Layer III frames (32 kHz mono), not real audio.
const mp3 = Buffer.alloc(576 * 28)
for (let offset = 0; offset < mp3.length; offset += 576)
  Buffer.from([0xff, 0xfb, 0x98, 0xc0]).copy(mp3, offset)
const finalInfo = { audio_format: 'mp3', audio_sample_rate: 32_000, audio_channel: 1, audio_size: mp3.length, audio_length: 1_000 }
const event = frame => `data: ${JSON.stringify(frame)}\n\n`
const word = (text, begin, end, timeBegin, timeEnd) => ({ word: text, word_begin: begin, word_end: end, time_begin: timeBegin, time_end: timeEnd })
// A clock that moves on every reading, so every timing is distinct and ordered.
const ticking = () => {
  let time = 0
  return () => (time += 10)
}
// A body that hands over one string per pull.
const chunked = parts => new ReadableStream({
  pull(controller) {
    if (!parts.length)
      return controller.close()
    controller.enqueue(new TextEncoder().encode(parts.shift()))
  },
})
const sse = parts => new Response(chunked([...parts]), { headers: { 'content-type': 'text/event-stream' } })

// A valid stream for whatever text was sent: a first segment that grows over
// two events, then the final event; billing doubles the text and adds 3 when
// a dictionary was sent, so the summary has a difference to report.
function fakeStream(payload) {
  const length = payload.text.length
  const subtitle = (timeEnd, words) => ({ text: payload.text, text_begin: 0, text_end: length, time_begin: 0, time_end: timeEnd,
    timestamped_words: words })
  return [
    event({ base_resp: { status_code: 0 }, data: { status: 1, audio: mp3.subarray(0, 8_000).toString('hex'),
      subtitle: subtitle(400, [word(payload.text[0], 0, 1, 0, 200)]) } }),
    event({ base_resp: { status_code: 0 }, data: { status: 1, audio: mp3.subarray(8_000).toString('hex'),
      subtitle: subtitle(800, [word(payload.text[0], 0, 1, 0, 200), word(payload.text[1], 1, 2, 200, 400)]) } }),
    event({ base_resp: { status_code: 0 }, data: { status: 2, audio: '' },
      extra_info: { ...finalInfo, usage_characters: 2 * length + (payload.pronunciation_dict ? 3 : 0), word_count: length } }),
  ]
}

test('the plan is 21 requests from real same-tone replies, the timed pairs interleaved', async () => {
  const plan = await buildPlan()
  assert.equal(plan.length, 21)
  assert.equal(new Set(plan.map(entry => entry.id)).size, 21)
  assert.deepEqual(plan.map(entry => entry.order), plan.map((_, index) => index + 1))
  const count = kind => plan.filter(entry => entry.kind === kind).length
  assert.deepEqual(['act', 'alone', 'joined', 'long', 'name', 'latin', 'bracket'].map(count), [1, 6, 6, 2, 2, 3, 1])
  // The connection is warmed by an untimed request; then each round sends
  // every pair alone, joined, alone, joined, and one long request.
  assert.equal(plan[0].id, 'act-laugh')
  const latency = plan.filter(entry => ['alone', 'joined', 'long'].includes(entry.kind))
  assert.deepEqual(latency.map(entry => entry.order), latency.map((_, index) => index + 2), 'timed requests run back to back')
  for (const round of [1, 2]) {
    const sequence = latency.filter(entry => entry.round === round)
    assert.deepEqual(sequence.map(entry => entry.kind), ['alone', 'joined', 'alone', 'joined', 'alone', 'joined', 'long'])
    assert.deepEqual(sequence.map(entry => entry.group), ['strawberry', 'strawberry', 'hospital', 'hospital', 'subway', 'subway', 'long'])
  }
  assert.ok(Math.max(...latency.filter(entry => entry.round === 1).map(entry => entry.order))
    < Math.min(...latency.filter(entry => entry.round === 2).map(entry => entry.order)))

  for (const reply of LATENCY_REPLIES) {
    const sentences = await planUtterance({ text: reply.text, delivery: reply.delivery })
    const [alone, joined] = ['alone', 'joined'].map(kind => plan.find(entry => entry.group === reply.id && entry.kind === kind).request)
    assert.deepEqual(alone, { text: sentences[0].text, delivery: sentences[0].delivery })
    assert.deepEqual(joined, { text: reply.text, delivery: sentences[0].delivery }, 'the joined request is the whole reply')
    assert.ok(sentences.length >= 2 && sentences.every(sentence => sentence.delivery === alone.delivery && !sentence.act), reply.id)
  }
  const long = plan.filter(entry => entry.kind === 'long')
  assert.deepEqual(long[0].request, long[1].request)
  assert.equal(long[0].request.text, LONG_REPLY.text)
  assert.ok(long[0].request.text.length >= 55 && long[0].request.text.length <= 60, String(long[0].request.text.length))
  assert.deepEqual(plan.find(entry => entry.id === 'act-laugh').request, { text: '这个梗我接住了！你们今天弹幕好热闹。', delivery: 'happy', act: 'laugh' })
  assert.deepEqual(plan.filter(entry => entry.group === 'name').map(entry => [entry.request.text, entry.request.delivery, entry.pronunciation]),
    [['我是日和，今天也请多指教。', 'neutral', []], ['我是日和，今天也请多指教。', 'neutral', [...MINIMAX_PRONUNCIATION]]])
  assert.deepEqual(plan.filter(entry => entry.group === 'latin').map(entry => [entry.request.text, entry.request.delivery, entry.pronunciation]),
    [['大家好，我是Hiyori。', 'happy', []], ['大家好，我是Hiyori。', 'happy', ['Hiyori/(ri4)(he2)']], ['大家好，我是Hiyori。', 'happy', ['Hiyori/ひより']]])
  assert.deepEqual(plan.at(-1).request, { text: '这是（he2）平，不是（huo4）面。', delivery: 'neutral' })
})

test('every latency reply is a real recorded reply', async () => {
  for (const reply of [...LATENCY_REPLIES, LONG_REPLY]) {
    const [file, line] = reply.source.split(':')
    const lines = (await readFile(new URL(`../docs/reviews/${file}`, import.meta.url), 'utf8')).split('\n')
    const record = JSON.parse(lines[Number(line) - 1])
    assert.equal(record.final, reply.text, reply.source)
    assert.equal(record.delivery, reply.delivery, reply.source)
  }
})

test('a reply that cannot be bought as one request is refused', async () => {
  const reply = { id: 'x', text: '好。好。', delivery: 'happy' }
  for (const sentences of [
    [{ text: '好。', delivery: 'happy' }],
    [{ text: '好。', delivery: 'happy' }, { text: '好。', delivery: 'sad' }],
    [{ text: '好。', delivery: 'happy' }, { text: '好。', delivery: 'happy', act: 'laugh' }],
    [{ text: '好。', delivery: 'happy', act: 'pause' }, { text: '好。', delivery: 'happy' }],
  ]) {
    await assert.rejects(buildPlan({ replies: [reply], plan: async () => sentences }), /not several sentences of one tone/)
    await assert.rejects(buildPlan({ replies: [], long: reply, plan: async () => sentences }), /not several sentences of one tone/)
  }
})

test('the dry run totals what is sent and what the ledger reserves', async () => {
  const plan = await buildPlan()
  const totals = describePlan(plan, config)
  assert.equal(totals.requests, 21)
  const words = plan.reduce((sum, entry) => sum + entry.request.text.length, 0)
  assert.equal(totals.textCharacters, words + '(laughs)'.length)
  assert.equal(totals.textCharacters, 470)
  assert.equal(totals.dictionaryCharacters, '日和/(ri4)(he2)'.length + 'Hiyori/(ri4)(he2)'.length + 'Hiyori/ひより'.length)
  assert.equal(totals.reservation, 2 * (470 + 40))
  for (const { entry, payload, reservation } of totals.entries)
    assert.equal(reservation, estimateMinimaxReservation(entryConfig(config, entry), entry.request), entry.id)
  const sent = id => totals.entries.find(item => item.entry.id === id).payload
  assert.equal(sent('act-laugh').text, '(laughs)这个梗我接住了！你们今天弹幕好热闹。')
  assert.deepEqual(sent('name-shipped').pronunciation_dict, { tone: ['日和/(ri4)(he2)'] })
  assert.deepEqual(sent('latin-pinyin').pronunciation_dict, { tone: ['Hiyori/(ri4)(he2)'] })
  assert.deepEqual(sent('latin-kana').pronunciation_dict, { tone: ['Hiyori/ひより'] })
  for (const id of ['name-none', 'latin-none', 'bracket', 'act-laugh', 'strawberry-1-joined'])
    assert.equal(Object.hasOwn(sent(id), 'pronunciation_dict'), false, id)
  assert.equal(sent('bracket').text, '这是（he2）平，不是（huo4）面。', 'sent as written')
  // Each entry names its dictionary, so the operator's switch changes nothing.
  assert.equal(describePlan(plan, readMinimaxConfig({ ...env, MINIMAX_PRONUNCIATION: '0' })).reservation, totals.reservation)
})

test('the timing recorder tees a real stream: the collector gets the same bytes, each stage is timed', async () => {
  const raw = await readFile(new URL('../server/fixtures/minimax-2.8-cumulative.sse', import.meta.url), 'utf8')
  const parts = raw.split(/(?<=\n\n)/)
  assert.equal(parts.length, 7)
  const recorder = createTimingRecorder({ inner: async () => sse(parts), now: ticking() })
  const record = recorder.start()
  const text = '一二三四五六七八九十一二。'
  const result = await synthesiseMinimax(config, { text, delivery: 'happy' }, { fetchImpl: recorder.fetch })
  recorder.finish(record)
  assert.equal(Buffer.from(result.audio, 'base64').length, 49_005)
  assert.deepEqual(result.usage, { billableCharacters: 24, textCharacters: 13 })
  assert.equal(Buffer.concat(record.raw).toString('utf8'), raw, 'the raw SSE is kept whole')
  assert.equal(record.chunks.length, 7)
  assert.equal(record.events, 7)
  assert.equal(record.audioEvents, 5)
  assert.equal(record.segments, 1)
  assert.equal(record.fetches, 1)
  assert.deepEqual(record.payload, { text, emotion: 'happy', speed: 1, pronunciation_dict: null, model: 'speech-2.8-turbo' })
  assert.equal(record.finalInfo.audio_length, 2_960)
  // Chunk i carries event i: audio first arrives in event 0; the segment last
  // grows in event 3 (time_end 1194 → 2860); the final event is the last.
  const chunkAt = index => record.chunks[index][0] - record.startedAt
  const timings = recordTimings(record)
  assert.equal(timings.firstByteMs, chunkAt(0))
  assert.equal(timings.firstAudioMs, chunkAt(0))
  assert.equal(timings.firstSegmentDoneMs, chunkAt(3))
  assert.ok(timings.fetchStartMs > 0 && timings.headersMs > timings.fetchStartMs && timings.firstByteMs > timings.headersMs)
  assert.ok(timings.streamEndMs > chunkAt(6) && timings.resolvedMs > timings.streamEndMs)
  assert.equal(JSON.stringify(record).includes('test-secret-key'), false, 'no header is recorded')
})

test('the first segment is done when the next one starts; no audio or segments leaves those times empty', async () => {
  const mp3Hex = half => (half ? mp3.subarray(8_000) : mp3.subarray(0, 8_000)).toString('hex')
  const segment = (begin, end, timeBegin, timeEnd) => ({ text: '你好。再见。'.slice(begin, end), text_begin: begin, text_end: end,
    time_begin: timeBegin, time_end: timeEnd, timestamped_words: [word('你', begin, begin + 1, timeBegin, timeBegin + 100)] })
  const frames = [
    event({ base_resp: { status_code: 0 }, data: { status: 1, audio: '' } }),
    event({ base_resp: { status_code: 0 }, data: { status: 1, audio: mp3Hex(0), subtitle: segment(0, 3, 0, 300) } }),
    event({ base_resp: { status_code: 0 }, data: { status: 1, audio: '', subtitle: segment(0, 3, 0, 500) } }),
    event({ base_resp: { status_code: 0 }, data: { status: 1, audio: mp3Hex(1), subtitle: segment(0, 3, 0, 500) } }),
    event({ base_resp: { status_code: 0 }, data: { status: 1, audio: '', subtitle: segment(3, 6, 500, 900) } }),
    event({ base_resp: { status_code: 0 }, data: { status: 2, audio: '' }, extra_info: finalInfo }),
  ]
  const recorder = createTimingRecorder({ inner: async () => sse(frames), now: ticking() })
  const record = recorder.start()
  await synthesiseMinimax(config, { text: '你好。再见。', delivery: 'neutral' }, { fetchImpl: recorder.fetch })
  recorder.finish(record)
  const chunkAt = index => record.chunks[index][0] - record.startedAt
  const timings = recordTimings(record)
  assert.equal(timings.firstAudioMs, chunkAt(1), 'an empty audio field is not audio')
  assert.equal(timings.firstSegmentDoneMs, chunkAt(2), 'an unchanged repeat is not growth')
  assert.equal(record.segments, 2)

  // A failed request: headers but no stream events, and nothing to time after.
  const failing = createTimingRecorder({ inner: async () => new Response('busy', { status: 500 }), now: ticking() })
  const failed = failing.start()
  await assert.rejects(synthesiseMinimax(config, { text: '你好', delivery: 'neutral' }, { fetchImpl: failing.fetch }),
    { code: 'TTS_UPSTREAM_FAILED', detail: 'http-500' })
  failing.finish(failed)
  const empty = recordTimings(failed)
  assert.equal(failed.status, 500)
  assert.deepEqual([empty.firstAudioMs, empty.firstSegmentDoneMs], [null, null])
  assert.ok(empty.headersMs > 0 && empty.resolvedMs > empty.headersMs)
})

async function withFolder(run) {
  const out = await mkdtemp(join(tmpdir(), 'minimax-p5b-'))
  try {
    return await run(out)
  }
  finally {
    await rm(out, { recursive: true, force: true })
  }
}

test('a run sends each request once, never retries, honours the cap and keeps every result', async () => {
  await withFolder(async (out) => {
    const plan = await buildPlan()
    const totals = describePlan(plan, config)
    const failing = plan.find(entry => entry.id === 'hospital-1-alone').request.text
    const sent = []
    const recorder = createTimingRecorder({
      now: ticking(),
      inner: async (url, init) => {
        const payload = JSON.parse(init.body)
        sent.push(payload)
        return sent.length === 4 && payload.text === failing ? new Response('busy', { status: 500 }) : sse(fakeStream(payload))
      },
    })
    const reserved = []
    const budget = { reserve: async (characters) => { reserved.push(characters) } }
    const waits = []
    const logs = []
    const run = await runCheck({ plan, config, out, cap: 20, recorder,
      reservationFor: entry => totals.entries.find(item => item.entry === entry).reservation,
      speechFor: entry => createSpeechHandler({ rootDirectory: out, config: entryConfig(config, entry), budget, fetchImpl: recorder.fetch }),
      wait: async milliseconds => { waits.push(milliseconds) }, log: line => logs.push(line), progress: () => {},
      clock: () => new Date('2026-10-21T12:00:00Z') })

    assert.equal(run.requests, 20)
    assert.equal(sent.length, 20, 'the failure was not retried')
    assert.deepEqual(sent.map(payload => payload.text), totals.entries.slice(0, 20).map(item => item.payload.text), 'sent in plan order')
    assert.deepEqual(reserved, totals.entries.slice(0, 20).map(item => item.reservation), 'the ledger is charged the dry run\'s figures')
    assert.deepEqual(waits, Array(19).fill(1_000))
    assert.ok(logs.some(line => line.includes('hospital-1-alone: TTS_UPSTREAM_FAILED (http-500)')))

    const lines = (await readFile(run.resultsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(lines, run.lines)
    assert.equal(lines.length, 21)
    const byId = Object.fromEntries(lines.map(line => [line.id, line]))
    assert.deepEqual(byId['hospital-1-alone'].outcome, { code: 'TTS_UPSTREAM_FAILED', detail: 'http-500' })
    assert.deepEqual(byId['hospital-1-alone'].http, { status: 500, contentType: 'text/plain;charset=UTF-8' })
    assert.deepEqual(byId.bracket.outcome, { code: 'SKIPPED', detail: 'request cap reached' })
    assert.equal(byId.bracket.fetched, false)
    assert.equal(byId.bracket.sent.text, '这是（he2）平，不是（huo4）面。')
    const good = byId['strawberry-1-joined']
    assert.deepEqual(good.outcome, { code: 'OK' })
    assert.deepEqual(good.sent, { text: '草莓党举手！不过巧克力太甜太腻的我不太行。芒果偶尔吃一次也挺好。', emotion: 'happy', speed: 1,
      pronunciation_dict: null, model: 'speech-2.8-turbo' })
    assert.equal(good.units, 32)
    assert.equal(good.audioBytes, mp3.length)
    assert.equal(good.durationSeconds, 1)
    assert.deepEqual(good.usage, { billableCharacters: 64, textCharacters: 32 })
    assert.equal(good.chunks.length, 3)
    for (const field of ['fetchStartMs', 'headersMs', 'firstByteMs', 'firstAudioMs', 'firstSegmentDoneMs', 'streamEndMs', 'resolvedMs'])
      assert.ok(good.timing[field] > 0, field)
    assert.equal(good.timing.firstSegmentDoneMs, good.chunks[1][0])
    assert.deepEqual(byId['name-shipped'].sent.pronunciation_dict, { tone: ['日和/(ri4)(he2)'] })
    assert.equal(byId['name-none'].sent.pronunciation_dict, null)
    assert.equal(JSON.stringify(lines).includes(mp3.subarray(0, 64).toString('base64')), false, 'no audio in the results')
    assert.equal(JSON.stringify(lines).includes('test-secret-key'), false)

    const streams = await readdir(join(out, 'sse'))
    assert.equal(streams.length, 20)
    assert.equal(await readFile(join(out, 'sse', 'hospital-1-alone.sse'), 'utf8'), 'busy')
    assert.equal(await readFile(join(out, 'sse', 'act-laugh.sse'), 'utf8'), fakeStream(sent[0]).join(''))
    const page = await readFile(run.page, 'utf8')
    assert.equal(page.match(/<audio /g).length, 19)
    assert.equal(page.match(/这一段没有生成成功/g).length, 2)
    assert.match(page, /词典 日和\/\(ri4\)\(he2\)/)
    assert.match(page, /词典 Hiyori\/ひより/)
    // One section per group, in the order the plan first sends it.
    const sections = ['整段 + 笑', '草莓党举手！…', '大晚上还在医…', '地铁坏了还能…', '长句', '名字「日和」', '「Hiyori」', '全角括号']
      .map(title => page.indexOf(`<h2>${title}`))
    assert.ok(sections.every((index, at) => index > 0 && (at === 0 || index > sections[at - 1])), JSON.stringify(sections))
    assert.equal(page.match(/<section>/g).length, 8)
    assert.equal((page.split('草莓党举手！…')[1].split('<section>')[0].match(/<li>/g) ?? []).length, 4, 'each pair\'s four clips together')

    assert.deepEqual(run.summary.requests, { planned: 21, sent: 20, ok: 19, failed: 1, refused: 0, skipped: 1 })
    const hospital = run.summary.pairs.find(pair => pair.group === 'hospital')
    assert.deepEqual([hospital.alone.n, hospital.joined.n], [1, 2])
    assert.deepEqual(run.summary.dictionary.map(item => [item.id, item.billableDelta]),
      [['name-none', null], ['name-shipped', 3], ['latin-none', null], ['latin-pinyin', 3], ['latin-kana', 3]])
    assert.equal(run.summary.fit.n, 13)

    // A finished run's results are never overwritten.
    await assert.rejects(runCheck({ plan, config, out, recorder, speechFor: () => { throw new Error('not reached') } }), { code: 'EEXIST' })
  })
})

test('a spent ledger stops the run without sending anything more', async () => {
  await withFolder(async (out) => {
    const plan = await buildPlan()
    let fetched = 0
    const recorder = createTimingRecorder({ now: ticking(), inner: async (url, init) => { fetched++; return sse(fakeStream(JSON.parse(init.body))) } })
    let reservations = 0
    const budget = { reserve: async () => { if (++reservations === 3) throw new TtsBudgetError('TTS_DAILY_LIMIT') } }
    const run = await runCheck({ plan, config, out, recorder,
      speechFor: entry => createSpeechHandler({ rootDirectory: out, config: entryConfig(config, entry), budget, fetchImpl: recorder.fetch }),
      wait: async () => {}, log: () => {}, progress: () => {} })
    assert.equal(fetched, 2)
    assert.equal(run.requests, 3)
    assert.deepEqual(run.lines[2].outcome, { code: 'TTS_DAILY_LIMIT' })
    assert.equal(run.lines[2].fetched, false)
    assert.equal(run.lines[2].timing.fetchStartMs, null)
    assert.deepEqual(new Set(run.lines.slice(3).map(line => JSON.stringify(line.outcome))),
      new Set([JSON.stringify({ code: 'SKIPPED', detail: 'stopped after TTS_DAILY_LIMIT' })]))
    // The refused request never reached MiniMax, so it is not counted as sent.
    assert.deepEqual(run.summary.requests, { planned: 21, sent: 2, ok: 2, failed: 0, refused: 1, skipped: 18 })
    assert.match(formatSummary(run.summary), /Requests: 2 sent of 21 planned, 2 ok, 0 failed, 1 refused before sending, 18 skipped\./)
    assert.deepEqual(await readdir(join(out, 'sse')), ['act-laugh.sse', 'strawberry-1-alone.sse'])
  })
})

test('medians, the per-pair difference and the least-squares fit', () => {
  assert.equal(median([]), null)
  assert.equal(median([null, undefined]), null)
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([4, 1, 3, 2]), 2.5)
  assert.equal(leastSquares([]), null)
  assert.equal(leastSquares([[5, 100]]), null)
  assert.equal(leastSquares([[5, 100], [5, 200]]), null, 'one x value has no slope')
  assert.deepEqual(leastSquares([[10, 700], [20, 900], [30, 1_100], [null, 5]]), { a: 500, b: 20, n: 3, r2: 1 })
  const noisy = leastSquares([[0, 1], [1, 3], [2, 2], [3, 5]])
  assert.ok(Math.abs(noisy.b - 1.1) < 1e-9 && Math.abs(noisy.a - 1.1) < 1e-9 && Math.abs(noisy.r2 - 30.25 / 43.75) < 1e-9)

  const line = (id, group, kind, units, resolvedMs, extra = {}) => ({ id, group, kind, units, outcome: { code: 'OK' },
    timing: { resolvedMs, firstAudioMs: resolvedMs / 2, firstSegmentDoneMs: resolvedMs - 100 }, sent: { pronunciation_dict: null },
    fetched: true, usage: null, durationSeconds: 1, ...extra })
  const lines = [
    line('a1', 'a', 'alone', 10, 700), line('a2', 'a', 'joined', 30, 1_100),
    line('b1', 'b', 'alone', 20, 900), line('b2', 'b', 'joined', 20, 950),
    line('a3', 'a', 'alone', 10, 800), line('a4', 'a', 'joined', 30, 1_300),
    line('b3', 'b', 'alone', 20, 1_000, { outcome: { code: 'TTS_UPSTREAM_FAILED', detail: 'http-500' } }),
    line('b4', 'b', 'joined', 20, 1_050),
    line('l1', 'long', 'long', 60, 1_700),
    line('n1', 'name', 'name', 13, 600, { usage: { billableCharacters: 24, textCharacters: 13 } }),
    line('n2', 'name', 'name', 13, 600, { usage: { billableCharacters: 24, textCharacters: 13 }, sent: { pronunciation_dict: { tone: ['日和/(ri4)(he2)'] } } }),
    line('s1', 'bracket', 'bracket', 19, 650, { outcome: { code: 'SKIPPED', detail: 'request cap reached' }, fetched: false }),
  ]
  const summary = summariseResults(lines)
  assert.deepEqual(summary.pairs.map(pair => [pair.group, pair.alone.medianMs, pair.joined.medianMs, pair.deltaMs]),
    [['a', 750, 1_200, 450], ['b', 900, 1_000, 100]])
  assert.deepEqual(summary.pairs[0].joined, { n: 2, units: 30, medianMs: 1_200, firstAudioMedianMs: 600, firstSegmentDoneMedianMs: 1_100 })
  assert.equal(summary.maxDeltaMs, 450)
  const expected = leastSquares([[10, 700], [30, 1_100], [20, 900], [20, 950], [10, 800], [30, 1_300], [20, 1_050], [60, 1_700]])
  assert.deepEqual(summary.fit, expected)
  assert.deepEqual(summary.dictionary.map(item => [item.id, item.rules, item.billableDelta]),
    [['n1', [], null], ['n2', ['日和/(ri4)(he2)'], 0]])
  assert.deepEqual(summary.requests, { planned: 12, sent: 11, ok: 10, failed: 1, refused: 0, skipped: 1 })
  const printed = formatSummary(summary)
  assert.match(printed, /a +alone 10u 750 ms \(n=2\) \| joined 30u 1200 ms \(n=2\) \| Δ \+450 ms/)
  assert.match(printed, /max Δ \+450 ms/)
  assert.match(printed, new RegExp(`total_time ≈ ${expected.a.toFixed(0)} ms \\+ ${expected.b.toFixed(1)} ms × units`))
  assert.match(printed, /n2 +日和\/\(ri4\)\(he2\) +24 \/ 13 \(\+0\)/)
  assert.match(printed, /Requests: 11 sent of 12 planned, 10 ok, 1 failed, 0 refused before sending, 1 skipped\./)
  assert.match(formatSummary(summariseResults([])), /Fit: not enough/)
})

test('arguments are strict: an empty value is refused, so an unset --out never lands in the working directory', () => {
  assert.deepEqual(parseArguments([]), { real: false, voice: undefined, model: undefined, out: undefined, maxRequests: undefined, only: undefined, gapMs: undefined })
  assert.deepEqual(parseArguments(['--real', '--voice=v1', '--model=speech-2.8-hd', '--out=/tmp/p5b', '--max-requests=3']),
    { real: true, voice: 'v1', model: 'speech-2.8-hd', out: '/tmp/p5b', maxRequests: 3, only: undefined, gapMs: undefined })
  assert.deepEqual(parseArguments(['--max-requests=0']).maxRequests, 0)
  assert.equal(parseArguments(['--out=a', '--out=b']).out, 'a', 'the first of a repeated flag wins')
  for (const value of ['--out=', '--voice=', '--model=', '--max-requests='])
    assert.throws(() => parseArguments(['--real', value]), /malformed argument/, value)
  for (const value of ['--real=1', '--out', '--dry-run', '-real', 'real'])
    assert.throws(() => parseArguments([value]), /malformed argument/, value)
  for (const value of ['--max-requests=-1', '--max-requests=2.5', '--max-requests=ten'])
    assert.throws(() => parseArguments([value]), /whole number/, value)
})

test('--only picks requests in plan order and --gap-ms spaces them; bad values stop the run unbilled', async () => {
  const { buildPlan, parseArguments, selectPlan } = await import('./minimax-p5b-check.mjs')
  const plan = await buildPlan()
  const options = parseArguments(['--only=bracket,name-none', '--gap-ms=6000'])
  assert.deepEqual([options.only, options.gapMs], [['bracket', 'name-none'], 6_000])
  assert.deepEqual(selectPlan(plan, options.only).map(entry => entry.id), ['name-none', 'bracket'])
  assert.equal(selectPlan(plan, undefined), plan)
  assert.throws(() => selectPlan(plan, ['nope']), /no planned request: nope/)
  for (const bad of ['--gap-ms=60001', '--gap-ms=-1', '--gap-ms=1.5', '--only=a,a', '--only=A B', '--only='])
    assert.throws(() => parseArguments([bad]), /gap-ms|only|malformed/, bad)
  assert.equal(parseArguments([]).gapMs, undefined)
})
