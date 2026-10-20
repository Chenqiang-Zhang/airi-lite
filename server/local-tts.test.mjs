import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createMockLocalTts, sineWav } from '../scripts/mock-local-tts.mjs'
import { createRequestHandler } from './app.mjs'
import { buildLocalRequest, checkLocalMp3, DEFAULT_LOCAL_DAILY_CHAR_LIMIT, isPrivateTtsHost, readLocalTtsConfig,
  readLocalWav, synthesiseLocal } from './local-tts.mjs'
import { SpeechProviderError } from './speech-error.mjs'
import { readSpeechConfig, resolveSpeechProvider } from './speech-provider.mjs'
import { createSpeechHandler } from './speech.mjs'

// Synthetic values only: no real engine, key or voice is involved anywhere.
const environment = Object.freeze({ LOCAL_TTS_ENABLED: '1', LOCAL_TTS_URL: 'http://127.0.0.1:9880',
  LOCAL_TTS_MODEL: 'cosyvoice2', LOCAL_TTS_VOICE: '中文女' })
const config = readLocalTtsConfig(environment)
const speech = { text: '大家好，欢迎来到直播间。', delivery: 'neutral' }
const invalid = error => error instanceof SpeechProviderError && error.code === 'TTS_UPSTREAM_INVALID'
const failed = error => error instanceof SpeechProviderError && error.code === 'TTS_UPSTREAM_FAILED'

function wavResponse(wav = sineWav(), headers = {}) {
  return new Response(wav, { headers: { 'content-type': 'audio/wav', ...headers } })
}

// Hand-built RIFF files for header edge cases; samples are never decoded here.
function wav({ format = 1, channels = 1, sampleRate = 24_000, bits = 16, seconds = 0.1, dataSize, riffSize,
  extensible = false, before = [] } = {}) {
  const blockAlign = channels * bits / 8
  const bytes = Math.round(sampleRate * seconds) * blockAlign
  const fmt = Buffer.alloc(extensible ? 40 : 16)
  fmt.writeUInt16LE(extensible ? 0xfffe : format, 0)
  fmt.writeUInt16LE(channels, 2)
  fmt.writeUInt32LE(sampleRate, 4)
  fmt.writeUInt32LE(sampleRate * blockAlign, 8)
  fmt.writeUInt16LE(blockAlign, 12)
  fmt.writeUInt16LE(bits, 14)
  if (extensible) {
    fmt.writeUInt16LE(22, 16)
    fmt.writeUInt16LE(bits, 18)
    fmt.writeUInt32LE(format, 24)
    Buffer.from('00001000800000aa00389b71', 'hex').copy(fmt, 28)
  }
  const chunk = (id, body, size = body.length) => {
    const header = Buffer.alloc(8)
    header.write(id, 0, 'latin1')
    header.writeUInt32LE(size, 4)
    return Buffer.concat([header, body, body.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)])
  }
  const samples = Buffer.alloc(bytes, 0x11)
  const body = Buffer.concat([Buffer.from('WAVE', 'latin1'), ...before, chunk('fmt ', fmt),
    chunk('data', samples, dataSize ?? bytes)])
  const header = Buffer.alloc(8)
  header.write('RIFF', 0, 'latin1')
  header.writeUInt32LE(riffSize ?? body.length, 4)
  return Buffer.concat([header, body])
}

// Structural Layer III frames with zeroed payloads; not decodable speech.
function mp3({ version = 2, rateIndex = 1, bitrateIndex = 8, frames = 4, id3 = false } = {}) {
  const rates = { 3: [44_100, 48_000, 32_000], 2: [22_050, 24_000, 16_000], 0: [11_025, 12_000, 8_000] }
  const v1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
  const v2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
  const rate = rates[version][rateIndex]
  const length = Math.floor((version === 3 ? 144_000 : 72_000) * (version === 3 ? v1 : v2)[bitrateIndex] / rate)
  const frame = Buffer.alloc(length)
  frame[0] = 0xff
  frame[1] = 0xe0 | version << 3 | 1 << 1 | 1
  frame[2] = bitrateIndex << 4 | rateIndex << 2
  frame[3] = 0xc0
  const tag = id3 ? [Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 2, 0, 0])] : []
  return Buffer.concat([...tag, ...Array.from({ length: frames }, () => frame)])
}

test('a complete loopback/private configuration is accepted with safe defaults', () => {
  assert.deepEqual({ ...config }, { provider: 'local', endpoint: 'http://127.0.0.1:9880/v1/audio/speech',
    model: 'cosyvoice2', voice: '中文女', format: 'wav', apiKey: '', sampleRate: null,
    dailyLimit: DEFAULT_LOCAL_DAILY_CHAR_LIMIT, instructions: false, configured: true })
  assert.ok(Object.isFrozen(config))
  const full = readLocalTtsConfig({ ...environment, LOCAL_TTS_URL: ' https://192.168.1.20:50000/cosy/ ',
    LOCAL_TTS_MODEL: ' FunAudioLLM/CosyVoice2-0.5B ', LOCAL_TTS_FORMAT: 'mp3', LOCAL_TTS_SAMPLE_RATE: '24000',
    LOCAL_TTS_API_KEY: 'local-dev-key', LOCAL_TTS_DAILY_CHAR_LIMIT: '1200', LOCAL_TTS_INSTRUCTIONS: '1' })
  assert.equal(full.configured, true)
  assert.equal(full.endpoint, 'https://192.168.1.20:50000/cosy/v1/audio/speech')
  assert.equal(full.model, 'FunAudioLLM/CosyVoice2-0.5B')
  assert.deepEqual([full.format, full.sampleRate, full.apiKey, full.dailyLimit, full.instructions],
    ['mp3', 24_000, 'local-dev-key', 1200, true])
  // WAV reads the rate from its own header; a valid override is harmless.
  assert.equal(readLocalTtsConfig({ ...environment, LOCAL_TTS_SAMPLE_RATE: '22050' }).configured, true)
})

test('loopback, RFC1918 and link-local hosts pass; public, named and disguised hosts fail closed', () => {
  for (const url of ['http://127.0.0.1:9880', 'http://127.8.9.10', 'http://localhost:8000', 'https://10.0.0.5',
    'http://172.16.0.1', 'http://172.31.255.255', 'http://192.168.0.2', 'http://169.254.10.1', 'http://[::1]:8000',
    'http://[fe80::1]', 'http://[febf::1]', 'http://0x7f.1', 'http://2130706433'])
    assert.equal(readLocalTtsConfig({ ...environment, LOCAL_TTS_URL: url }).configured, true, url)
  for (const url of ['http://8.8.8.8:8000', 'http://example.com', 'http://172.32.0.1', 'http://172.15.255.255',
    'http://192.169.0.1', 'http://11.0.0.1', 'http://169.255.0.1', 'http://0.0.0.0', 'http://[2001:db8::1]',
    'http://[fc00::1]', 'http://[fec0::1]', 'http://[::ffff:127.0.0.1]', 'http://[::]', 'http://0x08080808',
    'http://localhost.example.com', 'http://127.0.0.1.nip.io', 'http://gpu-box.local:9880',
    'http://user:pw@127.0.0.1:9880', 'http://:pw@127.0.0.1', 'http://127.0.0.1:9880/?voice=x',
    'http://127.0.0.1:9880/#x', 'http://127.0.0.1:9880?', 'ftp://127.0.0.1', 'file:///tmp/tts', 'ws://127.0.0.1',
    '127.0.0.1:9880', '', '   ', `http://127.0.0.1/${'a'.repeat(2_100)}`])
    assert.equal(readLocalTtsConfig({ ...environment, LOCAL_TTS_URL: url }).configured, false, url)
  assert.equal(isPrivateTtsHost('[fe80::1]'), true)
  assert.equal(isPrivateTtsHost('[::ffff:a00:1]'), false)
})

test('missing activation fields, bad format, rate, key or limit leave the provider unconfigured', () => {
  for (const missing of ['LOCAL_TTS_ENABLED', 'LOCAL_TTS_URL', 'LOCAL_TTS_MODEL', 'LOCAL_TTS_VOICE'])
    assert.equal(readLocalTtsConfig({ ...environment, [missing]: undefined }).configured, false, missing)
  for (const [key, value] of [['LOCAL_TTS_ENABLED', 'true'], ['LOCAL_TTS_ENABLED', '0'],
    ['LOCAL_TTS_FORMAT', 'ogg'], ['LOCAL_TTS_FORMAT', 'pcm'], ['LOCAL_TTS_FORMAT', 'WAV'], ['LOCAL_TTS_FORMAT', 'opus'],
    ['LOCAL_TTS_SAMPLE_RATE', '7999'], ['LOCAL_TTS_SAMPLE_RATE', '96001'], ['LOCAL_TTS_SAMPLE_RATE', '24000.0'],
    ['LOCAL_TTS_SAMPLE_RATE', 'auto'], ['LOCAL_TTS_API_KEY', 'has space'], ['LOCAL_TTS_API_KEY', ' key'],
    ['LOCAL_TTS_API_KEY', '密钥'], ['LOCAL_TTS_DAILY_CHAR_LIMIT', '0'], ['LOCAL_TTS_DAILY_CHAR_LIMIT', '-5'],
    ['LOCAL_TTS_DAILY_CHAR_LIMIT', 'many'], ['LOCAL_TTS_DAILY_CHAR_LIMIT', '9'.repeat(20)],
    ['LOCAL_TTS_MODEL', '../model'], ['LOCAL_TTS_MODEL', 'a b'], ['LOCAL_TTS_MODEL', 'm'.repeat(129)],
    ['LOCAL_TTS_VOICE', 'a\u0000b'], ['LOCAL_TTS_VOICE', 'v'.repeat(257)], ['LOCAL_TTS_VOICE', '\ud800']])
    assert.equal(readLocalTtsConfig({ ...environment, [key]: value }).configured, false, `${key}=${value}`)
  // MP3 has no header rate the server can trust without the operator's value.
  assert.equal(readLocalTtsConfig({ ...environment, LOCAL_TTS_FORMAT: 'mp3' }).configured, false)
})

test('TTS_PROVIDER=local selects only this provider, with its own ledger and identity-free health', () => {
  const selected = readSpeechConfig({ ...environment, TTS_PROVIDER: 'local' })
  assert.equal(selected.provider, 'local')
  const provider = resolveSpeechProvider(selected)
  assert.deepEqual([provider.configured, provider.provider, provider.model, provider.ledgerFilename],
    [true, 'local', 'cosyvoice2', 'tts-budget-local.json'])
  assert.equal(provider.estimateReservation(selected, speech), speech.text.length)
  assert.deepEqual(createSpeechHandler({ rootDirectory: '/unused', config: selected, budget: {} }).health(),
    { configured: true, provider: 'local', model: 'cosyvoice2' })
  // Without the explicit selector, a ready local engine never activates.
  assert.equal(readSpeechConfig(environment).provider, 'minimax')
  assert.equal(readSpeechConfig({ ...environment, TTS_PROVIDER: 'Local' }).provider, 'unavailable')
  // Chosen but not usable yet: still named local, never able to synthesise.
  for (const resolved of [resolveSpeechProvider({ ...selected, model: '' }), resolveSpeechProvider(readSpeechConfig({ TTS_PROVIDER: 'local' }))]) {
    assert.equal(resolved.provider, 'local')
    assert.equal(resolved.configured, false)
    assert.equal(resolved.synthesise, undefined)
    assert.equal(resolved.ledgerFilename, 'tts-budget-local.json')
  }
})

test('the request body is OpenAI-compatible and maps delivery through the one table', () => {
  assert.deepEqual(buildLocalRequest(config, speech),
    { model: 'cosyvoice2', input: speech.text, voice: '中文女', response_format: 'wav', speed: 1 })
  assert.equal(buildLocalRequest(config, { ...speech, delivery: 'soft' }).speed, 0.96)
  for (const delivery of ['neutral', 'soft', 'bright', 'curious'])
    assert.equal('instructions' in buildLocalRequest(config, { ...speech, delivery }), false)
  const instructed = { ...config, instructions: true }
  assert.equal('instructions' in buildLocalRequest(instructed, speech), false)
  for (const delivery of ['soft', 'bright', 'curious'])
    assert.match(buildLocalRequest(instructed, { ...speech, delivery }).instructions, /^用.+语气说。$/)
  for (const bad of [{ ...speech, text: '' }, { ...speech, text: '  ' }, { ...speech, text: 'a'.repeat(361) },
    { ...speech, text: '\ud800' }, { ...speech, text: 42 }, { ...speech, delivery: 'angry' },
    { ...speech, delivery: 'toString' }, { ...speech, delivery: undefined }])
    assert.throws(() => buildLocalRequest(config, bad), { code: 'TTS_INVALID_REQUEST' })
})

test('synthesis posts once to the pinned endpoint and returns the shared clip shape', async () => {
  const calls = []
  const audio = sineWav({ sampleRate: 22_050, seconds: 0.25 })
  const result = await synthesiseLocal({ ...config, apiKey: 'local-dev-key' }, { ...speech, delivery: 'bright' }, {
    fetchImpl: async (...args) => { calls.push(args); return wavResponse(audio) },
  })
  assert.equal(calls.length, 1)
  const [url, init] = calls[0]
  assert.equal(url, 'http://127.0.0.1:9880/v1/audio/speech')
  assert.equal(init.method, 'POST')
  assert.equal(init.redirect, 'error')
  assert.deepEqual(init.headers, { 'Content-Type': 'application/json', Accept: 'audio/wav',
    Authorization: 'Bearer local-dev-key' })
  assert.deepEqual(JSON.parse(init.body),
    { model: 'cosyvoice2', input: speech.text, voice: '中文女', response_format: 'wav', speed: 1 })
  // wordAlignmentAvailable is true-only on the wire; false would be rejected.
  assert.deepEqual(result, { audio: audio.toString('base64'), format: 'wav', sampleRate: 22_050, words: [] })
  await synthesiseLocal(config, speech, { fetchImpl: async (_url, options) => {
    assert.equal('Authorization' in options.headers, false)
    return wavResponse()
  } })
})

test('WAV rate comes from the RIFF header; placeholder sizes are patched and bad headers rejected', () => {
  for (const sampleRate of [8_000, 16_000, 22_050, 24_000, 44_100, 48_000, 96_000]) {
    const bytes = wav({ sampleRate })
    assert.deepEqual(readLocalWav(bytes), { audio: bytes, sampleRate })
  }
  for (const options of [{ bits: 8 }, { bits: 24 }, { bits: 32 }, { format: 3, bits: 32 }, { channels: 2 },
    { extensible: true }, { extensible: true, format: 3, bits: 32 }, { seconds: 30 },
    { before: [Buffer.from('LIST\u0003\u0000\u0000\u0000abc\u0000', 'latin1')] }])
    assert.equal(readLocalWav(wav(options)).sampleRate, 24_000, JSON.stringify(options))

  for (const placeholder of [0, 0xffff_ffff]) {
    const streamed = wav({ dataSize: placeholder, riffSize: placeholder })
    const { audio } = readLocalWav(Buffer.concat([streamed, Buffer.alloc(1)]))
    assert.equal(audio.readUInt32LE(4), audio.length - 8)
    assert.equal(audio.readUInt32LE(40), audio.length - 44)
    assert.equal((audio.length - 44) % 2, 0, 'a trailing partial sample is dropped')
  }
  const riffOnly = readLocalWav(wav({ riffSize: 0xffff_ffff })).audio
  assert.equal(riffOnly.readUInt32LE(4), riffOnly.length - 8)

  const truncated = wav()
  for (const bytes of [Buffer.alloc(0), Buffer.from('not a wav file at all, just some text bytes!!'),
    Buffer.concat([Buffer.from('RIFX'), wav().subarray(4)]), truncated.subarray(0, truncated.length - 10),
    wav({ seconds: 30.01 }), wav({ channels: 3 }), wav({ bits: 12 }), wav({ format: 3, bits: 16 }),
    wav({ format: 2 }), wav({ sampleRate: 7_999 }), wav({ sampleRate: 96_001 }), wav({ seconds: 0 }),
    wav({ extensible: true, format: 2 }), wav().subarray(0, 36)])
    assert.throws(() => readLocalWav(bytes), invalid)
  const badAlign = wav()
  badAlign.writeUInt16LE(4, 32)
  assert.throws(() => readLocalWav(badAlign), invalid)
  const dataFirst = Buffer.from(wav())
  dataFirst.write('junk', 12, 'latin1') // fmt hidden: data arrives with no format
  assert.throws(() => readLocalWav(dataFirst), invalid)
})

test('MP3 frames must match the configured rate and stay within 30 seconds', () => {
  assert.equal(checkLocalMp3(mp3(), 24_000), 24_000)
  assert.equal(checkLocalMp3(mp3({ id3: true }), 24_000), 24_000)
  assert.equal(checkLocalMp3(mp3({ version: 3, rateIndex: 0, bitrateIndex: 9 }), 44_100), 44_100)
  assert.equal(checkLocalMp3(mp3({ version: 0, rateIndex: 2, bitrateIndex: 2 }), 8_000), 8_000)
  for (const [bytes, rate] of [[mp3(), 22_050], [mp3({ version: 3, rateIndex: 0 }), 48_000],
    [Buffer.from('ID3'), 24_000], [Buffer.from('not mp3'), 24_000], [mp3().subarray(0, 50), 24_000],
    [mp3({ frames: 0 }), 24_000], [mp3({ frames: 1_300 }), 24_000]])
    assert.throws(() => checkLocalMp3(bytes, rate), invalid)
  for (const patch of [bytes => (bytes[2] |= 0xf0), bytes => (bytes[2] &= 0x0f), bytes => (bytes[1] = 0xf5),
    bytes => (bytes[1] = 0xeb)]) {
    const bytes = mp3()
    patch(bytes) // bad bitrate, free format, Layer II and reserved MPEG version
    assert.throws(() => checkLocalMp3(bytes, 24_000), invalid)
  }
})

test('mp3 output passes through with the configured rate', async () => {
  const selected = readLocalTtsConfig({ ...environment, LOCAL_TTS_FORMAT: 'mp3', LOCAL_TTS_SAMPLE_RATE: '24000' })
  const bytes = mp3()
  const result = await synthesiseLocal(selected, speech, { fetchImpl: async (_url, init) => {
    assert.equal(init.headers.Accept, 'audio/mpeg')
    assert.equal(JSON.parse(init.body).response_format, 'mp3')
    return new Response(bytes, { headers: { 'content-type': 'audio/mpeg' } })
  } })
  assert.deepEqual(result, { audio: bytes.toString('base64'), format: 'mp3', sampleRate: 24_000, words: [] })
})

test('upstream failures map to stable codes without leaking engine bodies', async () => {
  const leak = 'local-dev-key 中文女 private engine trace'
  await assert.rejects(synthesiseLocal(config, speech, { fetchImpl: async () => { throw new Error(leak) } }), failed)
  for (const status of [400, 401, 404, 422, 500, 503]) {
    let cancelled = false
    const body = new ReadableStream({ cancel() { cancelled = true } })
    await assert.rejects(synthesiseLocal(config, speech, {
      fetchImpl: async () => new Response(body, { status, headers: { 'content-type': 'application/json' } }),
    }), failed)
    assert.equal(cancelled, true, `status ${status} body is cancelled`)
  }
  for (const response of [
    new Response(JSON.stringify({ error: leak }), { headers: { 'content-type': 'application/json' } }),
    new Response(leak, { headers: { 'content-type': 'text/plain' } }),
    new Response(sineWav()),
    wavResponse(sineWav(), { 'content-length': String(2 * 1_024 * 1_024 + 1) }),
    wavResponse(sineWav(), { 'content-length': 'many' }),
    wavResponse(Buffer.alloc(0)),
    wavResponse(Buffer.from(leak)),
    new Response(new ReadableStream({ start(controller) {
      for (let index = 0; index < 3; index++)
        controller.enqueue(new Uint8Array(1_024 * 1_024))
      controller.close()
    } }), { headers: { 'content-type': 'application/octet-stream' } }),
    new Response(new ReadableStream({ start(controller) { controller.error(new Error(leak)) } }),
      { headers: { 'content-type': 'audio/wav' } }),
  ]) {
    await assert.rejects(synthesiseLocal(config, speech, { fetchImpl: async () => response }), (error) => {
      assert.ok(invalid(error), error.code)
      assert.equal(error.message.includes('local-dev-key'), false)
      return true
    })
  }
  // A mislabelled but structurally sound body is accepted on its bytes.
  assert.equal((await synthesiseLocal(config, speech, {
    fetchImpl: async () => new Response(sineWav(), { headers: { 'content-type': 'application/octet-stream' } }),
  })).format, 'wav')
})

test('unconfigured or tampered configs never reach fetch; aborts surface as aborts', async () => {
  let calls = 0
  const fetchImpl = async () => { calls++; return wavResponse() }
  for (const tampered of [readLocalTtsConfig({ ...environment, LOCAL_TTS_ENABLED: '0' }),
    { ...config, endpoint: 'https://api.example.com/v1/audio/speech' },
    { ...config, endpoint: 'http://127.0.0.1:9880/other' }, { ...config, endpoint: 'http://user:pw@127.0.0.1/v1/audio/speech' },
    { ...config, provider: 'minimax' }, { ...config, format: 'ogg' }, { ...config, voice: '' },
    { ...config, dailyLimit: 0 }, { ...config, configured: 'true' }, null, undefined])
    await assert.rejects(synthesiseLocal(tampered, speech, { fetchImpl }), { code: 'TTS_NOT_CONFIGURED' })
  assert.equal(calls, 0)

  const before = new AbortController()
  before.abort(new Error('cancelled before'))
  await assert.rejects(synthesiseLocal(config, speech, { fetchImpl, signal: before.signal }), /cancelled before/)
  assert.equal(calls, 0)

  const during = new AbortController()
  let cancelled = false
  const stalled = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(8)) },
    cancel() { cancelled = true } })
  const pending = synthesiseLocal(config, speech, { signal: during.signal,
    fetchImpl: async () => new Response(stalled, { headers: { 'content-type': 'audio/wav' } }) })
  setImmediate(() => during.abort(new Error('cancelled during')))
  await assert.rejects(pending, /cancelled during/)
  assert.equal(cancelled, true)
})

async function mockEngine(context, options = {}) {
  const requests = []
  const server = createMockLocalTts({ ...options, onRequest: (body, headers) => requests.push({ body, headers }) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  context.after(() => new Promise(resolve => server.close(resolve)))
  return { url: `http://127.0.0.1:${server.address().port}`, requests }
}

async function temporaryRoot(context) {
  const directory = await mkdtemp(join(tmpdir(), 'airi-local-tts-test-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test('the trusted live-stage path synthesises through the mock engine and keeps a local ledger', async (context) => {
  const engine = await mockEngine(context, { apiKey: 'mock-key' })
  const root = await temporaryRoot(context)
  const selected = readSpeechConfig({ ...environment, TTS_PROVIDER: 'local', LOCAL_TTS_URL: engine.url,
    LOCAL_TTS_API_KEY: 'mock-key', LOCAL_TTS_DAILY_CHAR_LIMIT: '100' })
  const handler = createSpeechHandler({ rootDirectory: root, config: selected })
  const result = await handler.synthesise({ text: speech.text, delivery: 'soft' })
  assert.deepEqual(Object.keys(result), ['audio', 'format', 'sampleRate', 'words'])
  assert.deepEqual([result.format, result.sampleRate, result.words], ['wav', 24_000, []])
  assert.equal(readLocalWav(Buffer.from(result.audio, 'base64')).sampleRate, 24_000)
  assert.deepEqual(engine.requests.map(({ body }) => body),
    [{ model: 'cosyvoice2', input: speech.text, voice: '中文女', response_format: 'wav', speed: 0.96 }])
  assert.equal(engine.requests[0].headers.authorization, 'Bearer mock-key')
  const ledger = JSON.parse(await readFile(join(root, '.data', 'tts-budget-local.json'), 'utf8'))
  assert.equal(ledger.reservedCharacters, speech.text.length)
  // The runaway guard still stops a request past the daily limit, before fetch.
  await assert.rejects(handler.synthesise({ text: 'a'.repeat(100), delivery: 'neutral' }), { code: 'TTS_DAILY_LIMIT' })
  assert.equal(engine.requests.length, 1)
})

test('POST /api/speech returns decodable WAV for the confirmed local provider only', async (context) => {
  const engine = await mockEngine(context)
  const root = await temporaryRoot(context)
  const server = createServer(createRequestHandler({ root, fetchImpl: async () => assert.fail('no DeepSeek call'),
    env: { ...environment, TTS_PROVIDER: 'local', LOCAL_TTS_URL: engine.url, AIRI_DEMO_ACCESS_CODE: 'local-test-code-0123' } }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  context.after(() => {
    server.closeAllConnections()
    return new Promise(resolve => server.close(resolve))
  })
  const base = `http://127.0.0.1:${server.address().port}/airi`
  const health = await (await fetch(`${base}/api/health`)).json()
  assert.deepEqual(health.speech, { configured: true, provider: 'local', model: 'cosyvoice2' })
  const post = body => fetch(`${base}/api/speech`, { method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'X-Demo-Access-Code': 'local-test-code-0123' } })

  const response = await post({ ...speech, expectedProvider: 'local' })
  assert.equal(response.status, 200)
  const clip = await response.json()
  assert.deepEqual([clip.format, clip.sampleRate, clip.words], ['wav', 24_000, []])
  const audio = Buffer.from(clip.audio, 'base64')
  assert.equal(audio.toString('latin1', 0, 4), 'RIFF')
  assert.ok(audio.length > 44 && audio.length < 2 * 1_024 * 1_024)

  // Legacy and other-vendor confirmations never send text to this engine.
  assert.equal((await post(speech)).status, 409)
  assert.equal((await post({ ...speech, expectedProvider: 'minimax' })).status, 409)
  assert.equal((await post({ ...speech, expectedProvider: 'local', expectedRegion: 'cn' })).status, 400)
  assert.equal(engine.requests.length, 1)
})

test('a LOCAL_TTS_URL that already ends in the speech path is not doubled; refusals are explained', async () => {
  const { localTtsUrlProblem } = await import('./local-tts.mjs')
  for (const url of ['http://127.0.0.1:9880', 'http://127.0.0.1:9880/', 'http://127.0.0.1:9880/v1/audio/speech', 'http://127.0.0.1:9880/v1/audio/speech/'])
    assert.equal(readLocalTtsConfig({ LOCAL_TTS_URL: url }).endpoint, 'http://127.0.0.1:9880/v1/audio/speech', url)
  assert.equal(readLocalTtsConfig({ LOCAL_TTS_URL: 'http://10.0.0.5:8000/tts' }).endpoint, 'http://10.0.0.5:8000/tts/v1/audio/speech')
  assert.deepEqual(['', 'nope', 'ftp://127.0.0.1/', 'http://a:b@127.0.0.1/', 'http://127.0.0.1/?k=1', 'http://example.com/', 'http://127.0.0.1:9880'].map(localTtsUrlProblem),
    ['missing', 'invalid', 'scheme', 'credentials', 'query', 'host', null])
})
