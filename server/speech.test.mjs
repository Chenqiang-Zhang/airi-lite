import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'

import { readMinimaxConfig } from './minimax.mjs'
import { createSpeechHandler, createSpeechRateLimiter, normaliseSpeechRequest } from './speech.mjs'
import { createTtsBudget } from './tts-budget.mjs'

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
function audioResponse() {
  // Only a structural fake frame; this is not real/provider/decoded audio.
  const mp3 = Buffer.alloc(576)
  Buffer.from([0xff, 0xfb, 0x98, 0xc0]).copy(mp3)
  const chunk = { base_resp: { status_code: 0 }, data: { status: 2, audio: mp3.toString('hex') },
    extra_info: { audio_format: 'mp3', audio_sample_rate: 32_000, audio_channel: 1, audio_size: mp3.length, audio_length: 36 } }
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
  assert.equal(normaliseSpeechRequest({ text: '😀'.repeat(180), delivery: 'bright' }).text.length, 360)
  for (const invalid of [null, [], {}, { ...payload, text: '' }, { ...payload, text: '  ' },
    { ...payload, text: 'a'.repeat(361) }, { ...payload, text: '😀'.repeat(181) }, { ...payload, text: '\u0000' },
    { ...payload, text: '\ud800' }, { ...payload, delivery: 'angry' }, { ...payload, delivery: null },
    { ...payload, voice_id: 'attacker' }, { ...payload, model: 'attacker' }, { ...payload, baseUrl: 'http://127.0.0.1' }])
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
