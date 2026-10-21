import assert from 'node:assert/strict'
import test from 'node:test'

import { ACTS, EMOTIONS } from '../shared/performance-cues.mjs'
import { buildMinimaxRequest, collectMinimaxStream, estimateMinimaxReservation, MAX_AUDIO_BYTES, MAX_USAGE_CHARACTERS, readMinimaxConfig, speechHealth, synthesiseMinimax } from './minimax.mjs'

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
  assert.equal(buildMinimaxRequest(config, { text: '你好', delivery: 'happy' }).voice_setting.emotion, 'happy')
  // The old name still means happy wherever it arrives.
  assert.deepEqual(buildMinimaxRequest(config, { text: '你好', delivery: 'bright' }),
    buildMinimaxRequest(config, { text: '你好', delivery: 'happy' }))
})

// The speech-2.8 mapping, one row per shared emotion: a new shared emotion
// or act fails here until MiniMax has a row for it.
const EMOTION_VOICE = {
  neutral: { speed: 1 },
  happy: { emotion: 'happy', speed: 1 },
  soft: { emotion: 'calm', speed: 0.96 },
  curious: { speed: 1 },
  surprised: { emotion: 'surprised', speed: 1 },
  sad: { emotion: 'sad', speed: 0.96 },
  pout: { speed: 1 },
  shy: { speed: 0.97 },
}
const ACT_TEXT = { laugh: '(laughs)你好', sigh: '(sighs)你好', pause: '你好' }
// voice_setting.emotion values documented for speech-2.8 (checked 2026-10-20).
const MINIMAX_28_EMOTIONS = new Set(['happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm'])

test('every shared emotion and act has a speech-2.8 mapping inside the documented ranges', () => {
  assert.deepEqual(Object.keys(EMOTION_VOICE).sort(), [...EMOTIONS].sort())
  assert.deepEqual(Object.keys(ACT_TEXT).sort(), [...ACTS].sort())
  for (const delivery of EMOTIONS) {
    const voice = buildMinimaxRequest(config, { text: '你好', delivery }).voice_setting
    const { emotion, speed } = EMOTION_VOICE[delivery]
    assert.deepEqual(voice, { voice_id: 'test-private-voice', speed, vol: 1, pitch: 0,
      ...(emotion ? { emotion } : {}) }, delivery)
    assert.ok(voice.emotion === undefined || MINIMAX_28_EMOTIONS.has(voice.emotion), delivery)
    assert.ok(voice.speed >= 0.5 && voice.speed <= 2 && Number.isInteger(voice.pitch)
      && voice.pitch >= -12 && voice.pitch <= 12, delivery)
    for (const act of ACTS) {
      const body = buildMinimaxRequest(config, { text: '你好', delivery, act })
      assert.equal(body.text, ACT_TEXT[act], `${delivery} ${act}`)
      assert.deepEqual(body.voice_setting, voice, 'an act never changes the voice settings')
      assert.equal(estimateMinimaxReservation(config, { text: '你好', delivery, act }), 2 * ACT_TEXT[act].length)
    }
  }
  for (const bad of [{ text: '你好', delivery: 'angry' }, { text: '你好', delivery: 'calm' }, { text: '你好', delivery: undefined },
    { text: '你好', delivery: 'toString' }, { text: '你好', delivery: 'neutral', act: 'cry' },
    { text: '你好', delivery: 'neutral', act: null }, { text: '你好', delivery: 'neutral', act: 'toString' },
    { text: 42, delivery: 'neutral' }, {}])
    assert.throws(() => buildMinimaxRequest(config, bad), { code: 'TTS_INVALID_REQUEST' }, JSON.stringify(bad))
})

test('literal MiniMax pause markers and official sound tags never reach the provider as syntax', () => {
  const sent = text => buildMinimaxRequest(config, { text, delivery: 'neutral' }).text
  assert.equal(sent('你好<#0.5#>呀'), '你好呀')
  assert.equal(sent('你好<# 1.2 #>呀<#x#>'), '你好呀＜#x#>', 'only "<#seconds#>" is a marker; other "<#" keeps its words, defused')
  // A PowerShell comment keeps its words instead of losing everything between "<#" and "#>".
  assert.equal(sent('注释用 <# 开头、用 #> 结尾。'), '注释用 ＜# 开头、用 #> 结尾。')
  assert.equal(sent('(laughs)真的(LAUGHS)吗( sighs )'), '真的吗')
  for (const tag of ['laughs', 'chuckle', 'coughs', 'clear-throat', 'groans', 'breath', 'pant', 'inhale', 'exhale',
    'gasps', 'sniffs', 'sighs', 'snorts', 'burps', 'lip-smacking', 'humming', 'hissing', 'emm', 'sneezes'])
    assert.equal(sent(`好(${tag})的(${tag.toUpperCase()})`), '好的', tag)
  // Removal never assembles a new working tag out of the pieces left behind.
  assert.equal(sent('好<<#1#>#0.5#>的((laughs)laughs)呀'), '好的呀')
  // Ordinary parentheses keep their words but turn full width, one for one
  // (half-width bracket pinyin is performed); other brackets and non-tag
  // words stay as written.
  assert.equal(sent('他(笑)说(smiles)[laughs]《书》#5#'), '他（笑）说（smiles）[laughs]《书》#5#')
  assert.equal(sent('a<b#>c'), 'a<b#>c')
  // The trusted tag is added after the literal is neutralised, never inside it.
  assert.equal(buildMinimaxRequest(config, { text: '(sighs)好<#1#>', delivery: 'sad', act: 'laugh' }).text, '(laughs)好')
  for (const text of ['(laughs)', '<#0.5#>', ' (sighs) ', '<<#1#>#2#>'])
    assert.throws(() => buildMinimaxRequest(config, { text, delivery: 'neutral', act: 'laugh' }), { code: 'TTS_INVALID_REQUEST' })
})

test('subtitles are bounded by the text actually sent, act tag included', async () => {
  // '(laughs)你好！' is 11 UTF-16 units; the visible sentence is only 3.
  const tagged = { text: '(laughs)你好！', text_begin: 0, text_end: 11, time_begin: 0, time_end: 900,
    timestamped_words: [word('(laughs)', 0, 8, 0, 300), word('你', 8, 9, 300, 500), word('好', 9, 10, 500, 700),
      word('！', 10, 11, 700, 900)] }
  const frames = [{ ...chunk(mp3.toString('hex'), 2, { subtitle: tagged }), extra_info: finalInfo }]
  let body
  const result = await synthesiseMinimax(config, { text: '你好！', delivery: 'happy', act: 'laugh' }, {
    fetchImpl: async (url, options) => {
      body = JSON.parse(options.body)
      return new Response(stream(frames), { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  assert.equal(body.text, '(laughs)你好！')
  assert.equal(result.words.length, 4)
  // Without the act the same subtitle runs past the sent text and fails.
  await assert.rejects(synthesiseMinimax(config, { text: '你好！', delivery: 'happy' }, {
    fetchImpl: async () => new Response(stream(frames), { headers: { 'content-type': 'text/event-stream' } }),
  }), { code: 'TTS_UPSTREAM_INVALID' })
  // An invalid request is refused before any fetch.
  let fetched = false
  await assert.rejects(synthesiseMinimax(config, { text: '你好', delivery: 'angry' }, {
    fetchImpl: async () => { fetched = true },
  }), { code: 'TTS_INVALID_REQUEST' })
  assert.equal(fetched, false)
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

test('a real speech-2.8 stream: replayed cumulative subtitles and an aggregate size larger than the chunks', async () => {
  // Captured 2026-10-20 from api.minimax.cn (speech-2.8-hd, 13 characters).
  const { readFile } = await import('node:fs/promises')
  const raw = await readFile(new URL('./fixtures/minimax-2.8-cumulative.sse', import.meta.url), 'utf8')
  const result = await collectMinimaxStream(new Response(raw).body, { textLength: 13 })
  assert.equal(Buffer.from(result.audio, 'base64').length, 49_005)
  assert.equal(result.words.length, 13, 'the word timings survive the last update that had none')
  assert.equal(result.wordAlignmentAvailable, true)
  assert.deepEqual(result.usage, { billableCharacters: 24, textCharacters: 13 })
  // Streaming updates must still only grow.
  const shrinking = raw.replace('"time_end":1194.6666666666665', '"time_end":100')
  await assert.rejects(collectMinimaxStream(new Response(shrinking).body, { textLength: 13 }), { code: 'TTS_UPSTREAM_INVALID' })
})

test('a second real stream: three cumulative snapshots of one sentence, the last one kept', async () => {
  // Captured 2026-10-20 (speech-2.8-hd, happy, '我们先从第一条开始吧。'): the
  // sentence that failed once in the audition and then came back clean.
  const { readFile } = await import('node:fs/promises')
  const raw = await readFile(new URL('./fixtures/minimax-2.8-happy-short.sse', import.meta.url), 'utf8')
  const result = await collectMinimaxStream(new Response(raw).body, { textLength: 11 })
  assert.equal(Buffer.from(result.audio, 'base64').length, 35_757)
  assert.equal(result.words.length, 11)
  assert.ok(result.words.at(-1).end <= 2.136)
  assert.deepEqual(result.usage, { billableCharacters: 21, textCharacters: 11 })
})

test('each failure names its check for local diagnosis, never with upstream text or to visitors', async () => {
  const reason = async (body) => {
    const error = await collectMinimaxStream(body, { textLength: 3 }).then(() => null, error => error)
    assert.equal(error?.code, 'TTS_UPSTREAM_INVALID')
    return error.detail
  }
  const modified = (change) => { const frames = fixture(); change(frames); return stream(frames) }
  assert.equal(await reason(modified(frames => { frames[0].base_resp = { status_code: 1039, status_msg: 'test-secret-key 你好！' } })), 'status-code-1039')
  assert.equal(await reason(modified(frames => { frames[1].base_resp = { status_code: 1002, status_msg: 'test-secret-key' } })), 'status-code-1002',
    'a rate limit after audio has arrived is a broken stream, not a refusal')
  assert.equal(await reason(modified(frames => { frames[2].extra_info = { ...finalInfo, audio_size: mp3.length + 5_000 } })),
    `audio-size streamed=${mp3.length} reported=${mp3.length + 5_000}`)
  assert.equal(await reason(stream(fixture().slice(0, 2))), 'no-final-event')
  assert.equal(await reason(modified(frames => { frames[1].data.subtitle.time_begin = 5 })), 'subtitle-time-begin-changed')
  assert.equal(await reason(modified(frames => { frames[1].data.subtitle = frames[0].data.subtitle; frames[0].data.subtitle = segment([word('你', 0, 1, 0, 600)]) })),
    'subtitle-shrank-while-streaming')
  assert.equal(await reason(byteStream(Buffer.from([0x64, 0x61, 0x74, 0x61, 0x3a, 0xff, 0x0a, 0x0a]))), 'not-utf8')

  // MiniMax sends rate limits and similar errors as a 200 JSON body.
  const refused = status_code => synthesiseMinimax(config, { text: '你好！', delivery: 'neutral' }, {
    fetchImpl: async () => new Response(JSON.stringify({ base_resp: { status_code, status_msg: 'test-secret-key 你好！' } }),
      { headers: { 'content-type': 'application/json' } }),
  }).then(() => null, error => error)
  const limited = await refused(1002)
  assert.deepEqual([limited.code, limited.detail], ['TTS_UPSTREAM_RATE_LIMITED', 'status-code-1002'])
  for (const code of [1039, 2045, 1008]) {
    const other = await refused(code)
    assert.deepEqual([other.code, other.detail], ['TTS_UPSTREAM_INVALID', `status-code-${code}`], 'only 1002 is a rate limit')
  }
  const http = await synthesiseMinimax(config, { text: '你好！', delivery: 'neutral' }, {
    fetchImpl: async () => new Response('test-secret-key', { status: 429 }),
  }).then(() => null, error => error)
  assert.deepEqual([http.code, http.detail], ['TTS_UPSTREAM_FAILED', 'http-429'])

  const { speechErrorResponse } = await import('./speech.mjs')
  assert.deepEqual(Object.keys(speechErrorResponse(limited)).sort(), ['code', 'message', 'status'])
  assert.deepEqual([speechErrorResponse(limited).status, speechErrorResponse(limited).code], [429, 'TTS_UPSTREAM_RATE_LIMITED'])
  assert.doesNotMatch(JSON.stringify(speechErrorResponse(limited)), /status-code|1002|secret|你好|RPM/)
})

test('a 1002 in the first stream event is a rate-limit refusal with no provider text', async () => {
  const frames = [{ base_resp: { status_code: 1002, status_msg: 'rate limit exceeded(RPM) test-secret-key' } }]
  const error = await synthesiseMinimax(config, { text: '你好！', delivery: 'neutral' }, {
    fetchImpl: async () => new Response(stream(frames), { headers: { 'content-type': 'text/event-stream' } }),
  }).then(() => null, caught => caught)
  assert.deepEqual([error?.code, error?.detail], ['TTS_UPSTREAM_RATE_LIMITED', 'status-code-1002'])
  assert.doesNotMatch(`${error.message} ${error.detail}`, /secret|RPM/)
})

test('half-width brackets in the words are never performed as inline pinyin; the act tag stays half width', () => {
  const sent = (text, act) => buildMinimaxRequest(config, { text, delivery: 'neutral', ...(act ? { act } : {}) }).text
  assert.equal(sent('这是(he2)平'), '这是（he2）平')
  assert.equal(sent('这是(he2)平').length, '这是(he2)平'.length, 'subtitle offsets are unchanged')
  assert.equal(sent('(ri4)(he2)'), '（ri4）（he2）')
  assert.equal(sent('))(('), '））（（')
  // Already full width, or no brackets at all: sent as written.
  assert.equal(sent('这是（he2）平，不是（huo4）面。'), '这是（he2）平，不是（huo4）面。')
  assert.equal(sent('你好'), '你好')
  // Sound tags are still removed first, and the server's own tag stays syntax.
  assert.equal(sent('(laughs)他(笑)了', 'laugh'), '(laughs)他（笑）了')
  assert.equal(sent('好(sighs)呀(呀)', 'sigh'), '(sighs)好呀（呀）')
})

test('a dictionary rule is sent only when its key occurs in the words, in table order', () => {
  const body = (text, selected = config, act) => buildMinimaxRequest(selected, { text, delivery: 'neutral', ...(act ? { act } : {}) })
  assert.deepEqual(config.pronunciation, ['日和/(ri4)(he2)', 'Hiyori/(ri4)(he2)'])
  assert.ok(Object.isFrozen(config.pronunciation))
  // Without a match the body is exactly what it was before the dictionary.
  const plain = body('你好')
  assert.equal(Object.hasOwn(plain, 'pronunciation_dict'), false)
  assert.deepEqual(Object.keys(plain), ['model', 'text', 'stream', 'stream_options', 'voice_setting', 'audio_setting',
    'language_boost', 'subtitle_enable', 'subtitle_type'])
  assert.equal(JSON.stringify(plain), JSON.stringify(body('你好', { ...config, pronunciation: [] })))
  // Only the matched rules, in table order, whatever order the words use.
  assert.deepEqual(body('我是日和').pronunciation_dict, { tone: ['日和/(ri4)(he2)'] })
  assert.deepEqual(body('Hiyori，也就是日和').pronunciation_dict, { tone: ['日和/(ri4)(he2)', 'Hiyori/(ri4)(he2)'] })
  assert.deepEqual(body('大家好，我是HIYORI。').pronunciation_dict, { tone: ['Hiyori/(ri4)(he2)'] })
  assert.equal(body('我是日和').text, '我是日和', 'the words themselves are never rewritten')
  const custom = { ...config, pronunciation: ['弹幕/(dan4)(mu4)', '日和/(ri4)(he2)', 'bad rule', 42, '卡壳/(qia3)(ke2)'] }
  assert.deepEqual(body('卡壳了，弹幕好多', custom).pronunciation_dict, { tone: ['弹幕/(dan4)(mu4)', '卡壳/(qia3)(ke2)'] })
  assert.equal(Object.hasOwn(body('日和', { ...config, pronunciation: ['日和/(ri4)', '日和 /(ri4)(he2)'] }), 'pronunciation_dict'), false,
    'invalid rules are never sent')
  // The act tag is never matched, only the words.
  const tags = { ...config, pronunciation: ['laughs/(la1)(fu5)', 'sighs/(sai1)'] }
  for (const act of ACTS)
    assert.equal(Object.hasOwn(body('你好', tags, act), 'pronunciation_dict'), false, act)
  assert.deepEqual(body('他说laughs', tags, 'laugh').pronunciation_dict, { tone: ['laughs/(la1)(fu5)'] })
  // A key written in removed MiniMax syntax is gone before matching.
  assert.equal(Object.hasOwn(body('好(sighs)的', tags), 'pronunciation_dict'), false)
})

test('MINIMAX_PRONUNCIATION=0 and a config without the field send no dictionary', () => {
  const off = readMinimaxConfig({ ...env, MINIMAX_PRONUNCIATION: '0' })
  assert.deepEqual(off.pronunciation, [])
  assert.equal(off.configured, true)
  for (const value of ['1', '', ' 0', 'off'])
    assert.deepEqual(readMinimaxConfig({ ...env, MINIMAX_PRONUNCIATION: value }).pronunciation, config.pronunciation, value)
  const { pronunciation, ...bare } = config
  assert.ok(pronunciation.length)
  for (const selected of [off, bare, { voiceId: 'v', model: 'speech-2.8-hd' }, { ...config, pronunciation: '日和/(ri4)(he2)' }]) {
    const body = buildMinimaxRequest(selected, { text: '我是日和，也叫Hiyori。', delivery: 'neutral' })
    assert.equal(Object.hasOwn(body, 'pronunciation_dict'), false)
    assert.equal(estimateMinimaxReservation(selected, { text: '我是日和，也叫Hiyori。', delivery: 'neutral' }), 2 * 14)
  }
})

test('the reservation adds the characters of the rules sent', () => {
  const rule = '日和/(ri4)(he2)'
  assert.equal(estimateMinimaxReservation(config, { text: '你好', delivery: 'neutral' }), 2 * 2)
  assert.equal(estimateMinimaxReservation(config, { text: '我是日和', delivery: 'neutral' }), 2 * (4 + rule.length))
  assert.equal(estimateMinimaxReservation(config, { text: '日和日和', delivery: 'neutral' }), 2 * (4 + rule.length), 'once per rule')
  assert.equal(estimateMinimaxReservation(config, { text: '我是日和', delivery: 'happy', act: 'laugh' }),
    2 * ('(laughs)我是日和'.length + rule.length))
  assert.equal(estimateMinimaxReservation(config, { text: '日和和Hiyori', delivery: 'neutral' }),
    2 * (9 + rule.length + 'Hiyori/(ri4)(he2)'.length))
})

test('the subtitle bound is relaxed to the substituted length only when a rule was sent', async () => {
  // '我是日和' is 4 units sent; with 日和 → (ri4)(he2) it would be 12.
  const subtitled = textEnd => [{ ...chunk(mp3.toString('hex'), 2, { subtitle: { text: '我是日和', text_begin: 0,
    text_end: textEnd, time_begin: 0, time_end: 900, timestamped_words: [word('我', 0, 1, 0, 300), word('是', 1, 2, 300, 500),
      word('日和', 2, textEnd, 500, 900)] } }), extra_info: finalInfo }]
  const synthesise = (selected, textEnd, request = { text: '我是日和', delivery: 'neutral' }) => {
    const sent = []
    return synthesiseMinimax(selected, request, {
      fetchImpl: async (url, options) => {
        sent.push(JSON.parse(options.body))
        return new Response(stream(subtitled(textEnd)), { headers: { 'content-type': 'text/event-stream' } })
      },
    }).then(result => ({ result, sent }), error => ({ error, sent }))
  }
  const relaxed = await synthesise(config, 12)
  assert.deepEqual(relaxed.sent[0].pronunciation_dict, { tone: ['日和/(ri4)(he2)'] })
  assert.equal(relaxed.result.words.length, 3)
  assert.equal((await synthesise(config, 4)).result.words.length, 3, 'offsets into the sent text still pass')
  // Past even the substituted text, or without a rule sent, it still fails.
  assert.equal((await synthesise(config, 13)).error?.detail, 'subtitle-shape')
  const off = readMinimaxConfig({ ...env, MINIMAX_PRONUNCIATION: '0' })
  const strict = await synthesise(off, 12)
  assert.equal(Object.hasOwn(strict.sent[0], 'pronunciation_dict'), false)
  assert.deepEqual([strict.error?.code, strict.error?.detail], ['TTS_UPSTREAM_INVALID', 'subtitle-shape'])
  assert.equal((await synthesise(config, 12, { text: '我是小和', delivery: 'neutral' })).error?.detail, 'subtitle-shape')
  assert.equal((await synthesise(off, 4)).result.words.length, 3)
})

test('real speech-2.8 streams: a joined two-sentence clip with a laugh, and a pronunciation rule', async () => {
  // Captured 2026-10-20 (UTC) by scripts/minimax-p5b-check.mjs on speech-2.8-hd.
  const { readFile } = await import('node:fs/promises')
  const joined = await readFile(new URL('./fixtures/minimax-2.8-joined-laugh.sse', import.meta.url), 'utf8')
  const sent = buildMinimaxRequest(config, { text: '这个梗我接住了！你们今天弹幕好热闹。', delivery: 'happy', act: 'laugh' }).text
  assert.equal(sent, '(laughs)这个梗我接住了！你们今天弹幕好热闹。')
  const clip = await collectMinimaxStream(new Response(joined).body, { textLength: sent.length })
  assert.equal(clip.words.length, 19, 'the laugh tag is timed as a word before the 18 characters')
  assert.equal(clip.words[0].text, '(laughs)')
  assert.deepEqual(clip.usage, { billableCharacters: 42, textCharacters: 26 }, 'the tag is billed like 8 Latin characters')
  // Hiyori/(ri4)(he2): offsets still index the text as sent, and the rule
  // added nothing to billing (5 Han x 2 + 2 marks + 6 letters = 18).
  const named = await readFile(new URL('./fixtures/minimax-2.8-pronunciation.sse', import.meta.url), 'utf8')
  const result = await collectMinimaxStream(new Response(named).body, { textLength: '大家好，我是Hiyori。'.length })
  assert.deepEqual(result.usage, { billableCharacters: 18, textCharacters: 13 })
  assert.ok(result.words.some(word => word.text === 'Hiyori'))
})
