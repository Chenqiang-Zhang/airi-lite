import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'

import { ACTS, EMOTIONS } from '../shared/performance-cues.mjs'
import { readMinimaxConfig } from './minimax.mjs'
import { buildElevenLabsRequest, readElevenLabsConfig } from './elevenlabs.mjs'
import { readSpeechConfig } from './speech-provider.mjs'
import { createSpeechHandler, createSpeechRateLimiter, normaliseSpeechRequest, speechErrorResponse, UPSTREAM_BACKOFF_MS } from './speech.mjs'
import { createTtsBudget } from './tts-budget.mjs'
import { SpeechProviderError } from './speech-error.mjs'

const config = readMinimaxConfig({ MINIMAX_TTS_ENABLED: '1', MINIMAX_API_KEY: 'test-key-do-not-leak',
  MINIMAX_VOICE_ID: 'test-private-voice', MINIMAX_TTS_DAILY_CHAR_LIMIT: '1000' })
const payload = { text: 'private synthetic sentence', delivery: 'neutral' }
class MockResponse extends EventEmitter {
  headersSent = false
  writableEnded = false
  destroyed = false
  writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true }
  end(body) { this.body = body; this.writableEnded = true }
}
function request(body = JSON.stringify(payload), headers = {}) {
  const readable = Readable.from([Buffer.from(body)])
  readable.headers = { 'content-type': 'application/json', 'x-demo-access-code': 'allowed-code', ...headers }
  readable.socket = { remoteAddress: 'test-ip' }
  return readable
}
function audioResponse(usageInfo = {}) {
  // Only a structural fake frame; this is not real/provider/decoded audio.
  const mp3 = Buffer.alloc(576)
  Buffer.from([0xff, 0xfb, 0x98, 0xc0]).copy(mp3)
  const chunk = { base_resp: { status_code: 0 }, data: { status: 2, audio: mp3.toString('hex') },
    extra_info: { audio_format: 'mp3', audio_sample_rate: 32_000, audio_channel: 1, audio_size: mp3.length,
      audio_length: 36, ...usageInfo } }
  return new Response(`data: ${JSON.stringify(chunk)}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
}
function create(options = {}) {
  return createSpeechHandler({ rootDirectory: '/unused-test-root', config,
    isValidCode: candidate => candidate === 'allowed-code', budget: { reserve: async () => {} },
    fetchImpl: async () => audioResponse(), ...options })
}
async function run(handler, req = request()) {
  const res = new MockResponse()
  await handler.handle(req, res)
  return res
}
function stalledFetch(onStart = () => {}) {
  return async (url, options) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(audioResponse()), 1_000)
    const abort = () => { clearTimeout(timer); reject(new Error('test-key-do-not-leak private synthetic sentence')) }
    options.signal.addEventListener('abort', abort, { once: true })
    onStart(options.signal)
  })
}
async function temporaryBudget(context, dailyLimit = 1_000) {
  const directory = await mkdtemp(join(tmpdir(), 'airi-speech-test-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'tts-budget.json')
  return { path, budget: createTtsBudget({ path, dailyLimit, now: () => Date.parse('2026-10-01T12:00:00Z') }) }
}

test('input permits only bounded well-formed text and delivery; no client identity/control overrides', () => {
  assert.deepEqual(normaliseSpeechRequest(payload), payload)
  assert.equal(normaliseSpeechRequest({ text: 'a'.repeat(360), delivery: 'soft' }).text.length, 360)
  assert.equal(normaliseSpeechRequest({ text: '😀'.repeat(180), delivery: 'happy' }).text.length, 360)
  assert.deepEqual(normaliseSpeechRequest({ ...payload, expectedProvider: 'minimax', expectedRegion: 'global' }),
    { ...payload, expectedProvider: 'minimax', expectedRegion: 'global' })
  assert.deepEqual(normaliseSpeechRequest({ ...payload, expectedRegion: 'cn' }), { ...payload, expectedRegion: 'cn' })
  for (const invalid of [null, [], {}, { ...payload, text: '' }, { ...payload, text: '  ' },
    { ...payload, text: 'a'.repeat(361) }, { ...payload, text: '😀'.repeat(181) }, { ...payload, text: '\u0000' },
    { ...payload, text: '\ud800' }, { ...payload, delivery: 'angry' }, { ...payload, delivery: null },
    { ...payload, delivery: 'Happy' }, { ...payload, delivery: '__proto__' }, { ...payload, delivery: 'toString' },
    { ...payload, voice_id: 'attacker' }, { ...payload, model: 'attacker' }, { ...payload, baseUrl: 'http://127.0.0.1' },
    { ...payload, endpoint: 'https://api.minimax.io/v1/t2a_v2' },
    { ...payload, expectedRegion: 'international' }, { ...payload, expectedRegion: 'GLOBAL' },
    { ...payload, expectedRegion: null }, { ...payload, expectedRegion: '' },
    { ...payload, expectedRegion: 'global', expectedProvider: 'elevenlabs' },
    { ...payload, expectedRegion: 'cn', expectedProvider: 'elevenlabs' }])
    assert.throws(() => normaliseSpeechRequest(invalid), { code: 'TTS_INVALID_REQUEST' })
})

test('every shared emotion is accepted, the old bright alias arrives as happy and an act is optional', () => {
  for (const delivery of EMOTIONS)
    assert.deepEqual(normaliseSpeechRequest({ ...payload, delivery }), { ...payload, delivery })
  assert.deepEqual(normaliseSpeechRequest({ ...payload, delivery: 'bright' }), { ...payload, delivery: 'happy' })
  for (const act of ACTS)
    assert.deepEqual(normaliseSpeechRequest({ ...payload, act }), { ...payload, act })
  assert.deepEqual(normaliseSpeechRequest({ ...payload, delivery: 'bright', act: 'laugh', expectedProvider: 'minimax' }),
    { ...payload, delivery: 'happy', act: 'laugh', expectedProvider: 'minimax' })
  assert.equal(Object.hasOwn(normaliseSpeechRequest(payload), 'act'), false, 'no act key unless one was sent')
  for (const act of [undefined, null, '', 'Laugh', 'cry', 'toString', '__proto__', ['laugh'], { act: 'laugh' }, 1])
    assert.throws(() => normaliseSpeechRequest({ ...payload, act }), { code: 'TTS_INVALID_REQUEST' }, String(act))
})

test('a self-hosted confirmation is accepted by name only and never carries a region', () => {
  assert.deepEqual(normaliseSpeechRequest({ ...payload, expectedProvider: 'local' }),
    { ...payload, expectedProvider: 'local' })
  for (const invalid of [{ ...payload, expectedProvider: 'Local' }, { ...payload, expectedProvider: 'local ' },
    { ...payload, expectedProvider: 'local', expectedRegion: 'cn' },
    { ...payload, expectedProvider: 'local', expectedRegion: 'global' }])
    assert.throws(() => normaliseSpeechRequest(invalid), { code: 'TTS_INVALID_REQUEST' })
})

test('success returns only the MP3 contract and reserves exactly twice the entire text length before fetch', async () => {
  const order = []
  const handler = create({
    budget: { reserve: async characters => { order.push(['reserve', characters]) } },
    fetchImpl: async (url, options) => {
      order.push(['fetch'])
      assert.equal(JSON.parse(options.body).text, payload.text)
      return audioResponse()
    },
  })
  const result = await run(handler)
  assert.equal(result.status, 200)
  assert.deepEqual(order, [['reserve', 2 * payload.text.length], ['fetch']])
  const data = JSON.parse(result.body)
  assert.deepEqual(Object.keys(data), ['audio', 'format', 'sampleRate', 'words'])
  assert.equal(data.format, 'mp3')
  assert.equal(data.sampleRate, 32_000)
  assert.deepEqual(data.words, [])
  assert.equal(result.headers['Cache-Control'], 'no-store')
})

test('an act becomes the MiniMax tag at the start and the reservation counts the text actually sent', async () => {
  const sent = []
  const reserved = []
  const handler = create({ budget: { reserve: async characters => { reserved.push(characters) } },
    fetchImpl: async (url, options) => { sent.push(JSON.parse(options.body)); return audioResponse() } })
  const text = '好呀<#0.5#>(Sighs)你看'
  const response = await run(handler, request(JSON.stringify({ text, delivery: 'surprised', act: 'laugh' })))
  assert.equal(response.status, 200)
  // LLM-written provider syntax is removed; only the server's own tag remains.
  assert.equal(sent[0].text, '(laughs)好呀你看')
  assert.equal(sent[0].voice_setting.emotion, 'surprised')
  assert.deepEqual(reserved, [2 * '(laughs)好呀你看'.length])
  // A pause is player silence: nothing reaches the provider.
  await run(handler, request(JSON.stringify({ ...payload, act: 'pause' })))
  assert.equal(sent[1].text, payload.text)
  assert.equal(reserved[1], 2 * payload.text.length)
})

test('a request of nothing but MiniMax syntax is refused before reserving', async () => {
  let calls = 0
  const handler = create({ budget: { reserve: async () => { calls++ } }, fetchImpl: async () => { calls++ } })
  for (const text of ['(laughs)', '<#0.5#>', ' (sighs) <#1#> ', '<<#1#>#0.5#>'])
    assert.equal((await run(handler, request(JSON.stringify({ ...payload, text, act: 'laugh' })))).status, 400, text)
  assert.equal(calls, 0)
})

test('actual optional usage is exposed but never changes or refunds the local protective reservation', async (context) => {
  const { path, budget } = await temporaryBudget(context, 2 * payload.text.length)
  let calls = 0
  const handler = create({ budget, fetchImpl: async () => {
    calls++
    return audioResponse({ usage_characters: 0, word_count: payload.text.length })
  } })
  const response = await run(handler)
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.body).usage, { billableCharacters: 0, textCharacters: payload.text.length })
  assert.equal(JSON.parse(await readFile(path, 'utf8')).reservedCharacters, 2 * payload.text.length)
  const capped = await run(handler)
  assert.equal(capped.status, 429)
  assert.equal(JSON.parse(capped.body).code, 'TTS_DAILY_LIMIT')
  assert.equal(calls, 1)
})

test('region consent defaults to mainland only and region mismatch cannot reserve or choose another endpoint', async () => {
  const international = readSpeechConfig({ MINIMAX_TTS_ENABLED: '1', MINIMAX_API_KEY: 'test-key-do-not-leak',
    MINIMAX_VOICE_ID: 'test-private-voice', MINIMAX_TTS_DAILY_CHAR_LIMIT: '1000', MINIMAX_TTS_REGION: 'global' })
  const order = []
  const handler = create({ config: international,
    budget: { reserve: async characters => order.push(['reserve', characters]) },
    fetchImpl: async (url, options) => {
      order.push(['fetch', url])
      assert.equal(options.redirect, 'error')
      return audioResponse({ usage_characters: 7 })
    } })
  assert.deepEqual(handler.health(),
    { configured: true, provider: 'minimax', model: 'speech-2.8-turbo', region: 'global' })
  for (const guarded of [payload, { ...payload, expectedProvider: 'minimax' },
    { ...payload, expectedProvider: 'minimax', expectedRegion: 'cn' }]) {
    const response = await run(handler, request(JSON.stringify(guarded)))
    assert.equal(response.status, 409)
    assert.equal(JSON.parse(response.body).code, 'TTS_PROVIDER_CHANGED')
  }
  const mainland = create({ budget: { reserve: async () => order.push(['wrong reserve']) },
    fetchImpl: async () => order.push(['wrong fetch']) })
  assert.deepEqual(mainland.health(),
    { configured: true, provider: 'minimax', model: 'speech-2.8-turbo', region: 'cn' })
  assert.equal((await run(mainland, request(JSON.stringify({ ...payload, expectedRegion: 'global' })))).status, 409)
  assert.deepEqual(order, [])
  const response = await run(handler,
    request(JSON.stringify({ ...payload, expectedProvider: 'minimax', expectedRegion: 'global' })))
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.body).usage, { billableCharacters: 7 })
  assert.deepEqual(order, [['reserve', 2 * payload.text.length], ['fetch', 'https://api.minimax.io/v1/t2a_v2']])
})

test('injected MiniMax host/unknown region fails health before spending instead of forwarding secrets', async () => {
  let calls = 0
  for (const invalid of [{ ...config, endpoint: 'https://attacker.invalid' }, { ...config, region: 'international' },
    { ...config, region: 'global' }, { ...config, region: null }]) {
    const handler = create({ config: invalid, budget: { reserve: async () => { calls++ } },
      fetchImpl: async () => { calls++ } })
    assert.equal(handler.health().configured, false)
    assert.equal((await run(handler)).status, 503)
  }
  assert.equal(calls, 0)
})

test('disabled configuration and invalid access code never reserve or call upstream', async () => {
  let calls = 0
  const options = { budget: { reserve: async () => { calls++ } }, fetchImpl: async () => { calls++ } }
  assert.equal((await run(create({ ...options, config: readMinimaxConfig({}) }))).status, 503)
  for (const invalidConfig of [readMinimaxConfig({ MINIMAX_TTS_ENABLED: '1', MINIMAX_API_KEY: 'bad中文',
    MINIMAX_VOICE_ID: 'voice', MINIMAX_TTS_DAILY_CHAR_LIMIT: '1000' }),
    readMinimaxConfig({ MINIMAX_TTS_ENABLED: '1', MINIMAX_API_KEY: 'valid-ascii-key',
      MINIMAX_VOICE_ID: 'voice\u0000', MINIMAX_TTS_DAILY_CHAR_LIMIT: '1000' })])
    assert.equal((await run(create({ ...options, config: invalidConfig }))).status, 503)
  assert.equal((await run(create(options), request(undefined, { 'x-demo-access-code': 'wrong-code' }))).status, 401)
  assert.equal(calls, 0)
})

test('bounded JSON, malformed UTF8/JSON and unknown fields fail before spending without echoing input', async () => {
  let calls = 0
  const handler = create({ budget: { reserve: async () => { calls++ } }, fetchImpl: async () => { calls++ } })
  for (const req of [request('not json test-key-do-not-leak'), request(JSON.stringify({ ...payload, text: 'a'.repeat(5_000) })),
    request(JSON.stringify({ ...payload, model: 'test-key-do-not-leak' })), request(undefined, { 'content-type': 'text/plain' }),
    request(Buffer.from([0xff, 0xfe]))]) {
    const response = await run(handler, req)
    assert.equal(response.status, 400)
    assert.equal(response.body.includes('test-key-do-not-leak'), false)
    assert.equal(response.body.includes(payload.text), false)
  }
  assert.equal(calls, 0)
})

test('TTS independent rate limiter supports sentence traffic, bounds IP state and rolls windows forward', () => {
  let now = 0
  const accept = createSpeechRateLimiter({ now: () => now })
  for (let i = 0; i < 30; i++)
    assert.equal(accept('one-ip'), true)
  assert.equal(accept('one-ip'), false)
  for (let minute = 1; minute < 6; minute++) {
    now = minute * 60_000
    for (let i = 0; i < 30; i++)
      assert.equal(accept('one-ip'), true)
  }
  now = 6 * 60_000
  assert.equal(accept('one-ip'), false)
  now = 10 * 60_000
  assert.equal(accept('one-ip'), true)
  for (let i = 0; i < 1_999; i++)
    assert.equal(accept(`ip-${i}`), true)
  assert.equal(accept('overflow-ip'), false)
  now += 10 * 60_000
  assert.equal(accept('overflow-ip'), true)
})

test('rate limit blocks excess requests before reserving', async () => {
  let calls = 0
  const handler = create({ budget: { reserve: async () => { calls++ } } })
  for (let i = 0; i < 30; i++)
    assert.equal((await run(handler)).status, 200)
  assert.equal((await run(handler)).status, 429)
  assert.equal(calls, 30)
})

test('global concurrency is capped at four and close cancels upstream/releases slots', async () => {
  const signals = []
  const handler = create({ fetchImpl: stalledFetch(signal => signals.push(signal)) })
  const responses = Array.from({ length: 4 }, () => new MockResponse())
  const pending = responses.map(response => handler.handle(request(), response))
  while (signals.length < 4)
    await setImmediate()
  assert.equal((await run(handler)).status, 503)
  responses[0].destroyed = true
  responses[0].emit('close')
  await pending[0]
  assert.equal(signals[0].aborted, true)
  assert.equal(responses[0].body, undefined)
  const replacement = new MockResponse()
  const resumed = handler.handle(request(), replacement)
  while (signals.length < 5)
    await setImmediate()
  for (const response of [...responses.slice(1), replacement]) {
    response.destroyed = true
    response.emit('close')
  }
  await Promise.all([...pending, resumed])
  assert.equal(signals.every(signal => signal.aborted), true)
})

test('cancel after fetch and failed provider calls retain durable reservations across restart', async (context) => {
  const { path, budget } = await temporaryBudget(context, 2 * payload.text.length)
  let start
  const started = new Promise(resolve => { start = resolve })
  const handler = create({ budget, fetchImpl: stalledFetch(start) })
  const response = new MockResponse()
  const pending = handler.handle(request(), response)
  const upstreamSignal = await started
  response.destroyed = true
  response.emit('close')
  await pending
  assert.equal(upstreamSignal.aborted, true)
  assert.equal(JSON.parse(await readFile(path, 'utf8')).reservedCharacters, 2 * payload.text.length)
  let calls = 0
  const restarted = create({ budget: createTtsBudget({ path, dailyLimit: 2 * payload.text.length,
    now: () => Date.parse('2026-10-01T14:00:00Z') }), fetchImpl: async () => { calls++ } })
  assert.equal((await run(restarted)).status, 429)
  assert.equal(calls, 0)

  const failure = await temporaryBudget(context)
  const failed = create({ budget: failure.budget, fetchImpl: async () => {
    throw new Error(`test-key-do-not-leak ${payload.text}`)
  } })
  assert.equal((await run(failed)).status, 502)
  assert.equal(JSON.parse(await readFile(failure.path, 'utf8')).reservedCharacters, 2 * payload.text.length)
})

test('a TTS ledger that met another process\'s lock reports unhealthy until restart', async (context) => {
  const { path, budget } = await temporaryBudget(context)
  let calls = 0
  const handler = create({ budget, fetchImpl: async () => { calls++; return audioResponse() } })
  assert.equal(handler.ledgerHealthy(), true)
  await mkdir(`${path}.lock`)
  assert.equal(JSON.parse((await run(handler)).body).code, 'TTS_BUDGET_UNAVAILABLE')
  await rmdir(`${path}.lock`)
  assert.equal(JSON.parse((await run(handler)).body).code, 'TTS_BUDGET_UNAVAILABLE')
  assert.equal(handler.ledgerHealthy(), false)
  assert.equal(calls, 0)
  // An injected budget without health reporting counts as healthy.
  assert.equal(create().ledgerHealthy(), true)
})

test('timeout aborts upstream; upstream and filesystem errors never echo secrets or submitted text', async () => {
  const timed = create({ timeoutMs: 10, fetchImpl: stalledFetch() })
  const timeoutResponse = await run(timed)
  assert.equal(timeoutResponse.status, 504)
  assert.equal(JSON.parse(timeoutResponse.body).code, 'TTS_TIMEOUT')
  for (const handler of [create({ fetchImpl: async () => { throw new Error(`test-key-do-not-leak ${payload.text}`) } }),
    create({ fetchImpl: async () => new Response(`test-key-do-not-leak ${payload.text}`, { status: 500 }) }),
    create({ budget: { reserve: async () => { throw new Error(`test-key-do-not-leak ${payload.text}`) } } })]) {
    const response = await run(handler)
    assert.equal(response.body.includes('test-key-do-not-leak'), false)
    assert.equal(response.body.includes('test-private-voice'), false)
    assert.equal(response.body.includes(payload.text), false)
  }
})

const elevenEnvironment = { TTS_PROVIDER: 'elevenlabs', ELEVENLABS_TTS_ENABLED: '1',
  ELEVENLABS_API_KEY: 'synthetic-eleven-key', ELEVENLABS_VOICE_ID: 'mockOnlyVoice01234567',
  ELEVENLABS_TTS_DAILY_CHAR_LIMIT: '1000', ELEVENLABS_TTS_MODEL: 'eleven_v4' }

function elevenAudioResponse() {
  // Structural protocol fixture, NOT decoded or real ElevenLabs speech.
  const mp3 = Buffer.alloc(417)
  Buffer.from([0xff, 0xfb, 0x90, 0xc0]).copy(mp3)
  return new Response(JSON.stringify({ audio_base64: mp3.toString('base64'),
    alignment: { characters: ['你'], character_start_times_seconds: [0], character_end_times_seconds: [0.02] },
    voice_segments: [{ voice_id: elevenEnvironment.ELEVENLABS_VOICE_ID, start_time_seconds: 0,
      end_time_seconds: 0.02, character_start_index: 0, character_end_index: 1, dialogue_input_index: 0 }] }),
  { headers: { 'content-type': 'application/json' } })
}

test('provider selection defaults compatibly and unknown selectors never fall back to paid MiniMax', async () => {
  assert.equal(readSpeechConfig({}).provider, 'minimax')
  assert.equal(readSpeechConfig(elevenEnvironment).provider, 'elevenlabs')
  for (const invalid of ['ElevenLabs', 'unknown', 'https://attacker.invalid']) {
    const selected = readSpeechConfig({ ...elevenEnvironment, TTS_PROVIDER: invalid,
      MINIMAX_TTS_ENABLED: '1', MINIMAX_API_KEY: 'also-configured', MINIMAX_VOICE_ID: 'voice',
      MINIMAX_TTS_DAILY_CHAR_LIMIT: '1000' })
    let calls = 0
    const handler = create({ config: selected, budget: { reserve: async () => { calls++ } },
      fetchImpl: async () => { calls++ } })
    assert.deepEqual(handler.health(), { configured: false, provider: 'unavailable', model: '' })
    assert.equal((await run(handler)).status, 503)
    assert.equal(calls, 0)
  }
})

test('Eleven handler reserves the actual trusted-prefix script before fetch and exposes no identity', async () => {
  const selected = readElevenLabsConfig(elevenEnvironment)
  const speechRequest = { text: '[shouts]你好', delivery: 'happy', act: 'laugh', expectedProvider: 'elevenlabs' }
  const upstreamText = buildElevenLabsRequest(selected, speechRequest).inputs[0].text
  assert.equal(upstreamText, '[happy] [laughs] ［shouts］你好')
  const order = []
  const handler = create({ config: selected,
    budget: { reserve: async characters => order.push(['reserve', characters]) },
    fetchImpl: async (url, options) => {
      order.push(['fetch'])
      assert.equal(JSON.parse(options.body).inputs[0].text, upstreamText)
      assert.equal(options.redirect, 'error')
      return elevenAudioResponse()
    } })
  assert.deepEqual(handler.health(), { configured: true, provider: 'elevenlabs', model: 'eleven_v4' })
  const response = await run(handler, request(JSON.stringify(speechRequest)))
  assert.equal(response.status, 200)
  assert.deepEqual(order, [['reserve', upstreamText.length], ['fetch']])
  const body = JSON.parse(response.body)
  assert.equal(body.sampleRate, 44100)
  assert.deepEqual(body.words, [])
  assert.deepEqual(body.characters, [{ text: '你', start: 0, end: 0.02 }])
  assert.equal(response.body.includes(elevenEnvironment.ELEVENLABS_VOICE_ID), false)
  assert.equal(response.body.includes(elevenEnvironment.ELEVENLABS_API_KEY), false)
})

test('old clients that still send bright to /api/speech get the happy voice', async () => {
  const sent = []
  const handler = create({ fetchImpl: async (url, options) => { sent.push(JSON.parse(options.body)); return audioResponse() } })
  assert.equal((await run(handler, request(JSON.stringify({ ...payload, delivery: 'bright' })))).status, 200)
  assert.equal(sent[0].voice_setting.emotion, 'happy')
  const eleven = readElevenLabsConfig(elevenEnvironment)
  const texts = []
  const elevenHandler = create({ config: eleven, fetchImpl: async (url, options) => {
    texts.push(JSON.parse(options.body).inputs[0].text)
    return elevenAudioResponse()
  } })
  const legacy = { text: '你好', delivery: 'bright', expectedProvider: 'elevenlabs' }
  assert.equal((await run(elevenHandler, request(JSON.stringify(legacy)))).status, 200)
  assert.deepEqual(texts, ['[happy] 你好'])
  // An unknown emotion is still refused before anything is reserved.
  assert.equal((await run(handler, request(JSON.stringify({ ...payload, delivery: 'angry' })))).status, 400)
  assert.equal(sent.length, 1)
})

test('default per-provider ledgers remain separate and switching back retains earlier reservations', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'airi-provider-ledger-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const selected = readSpeechConfig(elevenEnvironment)
  const one = { text: '你好', delivery: 'happy', expectedProvider: 'elevenlabs' }
  const reserved = buildElevenLabsRequest(selected, one).inputs[0].text.length
  const mini = createSpeechHandler({ rootDirectory: directory, config, fetchImpl: async () => audioResponse() })
  const eleven = createSpeechHandler({ rootDirectory: directory, config: { ...selected, dailyLimit: reserved },
    fetchImpl: async () => elevenAudioResponse() })
  assert.equal((await run(mini)).status, 200)
  assert.equal((await run(eleven, request(JSON.stringify(one)))).status, 200)
  assert.equal(JSON.parse(await readFile(join(directory, '.data', 'tts-budget.json'), 'utf8')).reservedCharacters,
    2 * payload.text.length)
  assert.equal(JSON.parse(await readFile(join(directory, '.data', 'tts-budget-elevenlabs.json'), 'utf8')).reservedCharacters,
    reserved)
  let calls = 0
  const restarted = createSpeechHandler({ rootDirectory: directory, config: { ...selected, dailyLimit: reserved },
    fetchImpl: async () => { calls++ } })
  assert.equal((await run(restarted, request(JSON.stringify(one)))).status, 429)
  assert.equal(calls, 0)
  assert.equal((await run(mini)).status, 200)
})

test('Eleven access, malformed request, unsupported model and disabled config do not reserve', async () => {
  let calls = 0
  const options = { config: readSpeechConfig(elevenEnvironment), budget: { reserve: async () => { calls++ } },
    fetchImpl: async () => { calls++ } }
  assert.equal((await run(create(options), request(undefined, { 'x-demo-access-code': 'wrong' }))).status, 401)
  assert.equal((await run(create(options), request(JSON.stringify({ ...payload, voice_id: 'override' })))).status, 400)
  for (const selected of [readSpeechConfig({ ...elevenEnvironment, ELEVENLABS_TTS_ENABLED: '0' }),
    { ...options.config, configured: true, model: 'eleven_v4_turbo' }])
    assert.equal((await run(create({ ...options, config: selected }))).status, 503)
  assert.equal(calls, 0)
})

test('provider guard rejects legacy/different-provider requests before spending, never selects another vendor', async () => {
  let calls = 0
  const options = { budget: { reserve: async () => { calls++ } }, fetchImpl: async () => { calls++ } }
  const eleven = create({ ...options, config: readSpeechConfig(elevenEnvironment) })
  for (const guarded of [payload, { ...payload, expectedProvider: 'minimax' }]) {
    const response = await run(eleven, request(JSON.stringify(guarded)))
    assert.equal(response.status, 409)
    assert.equal(JSON.parse(response.body).code, 'TTS_PROVIDER_CHANGED')
  }
  assert.equal((await run(create(options), request(JSON.stringify({ ...payload, expectedProvider: 'elevenlabs' })))).status, 409)
  for (const expectedProvider of ['unknown', null, '', 'eleven_v4', { provider: 'minimax' }])
    assert.equal((await run(eleven, request(JSON.stringify({ ...payload, expectedProvider })))).status, 400)
  assert.equal(calls, 0)
})

test('trusted synthesise() reserves the same 2x estimate, returns the route contract and shares the four-slot cap', async () => {
  const order = []
  const handler = create({
    budget: { reserve: async characters => { order.push(['reserve', characters]) } },
    fetchImpl: async () => { order.push(['fetch']); return audioResponse() },
  })
  const result = await handler.synthesise({ text: payload.text, delivery: 'soft' })
  assert.deepEqual(order, [['reserve', 2 * payload.text.length], ['fetch']])
  assert.deepEqual(Object.keys(result), ['audio', 'format', 'sampleRate', 'words'])

  const signals = []
  const stalled = create({ fetchImpl: stalledFetch(signal => signals.push(signal)) })
  const callers = Array.from({ length: 3 }, () => new AbortController())
  const pending = callers.map(caller => stalled.synthesise(payload, { signal: caller.signal }).catch(error => error))
  const response = new MockResponse()
  const routed = stalled.handle(request(), response)
  while (signals.length < 4)
    await setImmediate()
  await assert.rejects(stalled.synthesise(payload), { code: 'TTS_BUSY' }, 'the public route and the stage share one cap')
  assert.equal((await run(stalled)).status, 503)
  for (const caller of callers)
    caller.abort()
  response.destroyed = true
  response.emit('close')
  await Promise.all([...pending, routed])
  assert.equal(signals.every(signal => signal.aborted), true, 'a caller abort cancels upstream')
})

test('trusted synthesise() forwards the act and canonicalises the delivery; an absent act sends no tag', async () => {
  const sent = []
  const reserved = []
  const handler = create({ budget: { reserve: async characters => { reserved.push(characters) } },
    fetchImpl: async (url, options) => { sent.push(JSON.parse(options.body)); return audioResponse() } })
  await handler.synthesise({ text: payload.text, delivery: 'sad', act: 'sigh' })
  await handler.synthesise({ text: payload.text, delivery: 'bright', act: undefined })
  await handler.synthesise({ text: payload.text, delivery: 'shy' })
  assert.deepEqual(sent.map(body => [body.text, body.voice_setting.emotion, body.voice_setting.speed]), [
    [`(sighs)${payload.text}`, 'sad', 0.96], [payload.text, 'happy', 1], [payload.text, undefined, 0.97]])
  assert.deepEqual(reserved, [2 * (payload.text.length + 7), 2 * payload.text.length, 2 * payload.text.length])
  for (const act of [null, 'cry', 'Laugh'])
    await assert.rejects(handler.synthesise({ text: payload.text, delivery: 'neutral', act }), { code: 'TTS_INVALID_REQUEST' })
  assert.equal(sent.length, 3)
})

test('trusted synthesise() never reserves when disabled or invalid, and maps timeouts to 504', async () => {
  let reserved = 0
  const budget = { reserve: async () => { reserved++ } }
  const disabled = create({ budget, config: readMinimaxConfig({ MINIMAX_TTS_ENABLED: '0' }) })
  await assert.rejects(disabled.synthesise(payload), { code: 'TTS_NOT_CONFIGURED' })
  const enabled = create({ budget })
  for (const invalid of [{ text: '', delivery: 'neutral' }, { text: 'x', delivery: 'angry' }, { text: 'a'.repeat(361), delivery: 'soft' }])
    await assert.rejects(enabled.synthesise(invalid), { code: 'TTS_INVALID_REQUEST' })
  assert.equal(reserved, 0)

  const timed = create({ timeoutMs: 10, fetchImpl: stalledFetch() })
  const error = await timed.synthesise(payload).catch(caught => caught)
  assert.equal(error.code, 'TTS_TIMEOUT')
  assert.deepEqual(speechErrorResponse(error), { status: 504, code: 'TTS_TIMEOUT', message: '云端语音合成超时，请稍后再试。' })
  const caller = new AbortController()
  const cancelled = create({ fetchImpl: stalledFetch(() => caller.abort()) })
  const abort = await cancelled.synthesise(payload, { signal: caller.signal }).catch(caught => caught)
  assert.notEqual(abort.code, 'TTS_TIMEOUT', 'a caller cancellation is not reported as a provider timeout')
})

test('speechErrorResponse keeps the public status table and never exposes unknown messages', () => {
  assert.deepEqual(speechErrorResponse(new Error('test-key-do-not-leak')),
    { status: 502, code: 'TTS_UPSTREAM_FAILED', message: '云端语音服务请求失败。' })
  assert.equal(speechErrorResponse(new Error('x'), { timedOut: true }).status, 504)
  const table = { TTS_INVALID_REQUEST: 400, TTS_PROVIDER_CHANGED: 409, TTS_DAILY_LIMIT: 429,
    TTS_BUDGET_UNAVAILABLE: 503, TTS_UPSTREAM_INVALID: 502, TTS_UPSTREAM_FAILED: 502, TTS_UPSTREAM_RATE_LIMITED: 429 }
  for (const [code, status] of Object.entries(table)) {
    const error = Object.assign(new Error('secret'), { code })
    assert.equal(speechErrorResponse(error).code, 'TTS_UPSTREAM_FAILED', 'a plain Error with a code is not trusted')
    assert.equal(speechErrorResponse(new SpeechProviderError(code)).status, status, code)
  }
})

function rateLimitedResponse() {
  return new Response(JSON.stringify({ base_resp: { status_code: 1002, status_msg: 'rate limit exceeded(RPM) test-key-do-not-leak' } }),
    { headers: { 'content-type': 'application/json' } })
}

test('a MiniMax 1002 is a 429 with a stable code, then visitors are held off for the backoff without spending', async () => {
  let clock = Date.parse('2026-10-21T12:00:00Z')
  let fetches = 0
  let reserved = 0
  let limited = true
  const handler = create({ now: () => clock, budget: { reserve: async () => { reserved++ } },
    fetchImpl: async () => { fetches++; return limited ? rateLimitedResponse() : audioResponse() } })

  const refused = await run(handler)
  assert.equal(refused.status, 429)
  assert.deepEqual(JSON.parse(refused.body), { code: 'TTS_UPSTREAM_RATE_LIMITED', message: '云端语音服务每分钟请求数已达上限，请稍后再试。' })
  assert.doesNotMatch(refused.body, /1002|RPM|test-key|private/)
  assert.deepEqual([fetches, reserved], [1, 1])

  limited = false
  clock += UPSTREAM_BACKOFF_MS - 1
  const held = await run(handler)
  assert.equal(held.status, 429)
  assert.equal(JSON.parse(held.body).code, 'TTS_UPSTREAM_RATE_LIMITED')
  assert.deepEqual([fetches, reserved], [1, 1], 'held off before any reservation or request')
  assert.equal((await run(handler, request('{}', { 'x-demo-access-code': 'wrong' }))).status, 401, 'the access code is still checked first')

  clock += 1
  assert.equal((await run(handler)).status, 200)
  assert.deepEqual([fetches, reserved], [2, 2])
})

test('a refusal on the trusted path holds visitors off too, but the stage itself is never held off here', async () => {
  let clock = Date.parse('2026-10-21T12:00:00Z')
  const fetched = []
  let limited = true
  const handler = create({ now: () => clock,
    fetchImpl: async () => { fetched.push(limited); return limited ? rateLimitedResponse() : audioResponse() } })
  const error = await handler.synthesise(payload).catch(caught => caught)
  assert.equal(error.code, 'TTS_UPSTREAM_RATE_LIMITED')
  assert.doesNotMatch(error.message, /RPM|test-key/)
  limited = false
  assert.equal((await run(handler)).status, 429, 'the web chat waits')
  assert.deepEqual(Object.keys(await handler.synthesise(payload)), ['audio', 'format', 'sampleRate', 'words'],
    'the live stage decides for itself whether to wait (server/live/runtime.mjs)')
  assert.deepEqual(fetched, [true, false])
  clock += UPSTREAM_BACKOFF_MS
  assert.equal((await run(handler)).status, 200)
})

test('other upstream failures never hold visitors off', async () => {
  let fetches = 0
  const handler = create({ fetchImpl: async () => {
    fetches++
    return new Response(JSON.stringify({ base_resp: { status_code: 1039 } }), { headers: { 'content-type': 'application/json' } })
  } })
  for (let index = 0; index < 3; index++)
    assert.equal((await run(handler)).status, 502)
  assert.equal(fetches, 3)
})
