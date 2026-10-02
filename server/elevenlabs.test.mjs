import assert from 'node:assert/strict'
import test from 'node:test'

import { buildElevenLabsRequest, estimateElevenLabsReservation, readElevenLabsConfig, synthesiseElevenLabs } from './elevenlabs.mjs'
import { SpeechProviderError } from './speech-error.mjs'

const env = { ELEVENLABS_TTS_ENABLED: '1', ELEVENLABS_API_KEY: 'test-secret-key',
  ELEVENLABS_VOICE_ID: 'test_private_voice', ELEVENLABS_TTS_DAILY_CHAR_LIMIT: '1000' }
const config = readElevenLabsConfig(env)
const request = { text: '你好！', delivery: 'neutral' }
const endpoint = 'https://api.elevenlabs.io/v1/text-to-dialogue/with-timestamps?output_format=mp3_44100_128'
// Synthetic MPEG-1 Layer III frame headers/payload: NOT playable provider audio.
// Decoder validity, silence, voice quality and real alignment remain smoke gates.
function mp3Frames(count = 40, channel = 3, padding = 0) {
  const length = Math.floor(144_000 * 128 / 44_100) + padding
  const bytes = Buffer.alloc(length * count)
  for (let offset = 0; offset < bytes.length; offset += length)
    Buffer.from([0xff, 0xfb, 0x90 | padding << 1, channel << 6]).copy(bytes, offset)
  return bytes
}
const mp3 = mp3Frames()
const alignment = (characters = ['你', '好', '！'], starts = [0, 0.2, 0.6], ends = [0.2, 0.6, 0.9]) => ({
  characters, character_start_times_seconds: starts, character_end_times_seconds: ends,
})
const fixture = (audio = mp3) => ({ audio_base64: audio.toString('base64'), alignment: alignment() })
function byteStream(content, width = 257) {
  let offset = 0
  return new ReadableStream({ pull(controller) {
    if (offset === content.length)
      return controller.close()
    controller.enqueue(content.subarray(offset, offset + width))
    offset = Math.min(content.length, offset + width)
  } })
}
function response(value, { headers = {}, status = 200, width } = {}) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value))
  return new Response(byteStream(bytes, width), { status, headers: { 'content-type': 'application/json', ...headers } })
}
const synth = (value = fixture(), options = {}) => synthesiseElevenLabs(config, request,
  { fetchImpl: async () => response(value, options) })
const invalid = promise => assert.rejects(promise, error => error instanceof SpeechProviderError && error.code === 'TTS_UPSTREAM_INVALID')

test('OFF by default; explicit switch, supported model, credentials and integer daily cap are required', () => {
  const off = readElevenLabsConfig({})
  assert.equal(off.configured, false)
  assert.equal(off.provider, 'elevenlabs')
  assert.equal(off.model, 'eleven_v4')
  assert.equal(off.endpoint, endpoint)
  assert.equal(config.configured, true)
  assert.equal(Object.isFrozen(config), true)
  for (const name of Object.keys(env)) {
    const missing = { ...env }
    delete missing[name]
    assert.equal(readElevenLabsConfig(missing).configured, false)
  }
  for (const model of ['eleven_v4_turbo', 'eleven_v3', 'https://127.0.0.1'])
    assert.equal(readElevenLabsConfig({ ...env, ELEVENLABS_TTS_MODEL: model }).configured, false)
  assert.equal(readElevenLabsConfig({ ...env, ELEVENLABS_TTS_MODEL: ' eleven_v4 ' }).configured, true)
  for (const cap of ['0', '-1', '2.5', '1e3', 'NaN', '999999999999999999999999'])
    assert.equal(readElevenLabsConfig({ ...env, ELEVENLABS_TTS_DAILY_CHAR_LIMIT: cap }).configured, false)
  for (const key of ['', 'bad key', 'bad\nkey', 'bad\tkey', 'key中文', 'key\u007f', 'a'.repeat(4097)])
    assert.equal(readElevenLabsConfig({ ...env, ELEVENLABS_API_KEY: key }).configured, false)
  for (const voice of ['', ' voice', 'voice ', '中文', 'voice\n', '../voice', '\ud800', 'a'.repeat(257)])
    assert.equal(readElevenLabsConfig({ ...env, ELEVENLABS_VOICE_ID: voice }).configured, false)
  assert.equal(readElevenLabsConfig({ ...env, ELEVENLABS_ENDPOINT: 'https://attacker.invalid' }).endpoint, endpoint)
})

test('fixed model/voice/language; only trusted delivery adds tags; ASCII tags and controls are literalized', () => {
  assert.deepEqual(buildElevenLabsRequest(config, { ...request, model: 'injected', voiceId: 'injected' }), {
    inputs: [{ text: '你好！', voice_id: 'test_private_voice' }], model_id: 'eleven_v4', language_code: 'zh',
  })
  for (const [delivery, prefix] of [['neutral', ''], ['soft', ''], ['bright', '[happy] '], ['curious', '[curious] ']]) {
    const body = buildElevenLabsRequest(config, { text: '[laughs]你\u0000\n好[[tone:bright]]', delivery })
    assert.equal(body.inputs[0].text, prefix + '［laughs］你\n好［［tone:bright］］')
    assert.equal(estimateElevenLabsReservation(config, { text: '[laughs]你\u0000\n好[[tone:bright]]', delivery }), body.inputs[0].text.length)
  }
  assert.equal(estimateElevenLabsReservation(config, { text: '你好😀', delivery: 'neutral' }), 4)
  assert.equal(estimateElevenLabsReservation(config, { text: '你好', delivery: 'bright' }), 10)
  for (const bad of [{ text: '', delivery: 'neutral' }, { text: '\u0000', delivery: 'neutral' },
    { text: '\ud800', delivery: 'neutral' }, { text: 'a'.repeat(361), delivery: 'neutral' },
    { text: '你好', delivery: '[laughs]' }, {}])
    assert.throws(() => buildElevenLabsRequest(config, bad), { code: 'TTS_INVALID_REQUEST' })
})

test('normal newline/tab separators preserve word boundaries and match the exact submitted reservation', () => {
  const text = 'hello\nworld\t你好\r好呀\r\nnext\u0000\u000b\u0085end'
  const literal = 'hello\nworld\t你好\r好呀\r\nnextend'
  for (const [delivery, prefix] of [['neutral', ''], ['soft', ''], ['bright', '[happy] '], ['curious', '[curious] ']]) {
    const input = { text, delivery }
    const submitted = buildElevenLabsRequest(config, input).inputs[0].text
    assert.equal(submitted, prefix + literal)
    assert.equal(estimateElevenLabsReservation(config, input), submitted.length)
  }
})

test('only official POST with xi-api-key, no redirect; validates bounded MP3 and global-second characters', async () => {
  const result = await synthesiseElevenLabs(config, request, { fetchImpl: async (url, options) => {
    assert.equal(url, endpoint)
    assert.equal(options.method, 'POST')
    assert.equal(options.redirect, 'error')
    assert.deepEqual(options.headers, { 'xi-api-key': 'test-secret-key', 'Content-Type': 'application/json' })
    assert.deepEqual(JSON.parse(options.body), buildElevenLabsRequest(config, request))
    return response({ ...fixture(), subtitle_file: 'https://attacker.invalid/subtitle',
      voice_segments: [{ voice_id: 'private-untrusted-id' }] })
  } })
  assert.deepEqual(result, { audio: mp3.toString('base64'), format: 'mp3', sampleRate: 44_100,
    words: [], characters: [{ text: '你', start: 0, end: 0.2 }, { text: '好', start: 0.2, end: 0.6 }, { text: '！', start: 0.6, end: 0.9 }] })
})

test('never sends to a mutated endpoint or unsupported model/configuration', async () => {
  for (const changed of [{ configured: false }, { endpoint: 'https://attacker.invalid' }, { model: 'eleven_v4_turbo' },
    { apiKey: 'bad\nkey' }, { voiceId: 'bad voice' }, { dailyLimit: 0 }, { provider: 'minimax' }]) {
    let fetched = false
    await assert.rejects(synthesiseElevenLabs({ ...config, ...changed }, request, { fetchImpl: async () => {
      fetched = true
      return response(fixture())
    } }), { code: 'TTS_NOT_CONFIGURED' })
    assert.equal(fetched, false)
  }
})

test('accepts absent alignment, prefers normalized, preserves punctuation/scalars and zero-duration intervals', async () => {
  assert.deepEqual((await synth({ audio_base64: mp3.toString('base64') })).characters, [])
  assert.deepEqual((await synth({ ...fixture(), alignment: null, normalized_alignment: null })).characters, [])
  const normalized = alignment(['😀', ' ', '！'], [0, 0.2, 0.4], [0.2, 0.2, 0.7])
  assert.deepEqual((await synth({ ...fixture(), normalized_alignment: normalized })).characters,
    [{ text: '😀', start: 0, end: 0.2 }, { text: ' ', start: 0.2, end: 0.2 }, { text: '！', start: 0.4, end: 0.7 }])
  assert.deepEqual((await synth({ ...fixture(), normalized_alignment: alignment([], [], []) })).characters, [])
})

test('validates every supplied alignment: bounded equal arrays, scalar characters, finite ordered times within audio', async () => {
  const duration = 40 * 1152 / 44100
  const bad = [[], {}, alignment(['你'], [], [0.1]), alignment(['你好'], [0], [0.1]),
    alignment([''], [0], [0.1]), alignment(['\ud800'], [0], [0.1]), alignment(['你'], [-0.1], [0.1]),
    alignment(['你'], [NaN], [0.1]), alignment(['你'], [0], [Infinity]), alignment(['你'], [0.2], [0.1]),
    alignment(['你', '好'], [0.2, 0.1], [0.3, 0.2]), alignment(['你', '好'], [0, 0.1], [0.2, 0.3]),
    alignment(['你'], [0], [duration + 0.051]), alignment(['你'], [0], [1000]),
    alignment(['你'], [duration + 0.04], [duration + 0.04]),
    alignment(Array(1025).fill('你'), Array(1025).fill(0), Array(1025).fill(0))]
  for (const entry of bad) {
    await invalid(synth({ ...fixture(), alignment: entry, normalized_alignment: alignment() }))
    await invalid(synth({ ...fixture(), normalized_alignment: entry }))
  }
  assert.equal((await synth({ ...fixture(), alignment: alignment(['你'], [0], [duration + 0.05]) })).characters[0].end, duration + 0.05)
  assert.deepEqual((await synth({ ...fixture(), alignment: alignment(['！'], [duration], [duration]) })).characters,
    [{ text: '！', start: duration, end: duration }])
  assert.deepEqual((await synth({ ...fixture(), alignment: alignment(['！'], [duration], [duration + 0.05]) })).characters,
    [{ text: '！', start: duration, end: duration + 0.05 }])
})

test('rejects wrong, oversized or truncated JSON bodies and unexpected content-type without reading URLs', async () => {
  for (const value of [Buffer.from('{'), Buffer.from([0xff]), null, [], { audio_url: 'https://attacker.invalid/audio' }])
    await invalid(synth(value))
  for (const headers of [{ 'content-type': 'text/event-stream' }, { 'content-type': 'audio/mpeg' },
    { 'content-type': 'application/json-evil' }, { 'content-length': '4194305' }, { 'content-length': 'bogus' }])
    await invalid(synth(fixture(), { headers }))
  await invalid(synth(Buffer.alloc(4 * 1024 * 1024 + 1, 0x20), { width: 65536 }))
})

test('canonical base64 only: reject whitespace, URL alphabets, bad padding and oversized decoded audio', async () => {
  for (const base64 of ['', '!!!!', 'Zg', 'Zg===', 'Zh==', 'Zm9=', 'Zg==\n', '-___', 'A'.repeat(2796208)])
    await invalid(synth({ ...fixture(), audio_base64: base64 }))
  await invalid(synth(fixture(Buffer.alloc(2 * 1024 * 1024 + 1))))
})

test('complete MPEG-1 Layer III 44.1k mono or stereo frames; reject malformed headers, tails, changed channels and >30s', async () => {
  for (const channel of [0, 1, 2, 3])
    assert.equal((await synth(fixture(mp3Frames(40, channel, 1)))).sampleRate, 44100)
  const wrongHeader = (index, byte) => {
    const copy = Buffer.from(mp3)
    copy[index] = byte
    return copy
  }
  const changedChannels = Buffer.from(mp3)
  changedChannels[417 + 3] = 0
  for (const bytes of [Buffer.alloc(40), mp3.subarray(0, -1), Buffer.concat([mp3, Buffer.from([0])]),
    wrongHeader(1, 0xf3), wrongHeader(1, 0xfd), wrongHeader(2, 0x94), wrongHeader(2, 0x98),
    wrongHeader(2, 0x00), wrongHeader(2, 0xf0), wrongHeader(3, 0xc2), changedChannels, mp3Frames(1149)])
    await invalid(synth(fixture(bytes)))
})

test('complete bounded ID3 metadata is allowed; bad structure and high-bit fake tag prefixes fail closed', async () => {
  const header = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 3])
  const tagged = Buffer.concat([header, Buffer.from('abc'), mp3])
  assert.equal((await synth(fixture(tagged))).audio, tagged.toString('base64'))
  const trailer = Buffer.alloc(128)
  trailer.write('TAG')
  const footHeader = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0x10, 0, 0, 0, 0])
  const footer = Buffer.from(footHeader)
  footer.write('3DI')
  const withFooter = Buffer.concat([footHeader, footer, mp3, trailer])
  assert.equal((await synth(fixture(withFooter))).audio, withFooter.toString('base64'))
  const mutated = (index, value) => {
    const copy = Buffer.from(tagged)
    copy[index] = value
    return copy
  }
  const highBitPrefix = (bytes, offset) => {
    const copy = Buffer.from(bytes)
    for (let index = offset; index < offset + 3; index++)
      copy[index] |= 0x80
    return copy
  }
  for (const bytes of [header.subarray(0, 9), header, mutated(3, 5), mutated(4, 255), mutated(5, 1),
    mutated(6, 128), mutated(6, 127), Buffer.concat([footHeader, mp3]), Buffer.concat([mp3, trailer.subarray(0, 127)]),
    highBitPrefix(tagged, 0), highBitPrefix(withFooter, 10), highBitPrefix(withFooter, withFooter.length - 128)])
    await invalid(synth(fixture(bytes)))
})

test('upstream errors never leak credential, submitted text, response body or error message', async () => {
  for (const fetchImpl of [async () => { throw new Error('test-secret-key private dialogue') },
    async () => response({ detail: 'test-secret-key private dialogue' }, { status: 401 })])
    await assert.rejects(synthesiseElevenLabs(config, request, { fetchImpl }), error => {
      assert.equal(error.code, 'TTS_UPSTREAM_FAILED')
      assert.equal(error.message, 'TTS_UPSTREAM_FAILED')
      return true
    })
})

test('pre-abort does not fetch; aborting a pending fetch settles promptly and cancels its late body', async () => {
  const controller = new AbortController()
  const reason = new DOMException('cancelled', 'AbortError')
  controller.abort(reason)
  let fetched = false
  await assert.rejects(synthesiseElevenLabs(config, request, { signal: controller.signal, fetchImpl: () => { fetched = true } }), error => error === reason)
  assert.equal(fetched, false)
  const pending = new AbortController()
  let resolveFetch
  let cancelled = false
  const result = synthesiseElevenLabs(config, request, { signal: pending.signal,
    fetchImpl: () => new Promise(resolve => { resolveFetch = resolve }) })
  pending.abort(reason)
  await assert.rejects(result, error => error === reason)
  resolveFetch({ body: { cancel() { cancelled = true; return new Promise(() => {}) } } })
  await Promise.resolve()
  assert.equal(cancelled, true)
})

test('timeout/abort cancels a stuck reader without awaiting uncooperative cancellation', async () => {
  const controller = new AbortController()
  let started
  const reading = new Promise(resolve => { started = resolve })
  let cancelled = false
  let released = false
  const reader = { read() { started(); return new Promise(() => {}) },
    cancel() { cancelled = true; return new Promise(() => {}) }, releaseLock() { released = true } }
  const result = synthesiseElevenLabs(config, request, { signal: controller.signal, fetchImpl: async () => ({
    ok: true, headers: new Headers({ 'content-type': 'application/json' }), body: { getReader: () => reader },
  }) })
  await reading
  const reason = new DOMException('timeout', 'TimeoutError')
  controller.abort(reason)
  await assert.rejects(result, error => error === reason)
  assert.equal(cancelled, true)
  assert.equal(released, true)
})

test('invalid response cancellation never waits for body.cancel to finish', async () => {
  let cancelled = false
  const value = { ok: true, headers: new Headers({ 'content-type': 'text/plain' }),
    body: { cancel() { cancelled = true; return new Promise(() => {}) } } }
  await invalid(synthesiseElevenLabs(config, request, { fetchImpl: async () => value }))
  assert.equal(cancelled, true)
})

test('reader acquisition/read errors are cancelled and redacted to a stable provider code', async () => {
  for (const getReader of [() => { throw new Error('test-secret-key') }, () => ({
    read: async () => { throw new Error('test-secret-key') }, cancel: async () => {}, releaseLock() {},
  })]) {
    const value = { ok: true, headers: new Headers({ 'content-type': 'application/json' }),
      body: { getReader, cancel: async () => {} } }
    await invalid(synthesiseElevenLabs(config, request, { fetchImpl: async () => value }))
  }
})
