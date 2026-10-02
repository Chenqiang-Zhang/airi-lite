import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchCloudSpeech as requestCloudSpeech, SpeechApiError } from './cloud-speech.ts'

const ENDPOINT = '/airi/api/speech'
const RESPONSE_LIMIT = 4 * 1024 * 1024
const AUDIO_LIMIT = 2 * 1024 * 1024
const options = overrides => ({ text: '你好，Hello OpenAI 2026。', delivery: 'bright', endpoint: ENDPOINT, ...overrides })
const settle = () => new Promise(resolve => setImmediate(resolve))

function decoded({ sampleRate = 32000, length = sampleRate / 10, samples } = {}) {
  return { samples: samples ?? Float32Array.from({ length }, (_, index) => Math.sin(index * 0.1) * 0.3), sampleRate }
}

// No test calls a real provider or codec; native lifecycle tests install a
// fake AudioContext explicitly. The compressed fixture is deliberately fake.
const fetchCloudSpeech = (input, dependencies = {}) => requestCloudSpeech(input, {
  decodeAudio: async () => decoded(),
  ...dependencies,
})

function payload(overrides = {}) {
  return {
    audio: Buffer.from('ID3-fake-mp3').toString('base64'),
    format: 'mp3',
    sampleRate: 32000,
    words: [{ text: '你好', start: 0, end: 0.04 }, { text: 'Hello', start: 0.04, end: 0.1 }],
    ...overrides,
  }
}

function response(body = payload(), init = {}) {
  return new Response(JSON.stringify(body), init)
}

function apiFailure(code, status) {
  return error => {
    assert.ok(error instanceof SpeechApiError)
    assert.equal(error.name, 'SpeechApiError')
    assert.equal(error.code, code)
    assert.equal(error.status, status)
    assert.match(error.message, /[\u4e00-\u9fff]/)
    return true
  }
}

test('same-origin request preserves original Chinese/English text, delivery, access code and signal', async () => {
  const signal = new AbortController().signal
  const input = options({ accessCode: 'Demo-2026_ABC!', signal })
  const calls = []
  const result = await fetchCloudSpeech(input, { fetch: async (...args) => {
    calls.push(args)
    return response()
  } })
  assert.equal(calls.length, 1)
  const [url, init] = calls[0]
  assert.equal(url, ENDPOINT)
  assert.equal(init.method, 'POST')
  assert.equal(init.mode, 'same-origin')
  assert.equal(init.credentials, 'same-origin')
  assert.equal(init.redirect, 'error')
  assert.equal(init.cache, 'no-store')
  assert.deepEqual(init.headers, { 'Content-Type': 'application/json', 'X-Demo-Access-Code': 'Demo-2026_ABC!' })
  assert.equal(init.body, JSON.stringify({ text: input.text, delivery: 'bright', expectedProvider: 'minimax' }))
  assert.equal(init.signal, signal)
  assert.ok(result.samples instanceof Float32Array)
  assert.equal(result.samples.length, 3200)
  assert.equal(result.sampleRate, 32000)
  assert.deepEqual(result.words, payload().words)
  assert.deepEqual(result.characters, [])
})

test('default route works without Vite env in Node, and optional access header is omitted', async () => {
  for (const accessCode of [undefined, '']) {
    let call
    await fetchCloudSpeech({ text: 'Hello world.', delivery: 'neutral', accessCode }, { fetch: async (...args) => {
      call = args
      return response()
    } })
    assert.equal(call[0], '/api/speech')
    assert.deepEqual(call[1].headers, { 'Content-Type': 'application/json' })
    assert.deepEqual(JSON.parse(call[1].body), { text: 'Hello world.', delivery: 'neutral', expectedProvider: 'minimax' })
  }
})

test('the expected provider guard defaults to MiniMax and preserves only an explicit known selection', async () => {
  for (const expectedProvider of [undefined, 'minimax', 'elevenlabs']) {
    let body
    let calls = 0
    await fetchCloudSpeech(options({ expectedProvider }), { fetch: async (_url, init) => {
      calls++
      body = JSON.parse(init.body)
      return response()
    } })
    assert.equal(calls, 1)
    assert.deepEqual(body, { text: options().text, delivery: 'bright', expectedProvider: expectedProvider ?? 'minimax' })
    assert.ok(!('provider' in body), 'the guard must not become a provider-selection override')
  }
})

test('unknown, coerced or empty expected provider values fail before any request', async () => {
  for (const expectedProvider of ['ElevenLabs', 'unknown', '', ' elevenlabs ', null, 123, {}, ['elevenlabs']]) {
    let calls = 0
    await assert.rejects(fetchCloudSpeech(options({ expectedProvider }), { fetch: async () => {
      calls++
      return response()
    } }), apiFailure('invalid_request'))
    assert.equal(calls, 0)
  }
})

test('base64 MP3 bytes are passed intact to the codec, without guessing PCM encoding or byte alignment', async () => {
  const bytes = Buffer.from('ID3-fake-mp3!')
  assert.equal(bytes.length % 2, 1)
  const audio = decoded({ sampleRate: 48000 })
  const result = await fetchCloudSpeech(options(), {
    fetch: async () => response(payload({ audio: bytes.toString('base64'), words: [] })),
    decodeAudio: async encoded => {
      assert.ok(encoded instanceof ArrayBuffer)
      assert.deepEqual(new Uint8Array(encoded), new Uint8Array(bytes))
      return audio
    },
  })
  assert.equal(result.samples, audio.samples)
  assert.equal(result.sampleRate, 48000)
  assert.deepEqual(result.words, [])
})

test('44.1 kHz MP3 accepts bounded character alignment without turning it into words or visemes', async () => {
  const characters = [
    { text: '你', start: 0, end: 0.02 },
    { text: ' ', start: 0.02, end: 0.02 },
    { text: '𠮷', start: 0.02, end: 0.06 },
    { text: '！', start: 0.06, end: 0.1 },
  ]
  const audio = decoded({ sampleRate: 44100 })
  let calls = 0
  const result = await fetchCloudSpeech(options({ expectedProvider: 'elevenlabs' }), {
    fetch: async () => { calls++; return response(payload({ sampleRate: 44100, words: [], characters })) },
    decodeAudio: async () => audio,
  })
  assert.equal(calls, 1)
  assert.equal(result.samples, audio.samples)
  assert.equal(result.sampleRate, 44100)
  assert.deepEqual(result.words, [])
  assert.deepEqual(result.characters, characters)
  assert.ok(result.characters.every(character => !('viseme' in character)))
})

test('MiniMax clips remain compatible with missing or explicitly empty character metadata', async () => {
  for (const characters of [undefined, []]) {
    const result = await fetchCloudSpeech(options(), { fetch: async () => response(payload({ characters })) })
    assert.deepEqual(result.words, payload().words)
    assert.deepEqual(result.characters, [])
  }
})

test('non-ASCII, whitespace, invisible or too-long access codes fail before fetch', async () => {
  for (const accessCode of ['体验码', 'Ｄｅｍｏ', ' Demo', 'Demo ', 'Demo\n', 'Demo\u200b', '\u007f', 'a'.repeat(257), null, 123]) {
    let calls = 0
    await assert.rejects(fetchCloudSpeech(options({ accessCode }), { fetch: async () => {
      calls++
      return response()
    } }), apiFailure('invalid_access_code'))
    assert.equal(calls, 0)
  }
})

test('invalid or unspoken text and invalid delivery never create a paid request', async () => {
  for (const input of [options({ text: '' }), options({ text: '😊✨！！！' }), options({ text: '1️⃣' }), options({ text: 'x'.repeat(361) }), options({ text: '𠮷'.repeat(181) }), options({ delivery: 'evil' }), options({ text: 123 })]) {
    let calls = 0
    await assert.rejects(fetchCloudSpeech(input, { fetch: async () => { calls++; return response() } }), apiFailure('invalid_request'))
    assert.equal(calls, 0)
  }
})

test('the 360 UTF-16 text boundary is accepted unchanged', async () => {
  let body
  const text = '𠮷'.repeat(180)
  await fetchCloudSpeech(options({ text }), { fetch: async (_url, init) => { body = JSON.parse(init.body); return response() } })
  assert.equal(body.text, text)
})

test('endpoint overrides cannot send the access code to another host or a traversal route', async () => {
  for (const endpoint of ['https://api.example.invalid/api/speech', '//evil.invalid/api/speech', '/\\evil/api/speech', '/api/speech?redirect=evil', '/api/speech#bad', '/a/../api/speech', '/%2f%2fevil/api/speech', 'api/speech', '/api/chat']) {
    let calls = 0
    await assert.rejects(fetchCloudSpeech(options({ endpoint, accessCode: 'secret' }), { fetch: async () => { calls++; return response() } }), apiFailure('invalid_request'))
    assert.equal(calls, 0)
  }
})

test('wrong format/rate, missing fields, malformed or empty JSON all reject safely', async () => {
  for (const body of [payload({ format: 'pcm_s16le' }), ...[24000, 48000, 96000, 44100.5, '32000', '44100', null, undefined].map(sampleRate => payload({ sampleRate })), payload({ words: undefined }), [], null, {}, payload({ audio: 123 })]) {
    let decodes = 0
    await assert.rejects(fetchCloudSpeech(options(), {
      fetch: async () => response(body),
      decodeAudio: async () => { decodes++; return decoded() },
    }), apiFailure('invalid_response'))
    assert.equal(decodes, 0)
  }
  for (const body of ['', 'not json provider-token=private', '{"audio":"secret"', Uint8Array.of(0xff)]) {
    await assert.rejects(fetchCloudSpeech(options(), { fetch: async () => new Response(body) }), apiFailure('invalid_response'))
  }
})

test('encoded MP3 must be nonempty and strictly base64 before the codec is invoked', async () => {
  for (const audio of ['', 'A', 'AB==', 'AAB=', 'AA=A', '%%%=', '////\n', 'AAAA====']) {
    let decodes = 0
    await assert.rejects(fetchCloudSpeech(options(), {
      fetch: async () => response(payload({ audio, words: [] })),
      decodeAudio: async () => { decodes++; return decoded() },
    }), apiFailure('invalid_response'))
    assert.equal(decodes, 0)
  }
})

test('compressed audio beyond 2 MiB rejects before decoding, even if JSON fits its response limit', async () => {
  const audio = Buffer.alloc(AUDIO_LIMIT + 2, 127).toString('base64')
  assert.ok(JSON.stringify(payload({ audio })).length < RESPONSE_LIMIT)
  for (const sampleRate of [32000, 44100]) {
    let decodes = 0
    await assert.rejects(fetchCloudSpeech(options(), {
      fetch: async () => response(payload({ audio, sampleRate, words: [], characters: [] })),
      decodeAudio: async () => { decodes++; return decoded() },
    }), apiFailure('invalid_response'))
    assert.equal(decodes, 0)
  }
})

test('decoded samples/rate/duration must be finite, nonempty, audible and bounded to 30 seconds', async () => {
  for (const audio of [
    decoded({ samples: new Float32Array() }),
    decoded({ samples: new Float32Array(32) }),
    decoded({ samples: Float32Array.of(0.00001, -0.00001) }),
    decoded({ samples: Float32Array.of(NaN, 0.1) }),
    decoded({ samples: Float32Array.of(Infinity, 0.1) }),
    { samples: [0.1, 0.2], sampleRate: 32000 },
    decoded({ sampleRate: 0, samples: Float32Array.of(0.1) }),
    decoded({ sampleRate: NaN, samples: Float32Array.of(0.1) }),
    decoded({ sampleRate: Infinity, samples: Float32Array.of(0.1) }),
    decoded({ sampleRate: 7999 }),
    decoded({ sampleRate: 96001 }),
    decoded({ sampleRate: 32000.5 }),
    decoded({ length: 32000 * 30 + 1 }),
  ]) {
    await assert.rejects(fetchCloudSpeech(options(), {
      fetch: async () => response(payload({ words: [] })),
      decodeAudio: async () => audio,
    }), apiFailure('invalid_response'))
  }
  const audio = decoded({ sampleRate: 96000, length: 96000 * 30 })
  const result = await fetchCloudSpeech(options(), { fetch: async () => response(payload({ words: [] })), decodeAudio: async () => audio })
  assert.equal(result.sampleRate, 96000)
  assert.equal(result.samples.length / result.sampleRate, 30)
})

test('a codec failure is redacted and never triggers another provider request', async () => {
  let calls = 0
  await assert.rejects(fetchCloudSpeech(options(), {
    fetch: async () => { calls++; return response() },
    decodeAudio: async () => { throw new Error('private codec debug stack') },
  }), error => {
    apiFailure('invalid_response')(error)
    assert.ok(!error.stack.includes('private codec debug stack'))
    return true
  })
  assert.equal(calls, 1)
})

test('known oversized Content-Length cancels the body without reading it', async () => {
  let canceled = 0
  const stream = new ReadableStream({ cancel() { canceled++ } })
  await assert.rejects(fetchCloudSpeech(options(), { fetch: async () => new Response(stream, { headers: { 'Content-Length': String(RESPONSE_LIMIT + 1) } }) }), apiFailure('invalid_response'))
  assert.equal(canceled, 1)
})

test('a response with no or misleading Content-Length remains bounded and is canceled', async () => {
  for (const headers of [undefined, { 'Content-Length': '10' }]) {
    let canceled = 0
    const stream = new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(RESPONSE_LIMIT / 2 + 1)) },
      cancel() { canceled++ },
    })
    await assert.rejects(fetchCloudSpeech(options(), { fetch: async () => new Response(stream, { headers }) }), apiFailure('invalid_response'))
    assert.equal(canceled, 1)
  }
})

test('bounded JSON reader handles UTF-8 characters split across stream chunks', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(payload()))
  const stream = new ReadableStream({ start(controller) {
    for (let index = 0; index < bytes.length; index += 5)
      controller.enqueue(bytes.slice(index, index + 5))
    controller.close()
  } })
  const result = await fetchCloudSpeech(options(), { fetch: async () => new Response(stream) })
  assert.equal(result.words[0].text, '你好')
})

test('subtitles use validated clip-relative seconds and tolerate only minor rounding', async () => {
  const words = [{ text: '完整字幕', start: 0, end: 0.149 }]
  const result = await fetchCloudSpeech(options(), { fetch: async () => response(payload({ words })) })
  assert.deepEqual(result.words, words)
})

test('subtitle validation uses the real decoded sample rate and duration, not the 32 kHz wire hint', async () => {
  const words = [{ text: '第一词', start: 0, end: 0.1 }, { text: '第二词', start: 0.1, end: 0.19 }]
  const audio = decoded({ sampleRate: 48000, length: 4800 })
  await assert.rejects(fetchCloudSpeech(options(), {
    fetch: async () => response(payload({ words })), decodeAudio: async () => audio,
  }), apiFailure('invalid_response'))
})

test('invalid subtitle timestamps/text/order reject instead of being moved or fabricated', async () => {
  for (const words of [
    null, {},
    [{ text: '词', start: -0.001, end: 0.05 }],
    [{ text: '词', start: 0.02, end: 0.02 }],
    [{ text: '词', start: 0.05, end: 0.01 }],
    [{ text: '词', start: 0, end: 0.151 }],
    [{ text: '词', start: 0.101, end: 0.13 }],
    [{ text: '词', start: '0', end: 0.05 }],
    [{ text: '词', start: NaN, end: 0.05 }],
    [{ text: '词', start: 0, end: Infinity }],
    [{ text: '', start: 0, end: 0.05 }],
    [{ text: '  ', start: 0, end: 0.05 }],
    [{ text: '词'.repeat(361), start: 0, end: 0.05 }],
    [{ text: '后', start: 0.04, end: 0.08 }, { text: '前', start: 0, end: 0.04 }],
    Array.from({ length: 1025 }, () => ({ text: '词', start: 0, end: 0.05 })),
  ]) {
    await assert.rejects(fetchCloudSpeech(options(), { fetch: async () => response(payload({ words })) }), apiFailure('invalid_response'))
  }
})

test('character metadata rejects malformed, non-scalar, unordered, overlapping or oversized alignment before decoding', async () => {
  for (const characters of [
    null, {}, '你好',
    [{ text: '', start: 0, end: 0.01 }],
    [{ text: '你好', start: 0, end: 0.01 }],
    [{ text: '𠮷你', start: 0, end: 0.01 }],
    [{ text: '\uD800', start: 0, end: 0.01 }],
    [{ text: '\uDC00', start: 0, end: 0.01 }],
    [{ text: '你', start: -0.01, end: 0.01 }],
    [{ text: '你', start: 0.02, end: 0.01 }],
    [{ text: '你', start: '0', end: 0.01 }],
    [{ text: '你', start: NaN, end: 0.01 }],
    [{ text: '你', start: 0, end: Infinity }],
    [{ text: '你', start: 30.01, end: 30.02 }],
    [{ text: '你', start: 0, end: 30.051 }],
    [{ text: '后', start: 0.04, end: 0.08 }, { text: '前', start: 0, end: 0.04 }],
    [{ text: '你', start: 0, end: 0.06 }, { text: '好', start: 0.05, end: 0.08 }],
    Array.from({ length: 1025 }, () => ({ text: '你', start: 0, end: 0 })),
  ]) {
    let decodes = 0
    await assert.rejects(fetchCloudSpeech(options(), {
      fetch: async () => response(payload({ sampleRate: 44100, words: [], characters })),
      decodeAudio: async () => { decodes++; return decoded() },
    }), apiFailure('invalid_response'))
    assert.equal(decodes, 0)
  }
  const finitePayload = JSON.stringify(payload({ sampleRate: 44100, words: [], characters: [{ text: '你', start: 0, end: 0.01 }] }))
  for (const body of [finitePayload.replace('"start":0', '"start":1e999'), finitePayload.replace('"end":0.01', '"end":1e999')]) {
    let decodes = 0
    await assert.rejects(fetchCloudSpeech(options(), {
      fetch: async () => new Response(body),
      decodeAudio: async () => { decodes++; return decoded() },
    }), apiFailure('invalid_response'))
    assert.equal(decodes, 0)
  }
})

test('character bounds use actual decoded duration with only 50 ms of end rounding tolerance', async () => {
  const audio = decoded({ sampleRate: 48000, length: 4800 })
  for (const character of [{ text: '你', start: 0.101, end: 0.12 }, { text: '你', start: 0, end: 0.151 }]) {
    await assert.rejects(fetchCloudSpeech(options(), {
      fetch: async () => response(payload({ sampleRate: 44100, words: [], characters: [character] })),
      decodeAudio: async () => audio,
    }), apiFailure('invalid_response'))
  }
  const characters = [{ text: '你', start: 0, end: 0.149 }]
  const result = await fetchCloudSpeech(options(), {
    fetch: async () => response(payload({ sampleRate: 44100, words: [], characters })),
    decodeAudio: async () => audio,
  })
  assert.equal(result.sampleRate, 48000)
  assert.deepEqual(result.characters, characters)
  const limit = Array.from({ length: 1024 }, () => ({ text: ' ', start: 0, end: 0 }))
  const bounded = await fetchCloudSpeech(options(), { fetch: async () => response(payload({ sampleRate: 44100, words: [], characters: limit })) })
  assert.equal(bounded.characters.length, 1024)
})

test('HTTP failures expose safe Chinese categories/status and never read or retry provider bodies', async () => {
  const secret = 'private_provider_key_debug_stack'
  for (const [status, code] of [[401, 'unauthorized'], [403, 'unauthorized'], [409, 'provider_changed'], [429, 'rate_limited'], [503, 'unavailable'], [502, 'upstream'], [500, 'upstream'], [400, 'invalid_request']]) {
    let calls = 0
    let canceled = 0
    const stream = new ReadableStream({ cancel() { canceled++ } })
    await assert.rejects(fetchCloudSpeech(options(), { fetch: async () => {
      calls++
      return new Response(stream, { status, statusText: secret, headers: { 'X-Provider-Error': secret } })
    } }), error => {
      apiFailure(code, status)(error)
      assert.ok(!String(error).includes(secret))
      assert.ok(!error.stack.includes(secret))
      assert.ok(!JSON.stringify(error).includes(secret))
      return true
    })
    assert.equal(calls, 1)
    assert.equal(canceled, 1)
  }
  await assert.rejects(fetchCloudSpeech(options(), { fetch: async () => new Response(JSON.stringify({ message: secret }), { status: 502 }) }), error => {
    assert.ok(!String(error).includes(secret))
    return true
  })
})

test('HTTP 409 requires re-confirmation, cancels without reading the body, and never decodes or retries', async () => {
  let calls = 0
  let canceled = 0
  let decodes = 0
  await assert.rejects(fetchCloudSpeech(options({ expectedProvider: 'elevenlabs' }), {
    fetch: async () => {
      calls++
      return { ok: false, status: 409, body: {
        getReader() { assert.fail('provider-change error body must not be read') },
        cancel() { canceled++; return new Promise(() => {}) },
      } }
    },
    decodeAudio: async () => { decodes++; return decoded() },
  }), error => {
    apiFailure('provider_changed', 409)(error)
    assert.match(error.message, /供应商已变化.*重新选择.*确认云端/)
    return true
  })
  assert.equal(calls, 1)
  assert.equal(canceled, 1)
  assert.equal(decodes, 0)
})

test('fetch and streaming failures are redacted and do not retry', async () => {
  const secret = 'Bearer private_provider_key and debug stack'
  let calls = 0
  await assert.rejects(fetchCloudSpeech(options(), { fetch: async () => { calls++; throw new Error(secret) } }), error => {
    apiFailure('network')(error)
    assert.ok(!error.stack.includes(secret))
    assert.equal(error.cause, undefined)
    return true
  })
  assert.equal(calls, 1)
  const stream = new ReadableStream({ start(controller) { controller.error(new Error(secret)) } })
  await assert.rejects(fetchCloudSpeech(options(), { fetch: async () => new Response(stream) }), error => {
    apiFailure('invalid_response')(error)
    assert.ok(!error.stack.includes(secret))
    return true
  })
})

test('already aborted signals avoid fetch and do not expose custom cancellation reasons', async () => {
  const controller = new AbortController()
  controller.abort(new Error('private cancellation secret'))
  let calls = 0
  await assert.rejects(fetchCloudSpeech(options({ signal: controller.signal }), { fetch: async () => { calls++; return response() } }), error => {
    assert.equal(error.name, 'AbortError')
    assert.ok(!error.stack.includes('private cancellation secret'))
    return true
  })
  assert.equal(calls, 0)
})

test('an abort while fetch is pending remains AbortError without a retry', async () => {
  const controller = new AbortController()
  let calls = 0
  const request = fetchCloudSpeech(options({ signal: controller.signal }), { fetch: async (_url, init) => {
    calls++
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }))
  } })
  controller.abort()
  await assert.rejects(request, { name: 'AbortError' })
  assert.equal(calls, 1)
})

test('abort cancels an otherwise stalled body read and prevents late results', async () => {
  const controller = new AbortController()
  let canceled = 0
  const stream = new ReadableStream({ cancel() { canceled++ } })
  const request = fetchCloudSpeech(options({ signal: controller.signal }), { fetch: async () => new Response(stream) })
  await settle()
  controller.abort(new Error('private abort reason'))
  await assert.rejects(request, error => {
    assert.equal(error.name, 'AbortError')
    assert.ok(!error.stack.includes('private abort reason'))
    return true
  })
  assert.equal(canceled, 1)
})

test('abort immediately after fetch resolves cancels the unread response body', async () => {
  const controller = new AbortController()
  let canceled = 0
  const stream = new ReadableStream({ cancel() { canceled++ } })
  await assert.rejects(fetchCloudSpeech(options({ signal: controller.signal }), { fetch: async () => {
    controller.abort()
    return new Response(stream)
  } }), { name: 'AbortError' })
  assert.equal(canceled, 1)
})

test('abort while an injected codec is pending promptly rejects and ignores late decoding', async () => {
  const controller = new AbortController()
  let rejectDecode
  const request = fetchCloudSpeech(options({ signal: controller.signal }), {
    fetch: async () => response(),
    decodeAudio: async () => new Promise((_resolve, reject) => { rejectDecode = reject }),
  })
  await settle()
  assert.equal(typeof rejectDecode, 'function')
  controller.abort()
  await assert.rejects(request, { name: 'AbortError' })
  rejectDecode(new Error('private late decoder error'))
  await settle()
})

async function withAudioContext(Context, run) {
  const previous = globalThis.AudioContext
  globalThis.AudioContext = Context
  try { await run() }
  finally {
    if (previous === undefined) delete globalThis.AudioContext
    else globalThis.AudioContext = previous
  }
}

function audioBuffer(audio = decoded(), channels = 1, channelData) {
  return { numberOfChannels: channels, sampleRate: audio.sampleRate, length: audio.samples.length, getChannelData: index => channelData ? channelData[index] : audio.samples }
}

test('missing native codec fails before fetching; abort takes priority and an injected codec still works', async () => {
  await withAudioContext(undefined, async () => {
    let calls = 0
    const fetch = async () => { calls++; return response() }
    await assert.rejects(requestCloudSpeech(options(), { fetch }), apiFailure('invalid_response'))
    assert.equal(calls, 0)

    const controller = new AbortController()
    controller.abort(new Error('private aborted codec check'))
    await assert.rejects(requestCloudSpeech(options({ signal: controller.signal }), { fetch }), error => {
      assert.equal(error.name, 'AbortError')
      assert.ok(!error.stack.includes('private aborted codec check'))
      return true
    })
    assert.equal(calls, 0)

    const result = await requestCloudSpeech(options(), { fetch, decodeAudio: async () => decoded() })
    assert.equal(calls, 1)
    assert.equal(result.sampleRate, 32000)
  })
})

test('native codec is created only after validation, reports actual rate, never plays and always closes', async () => {
  const created = []
  let closes = 0
  const audio = decoded({ sampleRate: 48000 })
  class Context {
    constructor(config) { created.push(config) }
    async decodeAudioData(encoded) {
      assert.deepEqual(new Uint8Array(encoded), new Uint8Array(Buffer.from('ID3-fake-mp3')))
      return audioBuffer(audio)
    }
    createBufferSource() { assert.fail('decoder must not start playback') }
    async close() { closes++ }
  }
  await withAudioContext(Context, async () => {
    for (const body of [payload({ format: 'pcm_s16le' }), payload({ audio: '%%%=' }), payload({ words: [{ text: '坏', start: -1, end: 1 }] })]) {
      await assert.rejects(requestCloudSpeech(options(), { fetch: async () => response(body) }), apiFailure('invalid_response'))
    }
    assert.equal(created.length, 0)
    const result = await requestCloudSpeech(options(), { fetch: async () => response() })
    assert.equal(result.sampleRate, 48000)
    assert.deepEqual([...result.samples], [...audio.samples])
    assert.notEqual(result.samples, audio.samples)
    assert.deepEqual(created, [{ sampleRate: 32000 }])
    assert.equal(closes, 1)
  })
})

test('native codec falls back to a device rate if a requested 32 kHz context is unsupported', async () => {
  const created = []
  let closes = 0
  class Context {
    constructor(config) {
      created.push(config)
      if (config) throw new DOMException('32 kHz unsupported', 'NotSupportedError')
    }
    async decodeAudioData() { return audioBuffer(decoded({ sampleRate: 48000 })) }
    async close() { closes++ }
  }
  await withAudioContext(Context, async () => {
    const result = await requestCloudSpeech(options(), { fetch: async () => response() })
    assert.equal(result.sampleRate, 48000)
    assert.deepEqual(created, [{ sampleRate: 32000 }, undefined])
    assert.equal(closes, 1)
  })
})

test('native decode failure, unsupported channel count or out-of-bounds duration closes context and redacts errors', async () => {
  for (const data of [new Error('private native codec error'), audioBuffer(decoded(), 0), audioBuffer(decoded(), 3), audioBuffer(decoded({ length: 32000 * 30 + 1 }))]) {
    let closes = 0
    class Context {
      async decodeAudioData() { if (data instanceof Error) throw data; return data }
      async close() { closes++ }
    }
    await withAudioContext(Context, async () => {
      await assert.rejects(requestCloudSpeech(options(), { fetch: async () => response() }), error => {
        apiFailure('invalid_response')(error)
        assert.ok(!error.stack.includes('private native codec error'))
        return true
      })
      assert.equal(closes, 1)
    })
  }
})

test('44.1 kHz native stereo decode uses actual rate and bounded mean downmix without playback', async () => {
  const created = []
  let closes = 0
  const left = Float32Array.of(0.4, -0.6, 2, -2)
  const right = Float32Array.of(0.2, -0.2, 2, -2)
  const audio = decoded({ sampleRate: 48000, samples: left })
  class Context {
    constructor(config) { created.push(config) }
    async decodeAudioData() { return audioBuffer(audio, 2, [left, right]) }
    createBufferSource() { assert.fail('decoder must not start playback') }
    async close() { closes++ }
  }
  await withAudioContext(Context, async () => {
    const characters = [{ text: '你', start: 0, end: left.length / audio.sampleRate }]
    const result = await requestCloudSpeech(options(), { fetch: async () => response(payload({ sampleRate: 44100, words: [], characters })) })
    assert.equal(result.sampleRate, 48000)
    assert.deepEqual([...result.samples], [...Float32Array.of(0.3, -0.4, 1, -1)])
    assert.notEqual(result.samples, left)
    assert.notEqual(result.samples, right)
    assert.deepEqual(result.characters, characters)
    assert.deepEqual(created, [{ sampleRate: 44100 }])
    assert.equal(closes, 1)
  })
})

test('stereo phase cancellation, nonfinite channels and malformed buffers reject without selecting an audible side', async () => {
  const audio = decoded({ sampleRate: 44100, samples: Float32Array.of(0.4, -0.4) })
  const buffers = [
    audioBuffer(audio, 2, [audio.samples, Float32Array.of(-0.4, 0.4)]),
    audioBuffer(audio, 2, [Float32Array.of(NaN, 0.4), audio.samples]),
    audioBuffer(audio, 2, [audio.samples, Float32Array.of(Infinity, 0.4)]),
    audioBuffer(audio, 2, [audio.samples, Float32Array.of(0.4)]),
    audioBuffer(audio, 2, [audio.samples, [0.4, -0.4]]),
    audioBuffer(audio, 1, [[0.4, -0.4]]),
    { ...audioBuffer(audio), length: 1.5 },
    { ...audioBuffer(audio), length: NaN },
  ]
  for (const buffer of buffers) {
    let closes = 0
    let calls = 0
    class Context {
      async decodeAudioData() { return buffer }
      createBufferSource() { assert.fail('invalid audio must not play') }
      async close() { closes++ }
    }
    await withAudioContext(Context, async () => {
      await assert.rejects(requestCloudSpeech(options(), { fetch: async () => { calls++; return response(payload({ sampleRate: 44100, words: [], characters: [] })) } }), apiFailure('invalid_response'))
      assert.equal(calls, 1)
      assert.equal(closes, 1)
    })
  }
})

test('44.1 kHz stereo duration is bounded before copying or downmixing channel buffers', async () => {
  let reads = 0
  let closes = 0
  class Context {
    async decodeAudioData() {
      return { numberOfChannels: 2, sampleRate: 44100, length: 44100 * 30 + 1, getChannelData() { reads++; assert.fail('oversized channels must not be copied') } }
    }
    async close() { closes++ }
  }
  await withAudioContext(Context, async () => {
    await assert.rejects(requestCloudSpeech(options(), { fetch: async () => response(payload({ sampleRate: 44100, words: [], characters: [] })) }), apiFailure('invalid_response'))
    assert.equal(reads, 0)
    assert.equal(closes, 1)
  })
})

test('canceling a stalled native decode closes context promptly and never starts late audio', async () => {
  const controller = new AbortController()
  let resolveDecode
  let closes = 0
  class Context {
    async decodeAudioData() { return new Promise(resolve => { resolveDecode = resolve }) }
    createBufferSource() { assert.fail('canceled decoder must not start playback') }
    async close() { closes++ }
  }
  await withAudioContext(Context, async () => {
    const request = requestCloudSpeech(options({ signal: controller.signal }), { fetch: async () => response() })
    await settle()
    controller.abort()
    await assert.rejects(request, { name: 'AbortError' })
    assert.equal(closes, 1)
    resolveDecode(audioBuffer())
    await settle()
    assert.equal(closes, 1)
  })
})

test('canceling 44.1 kHz aligned stereo decoding ignores late buffers and alignment without retrying', async () => {
  const controller = new AbortController()
  let resolveDecode
  let reads = 0
  let closes = 0
  let calls = 0
  class Context {
    async decodeAudioData() { return new Promise(resolve => { resolveDecode = resolve }) }
    createBufferSource() { assert.fail('canceled decoder must not start playback') }
    async close() { closes++ }
  }
  await withAudioContext(Context, async () => {
    const characters = [{ text: '你', start: 0, end: 0.1 }]
    const request = requestCloudSpeech(options({ signal: controller.signal }), { fetch: async () => {
      calls++
      return response(payload({ sampleRate: 44100, words: [], characters }))
    } })
    await settle()
    controller.abort(new Error('private aligned speech cancellation'))
    await assert.rejects(request, error => {
      assert.equal(error.name, 'AbortError')
      assert.ok(!error.stack.includes('private aligned speech cancellation'))
      return true
    })
    const audio = decoded({ sampleRate: 44100 })
    resolveDecode({ ...audioBuffer(audio, 2), getChannelData() { reads++; return audio.samples } })
    await settle()
    assert.equal(reads, 0)
    assert.equal(closes, 1)
    assert.equal(calls, 1)
  })
})
