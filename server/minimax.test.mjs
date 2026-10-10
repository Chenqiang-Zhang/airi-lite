import assert from 'node:assert/strict'
import test from 'node:test'

import { buildMinimaxRequest, collectMinimaxStream, MAX_AUDIO_BYTES, MAX_USAGE_CHARACTERS, readMinimaxConfig, speechHealth, synthesiseMinimax } from './minimax.mjs'

const env = {
  MINIMAX_TTS_ENABLED: '1', MINIMAX_API_KEY: 'test-secret-key', MINIMAX_VOICE_ID: 'test-private-voice',
  MINIMAX_TTS_DAILY_CHAR_LIMIT: '1000',
}
const config = readMinimaxConfig(env)
// Structural fake MPEG-1 Layer III frames, NOT decoded audio or provider output.
// Browser/client tests own decoder and audible-signal validation separately.
const mp3 = Buffer.alloc(576 * 28)
for (let offset = 0; offset < mp3.length; offset += 576)
  Buffer.from([0xff, 0xfb, 0x98, 0xc0]).copy(mp3, offset)
const word = (text, begin, end, timeBegin, timeEnd) => ({
  word: text, word_begin: begin, word_end: end, time_begin: timeBegin, time_end: timeEnd,
})
const segment = (words = [word('你', 0, 1, 0, 200)]) => ({
  text: '你好', text_begin: 0, text_end: 2, time_begin: 0,
  time_end: words.at(-1)?.time_end ?? 500, timestamped_words: words,
})
const finalInfo = { audio_format: 'mp3', audio_sample_rate: 32_000, audio_channel: 1, audio_size: mp3.length, audio_length: 1_000 }
const chunk = (audio, status = 1, other = {}) => ({ base_resp: { status_code: 0 }, data: { audio, status, ...other } })
function fixture() {
  const first = segment()
  const second = segment([word('你', 0, 1, 0, 200), word('好', 1, 2, 200, 500)])
  const third = { text: '！', text_begin: 2, text_end: 3, time_begin: 600, time_end: 900,
    timestamped_words: [word('！', 2, 3, 600, 900)] }
  return [chunk(mp3.subarray(0, 8_000).toString('hex'), 1, { subtitle: first }),
    chunk(mp3.subarray(8_000).toString('hex'), 1, { subtitle: second }),
    { ...chunk('', 2, { subtitle: third, subtitles: [second, third] }), extra_info: finalInfo }]
}
function stream(frames, { suffix = '', width = 257 } = {}) {
  const content = Buffer.from(frames.map(frame => `data: ${JSON.stringify(frame)}\r\n\r\n`).join('') + suffix)
  return byteStream(content, width)
}
function byteStream(content, width = 257) {
  let offset = 0
  return new ReadableStream({
    pull(controller) {
      if (offset === content.length)
        return controller.close()
      controller.enqueue(content.subarray(offset, offset + width))
      offset = Math.min(content.length, offset + width)
    },
  })
}

test('activation requires the explicit switch, credentials, fixed region/model and positive integer budget', () => {
  assert.deepEqual(speechHealth(readMinimaxConfig({})),
    { configured: false, provider: 'minimax', model: 'speech-2.8-turbo', region: 'cn' })
  assert.equal(config.configured, true)
  assert.equal(config.region, 'cn')
  assert.equal(config.endpoint, 'https://api.minimax.cn/v1/t2a_v2')
  for (const key of ['MINIMAX_TTS_ENABLED', 'MINIMAX_API_KEY', 'MINIMAX_VOICE_ID', 'MINIMAX_TTS_DAILY_CHAR_LIMIT']) {
    const invalid = { ...env }
    delete invalid[key]
    assert.equal(readMinimaxConfig(invalid).configured, false)
  }
  for (const dailyLimit of ['0', '-1', '2.5', '1e3', 'Infinity', '999999999999999999999999'])
    assert.equal(readMinimaxConfig({ ...env, MINIMAX_TTS_DAILY_CHAR_LIMIT: dailyLimit }).configured, false)
  for (const region of ['international', 'https://127.0.0.1', '__proto__', 'GLOBAL',
    'https://api.minimax.io/v1/t2a_v2', 'global/../../cn']) {
    assert.equal(readMinimaxConfig({ ...env, MINIMAX_TTS_REGION: region }).configured, false)
    assert.equal(readMinimaxConfig({ ...env, MINIMAX_TTS_REGION: region }).region, null)
    assert.equal(readMinimaxConfig({ ...env, MINIMAX_TTS_REGION: region }).endpoint, null)
    assert.equal(speechHealth(readMinimaxConfig({ ...env, MINIMAX_TTS_REGION: region })).region, null)
  }
  const international = readMinimaxConfig({ ...env, MINIMAX_TTS_REGION: ' global ' })
  assert.equal(international.configured, true)
  assert.equal(international.region, 'global')
  assert.equal(international.endpoint, 'https://api.minimax.io/v1/t2a_v2')
  assert.deepEqual(speechHealth(international),
    { configured: true, provider: 'minimax', model: 'speech-2.8-turbo', region: 'global' })
  assert.equal(readMinimaxConfig({ ...env, MINIMAX_TTS_MODEL: 'speech-02-hd' }).configured, false)
  assert.equal(readMinimaxConfig({ ...env, MINIMAX_TTS_MODEL: 'speech-2.8-hd' }).configured, true)
  assert.equal(JSON.stringify(speechHealth(config)).includes('test-'), false)
})

test('outgoing payload fixes identity/audio and uses emotion omission for automatic delivery', () => {
  const neutral = buildMinimaxRequest(config, { text: '你好', delivery: 'neutral', model: 'injected', voiceId: 'injected' })
  assert.equal(neutral.voice_setting.voice_id, 'test-private-voice')
  assert.equal(neutral.model, 'speech-2.8-turbo')
  assert.equal(neutral.text, '你好')
  assert.equal(neutral.stream, true)
  assert.deepEqual(neutral.stream_options, { exclude_aggregated_audio: true })
  assert.deepEqual(neutral.audio_setting, { sample_rate: 32_000, bitrate: 128_000, format: 'mp3', channel: 1 })
  assert.equal(neutral.subtitle_type, 'word_streaming')
  assert.equal(neutral.subtitle_enable, true)
  assert.equal(neutral.voice_setting.emotion, undefined)
  assert.equal(buildMinimaxRequest(config, { text: '你好', delivery: 'curious' }).voice_setting.emotion, undefined)
  assert.equal(buildMinimaxRequest(config, { text: '你好', delivery: 'soft' }).voice_setting.emotion, 'calm')
  assert.equal(buildMinimaxRequest(config, { text: '你好', delivery: 'bright' }).voice_setting.emotion, 'happy')
})

test('invalid header keys and malformed/bounded voice IDs disable health before reserving spend', () => {
  for (const key of ['', ' key', 'key ', 'bad key', 'bad\tkey', 'bad\nkey', 'bad\u0000key', 'bad\u007fkey',
    'key中文', 'key£', 'a'.repeat(4_097)])
    assert.equal(speechHealth(readMinimaxConfig({ ...env, MINIMAX_API_KEY: key })).configured, false)
  assert.equal(readMinimaxConfig({ ...env, MINIMAX_API_KEY: 'A'.repeat(4_096) }).configured, true)
  for (const voice of ['', '  ', '\ud800', 'voice\u0000', 'voice\n', 'voice\u007f', 'voice\u0085', 'a'.repeat(257)])
    assert.equal(speechHealth(readMinimaxConfig({ ...env, MINIMAX_VOICE_ID: voice })).configured, false)
  for (const voice of ['自定義音色', '😀'.repeat(128), 'a'.repeat(256)])
    assert.equal(readMinimaxConfig({ ...env, MINIMAX_VOICE_ID: voice }).configured, true)
})

test('collects bounded MP3 once, replaces cumulative same-segment words, and uses clip seconds', async () => {
  const result = await collectMinimaxStream(stream(fixture(), { suffix: 'data: [DONE]\n\n' }), { textLength: 3 })
  assert.equal(result.audio, mp3.toString('base64'))
  assert.equal(result.format, 'mp3')
  assert.equal(result.sampleRate, 32_000)
  assert.equal(result.wordAlignmentAvailable, true)
  assert.deepEqual(result.words, [{ text: '你', start: 0, end: 0.2 },
    { text: '好', start: 0.2, end: 0.5 }, { text: '！', start: 0.6, end: 0.9 }])
  assert.equal(Object.hasOwn(result, 'usage'), false)
})

test('optional final usage is factual and bounded; absent billable usage is never guessed from text', async () => {
  for (const [metadata, usage] of [
    [{ usage_characters: 0, word_count: 0 }, { billableCharacters: 0, textCharacters: 0 }],
    [{ usage_characters: 12, word_count: 3 }, { billableCharacters: 12, textCharacters: 3 }],
    [{ usage_characters: MAX_USAGE_CHARACTERS }, { billableCharacters: MAX_USAGE_CHARACTERS }],
    [{ usage_characters: 1, word_count: MAX_USAGE_CHARACTERS },
      { billableCharacters: 1, textCharacters: MAX_USAGE_CHARACTERS }],
    [{ word_count: 3 }, undefined],
    [{}, undefined],
  ]) {
    const frames = fixture()
    frames[0].extra_info = { usage_characters: 'ignored intermediate field' }
    frames[2].extra_info = { ...finalInfo, ...metadata }
    const result = await collectMinimaxStream(stream(frames), { textLength: 3 })
    assert.deepEqual(result.usage, usage)
    assert.equal(Object.hasOwn(result, 'usage'), usage !== undefined)
  }
})

test('malformed optional final usage fields fail closed rather than report guessed charges', async () => {
  for (const field of ['usage_characters', 'word_count']) {
    for (const value of [-1, 0.5, '12', null, true, [], {}, MAX_USAGE_CHARACTERS + 1,
      Number.MAX_SAFE_INTEGER + 1, Infinity]) {
      const frames = fixture()
      frames[2].extra_info = { ...finalInfo, [field]: value }
      await assert.rejects(collectMinimaxStream(stream(frames), { textLength: 3 }),
        { code: 'TTS_UPSTREAM_INVALID' })
    }
  }
})

test('zero-duration words are omitted without expanding timestamps; backward words still fail', async () => {
  const frames = fixture()
  frames[1].data.subtitle.timestamped_words[1].time_end = 200
  const result = await collectMinimaxStream(stream(frames), { textLength: 3 })
  assert.deepEqual(result.words, [{ text: '你', start: 0, end: 0.2 }, { text: '！', start: 0.6, end: 0.9 }])
  assert.equal(result.wordAlignmentAvailable, true)
  frames[1].data.subtitle.timestamped_words[1].time_begin = 250
  await assert.rejects(collectMinimaxStream(stream(frames), { textLength: 3 }))
})

test('word alignment availability distinguishes accepted empty/all-zero arrays from absent metadata', async () => {
  for (const timestampedWords of [undefined, null, [], [word('你', 0, 1, 200, 200)]]) {
    const subtitle = { text: '你', text_begin: 0, text_end: 1, time_begin: 0, time_end: 500,
      ...(timestampedWords === undefined ? {} : { timestamped_words: timestampedWords }) }
    const result = await collectMinimaxStream(stream([{ ...chunk(mp3.toString('hex'), 2, { subtitle }),
      extra_info: finalInfo }]), { textLength: 1 })
    assert.deepEqual(result.words, [], 'zero intervals remain omitted; none are expanded or guessed')
    assert.equal(Object.hasOwn(result, 'wordAlignmentAvailable'), Array.isArray(timestampedWords))
    assert.equal(result.wordAlignmentAvailable, Array.isArray(timestampedWords) ? true : undefined)
  }
})

test('accepts bounded optional ID3 tags and odd-byte MP3; rejects changed frame contract and truncated audio', async () => {
  const tagged = Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 1, 0]), mp3])
  const frames = [{ ...chunk(tagged.toString('hex'), 2), extra_info: { ...finalInfo, audio_size: tagged.length } }]
  assert.equal(tagged.length % 2, 1)
  const result = await collectMinimaxStream(stream(frames), { textLength: 3 })
  assert.equal(result.audio, tagged.toString('base64'))
  const fakeHeader = Buffer.from(tagged)
  fakeHeader[0] |= 0x80
  const fakeTrailer = Buffer.concat([mp3, Buffer.from([0xd4, 0x41, 0x47]), Buffer.alloc(125)])
  for (const invalid of [fakeHeader, fakeTrailer])
    await assert.rejects(collectMinimaxStream(stream([{ ...chunk(invalid.toString('hex'), 2),
      extra_info: { ...finalInfo, audio_size: invalid.length } }]), { textLength: 3 }))
  for (const change of [audio => { audio[1] = 0xf3 }, audio => { audio[1] = 0xfd },
    audio => { audio[2] = 0x90 }, audio => { audio[3] = 0 }]) {
    const audio = Buffer.from(mp3)
    change(audio)
    await assert.rejects(collectMinimaxStream(stream([{ ...chunk(audio.toString('hex'), 2), extra_info: finalInfo }]),
      { textLength: 3 }))
  }
  const truncated = mp3.subarray(0, mp3.length - 1)
  await assert.rejects(collectMinimaxStream(stream([{ ...chunk(truncated.toString('hex'), 2),
    extra_info: { ...finalInfo, audio_size: truncated.length } }]), { textLength: 3 }))
})

test('no subtitle produces empty words and unsafe subtitle_file is never fetched', async () => {
  const frames = fixture().map(frame => ({ ...frame, data: { audio: frame.data.audio, status: frame.data.status,
    subtitle_file: 'http://127.0.0.1/private' } }))
  let calls = 0
  const result = await synthesiseMinimax(config, { text: '你好！', delivery: 'neutral' }, {
    fetchImpl: async (url, options) => {
      calls++
      assert.equal(url, 'https://api.minimax.cn/v1/t2a_v2')
      assert.equal(options.redirect, 'error')
      assert.equal(options.headers.Authorization, 'Bearer test-secret-key')
      return new Response(stream(frames), { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  assert.equal(calls, 1)
  assert.deepEqual(result.words, [])
  assert.equal(Object.hasOwn(result, 'wordAlignmentAvailable'), false)
})

test('international requests use only the pinned endpoint and reject config host/region overrides', async () => {
  const international = readMinimaxConfig({ ...env, MINIMAX_TTS_REGION: 'global' })
  let calls = 0
  const fetchImpl = async (url, options) => {
    calls++
    assert.equal(url, 'https://api.minimax.io/v1/t2a_v2')
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers.Authorization, 'Bearer test-secret-key')
    assert.equal(JSON.parse(options.body).voice_setting.voice_id, 'test-private-voice')
    return new Response(stream(fixture()), { headers: { 'content-type': 'text/event-stream' } })
  }
  const result = await synthesiseMinimax(international,
    { text: '你好！', delivery: 'neutral', endpoint: 'https://attacker.invalid' }, { fetchImpl })
  assert.equal(result.audio, mp3.toString('base64'))
  assert.equal(calls, 1)
  for (const invalid of [{ ...international, endpoint: 'https://attacker.invalid' },
    { ...international, endpoint: 'https://api.minimax.cn/v1/t2a_v2' },
    { ...international, region: null }, { ...international, region: 'international' },
    { ...international, region: new String('global') }, { ...international, model: 'unsupported-model' }]) {
    assert.equal(speechHealth(invalid).configured, false)
    await assert.rejects(synthesiseMinimax(invalid, { text: '你好！', delivery: 'neutral' }, { fetchImpl }),
      { code: 'TTS_NOT_CONFIGURED' })
  }
  assert.equal(calls, 1)
})

test('rejects provider errors, malformed/truncated streams, missing final/audio and invalid format/duration', async () => {
  const cases = []
  const modify = (change) => { const frames = fixture(); change(frames); cases.push(stream(frames)) }
  modify(frames => { frames[0].base_resp = { status_code: 1004, status_msg: 'test-secret-key 你好！' } })
  modify(frames => { frames[0].data.status = 3 })
  modify(frames => { frames[0].data.audio = 'garbage' })
  modify(frames => { frames[0].data.audio = '00f' })
  modify(frames => { frames[2].extra_info = { ...finalInfo, audio_format: 'pcm' } })
  modify(frames => { frames[2].extra_info = { ...finalInfo, audio_sample_rate: 24_000 } })
  modify(frames => { frames[2].extra_info = { ...finalInfo, audio_channel: 2 } })
  modify(frames => { frames[2].extra_info = { ...finalInfo, audio_size: 1 } })
  modify(frames => { frames[2].extra_info = { ...finalInfo, audio_length: 30_001 } })
  modify(frames => { frames[2].extra_info = { ...finalInfo, audio_length: 0 } })
  modify(frames => { frames[2].extra_info = undefined })
  modify(frames => { frames.forEach(frame => { frame.data.audio = '' }) })
  modify(frames => { frames[0].data.audio = Buffer.alloc(8_000).toString('hex'); frames[1].data.audio = Buffer.alloc(mp3.length - 8_000).toString('hex') })
  modify(frames => { frames[0].data.audio = '0000' + frames[0].data.audio; frames[2].extra_info = { ...finalInfo, audio_size: mp3.length + 2 } })
  modify(frames => { frames[1].data.subtitle.timestamped_words[1].time_end = 10_000 })
  modify(frames => { frames[2].data.subtitle.time_end = 1_100; frames[2].data.subtitle.timestamped_words[0].time_end = 1_100 })
  modify(frames => { frames[0].data.subtitle.timestamped_words[0].time_begin = -1 })
  modify(frames => { frames[0].data.subtitle.text_end = 500 })
  modify(frames => { frames[0].data.subtitle.timestamped_words[0].word_end = 4 })
  modify(frames => { frames[0].data.subtitle.timestamped_words[0].word = ' \t\n' })
  cases.push(stream(fixture().slice(0, 2)))
  cases.push(stream(fixture(), { suffix: 'data: {"data":' }))
  cases.push(stream(fixture(), { suffix: 'data: {}\n\n' }))
  cases.push(byteStream(Buffer.from('data: {oops}\n\n')))
  cases.push(byteStream(Buffer.from('data: [DONE]\n\n')))
  cases.push(byteStream(Buffer.from('data: {"base_resp":{"status_code":0},"data":{"status":2}}')))
  for (const body of cases) {
    await assert.rejects(collectMinimaxStream(body, { textLength: 3 }), error => {
      assert.equal(error.message.includes('test-secret-key'), false)
      assert.equal(error.message.includes('你好'), false)
      return /^TTS_UPSTREAM_/.test(error.code)
    })
  }
})

test('bounds MP3, individual event size, total stream bytes and number of events', async () => {
  await assert.rejects(collectMinimaxStream(stream([chunk(Buffer.alloc(MAX_AUDIO_BYTES + 1).toString('hex'))], { width: 1_000_000 }),
    { textLength: 3 }))
  await assert.rejects(collectMinimaxStream(byteStream(Buffer.from(`data: ${'x'.repeat(4_500_001)}\n\n`), 1_000_000),
    { textLength: 3 }))
  await assert.rejects(collectMinimaxStream(byteStream(Buffer.from(`${':'.repeat(3_000_000)}\n${':'.repeat(3_000_000)}\n`), 1_000_000),
    { textLength: 3 }))
  await assert.rejects(collectMinimaxStream(stream(Array(2_049).fill(chunk(''))), { textLength: 3 }))
})

test('abort cancels stalled upstream reading and HTTP/mime errors do not relay provider details', async () => {
  let cancelled = false
  const controller = new AbortController()
  const pending = collectMinimaxStream(new ReadableStream({ cancel() { cancelled = true } }), {
    textLength: 3, signal: controller.signal,
  })
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(cancelled, true)
  for (const response of [new Response('test-secret-key 你好！', { status: 401 }),
    new Response('test-secret-key 你好！', { headers: { 'content-type': 'application/json' } })]) {
    await assert.rejects(synthesiseMinimax(config, { text: '你好！', delivery: 'neutral' }, {
      fetchImpl: async () => response,
    }), error => !error.message.includes('test-secret-key') && !error.message.includes('你好'))
  }
})

test('a non-settling body cancellation does not block stream abort or provider-error cleanup', async () => {
  const controller = new AbortController()
  const pending = collectMinimaxStream(new ReadableStream({ cancel: () => new Promise(() => {}) }), {
    textLength: 3, signal: controller.signal,
  })
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  const response = new Response(new ReadableStream({ cancel: () => new Promise(() => {}) }), { status: 500 })
  await assert.rejects(synthesiseMinimax(config, { text: '你好！', delivery: 'neutral' }, {
    fetchImpl: async () => response,
  }), { code: 'TTS_UPSTREAM_FAILED' })
})
