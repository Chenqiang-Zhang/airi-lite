import assert from 'node:assert/strict'
import test from 'node:test'

import { collectMinimaxStream } from '../server/minimax.mjs'
import { canDecodeCloudSpeech, decodeCloudSpeechResponse, SpeechApiError } from './cloud-speech.ts'
import { createSpeechController } from './speech.ts'

// Same media model as src/speech.test.mjs: a stub <audio> whose playback the
// test advances explicitly. No real audio, network, model or provider.
class AudioStub extends EventTarget {
  paused = true
  currentTime = 0
  src = ''
  ended = false
  error = null
  readyState = 4
  seeking = false
  get currentSrc() { return this.src }
  load() { this.currentTime = 0; this.ended = false; this.error = null; this.readyState = 4; this.seeking = false }
  removeAttribute(name) { if (name === 'src') this.src = '' }
  pause() {
    if (this.paused) return
    this.paused = true
    this.dispatchEvent(new Event('pause'))
  }
  async play() {
    this.paused = false
    this.ended = false
    this.dispatchEvent(new Event('playing'))
  }
  end() {
    this.paused = true
    this.ended = true
    this.dispatchEvent(new Event('ended'))
  }
  fail() {
    this.error = { code: 4 }
    this.dispatchEvent(new Event('error'))
  }
}

const settle = () => new Promise(resolve => setImmediate(resolve))
const tone = () => ({ samples: Float32Array.from({ length: 2400 }, (_, i) => Math.sin(i * 0.08) * 0.2), sampleRate: 24000, words: [] })

function fixture(dependencies = {}) {
  const previous = Object.fromEntries(['window', 'SpeechSynthesisUtterance', 'requestAnimationFrame', 'cancelAnimationFrame'].map(key => [key, globalThis[key]]))
  const utterances = []
  globalThis.window = { speechSynthesis: { speak: utterance => utterances.push(utterance), cancel() {} } }
  globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text } }
  globalThis.requestAnimationFrame = () => 0
  globalThis.cancelAnimationFrame = () => {}
  const audio = new AudioStub()
  const problems = []
  const outcomes = []
  const controller = createSpeechController(audio, {
    onState() {}, onAudioReady() {}, onDelivery() {}, onPlaying() {}, onPreparing() {}, onMouth() {},
    onProblem: message => problems.push(message),
  }, { loadModel: async () => { throw new Error('local model must not load') }, joinCloudSentences: false, ...dependencies })
  return {
    audio, controller, utterances, problems, outcomes,
    speak(text, engine = 'cloud', label = text) {
      return controller.speak(text, 'neutral', undefined, [], engine, { onEnded: outcome => outcomes.push([label, outcome]) })
    },
    close() {
      controller.dispose()
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete globalThis[key]
        else globalThis[key] = value
      }
    },
  }
}

test('a fully played reply reports played exactly once, after the last clip drains', async () => {
  let calls = 0
  const f = fixture({ synthesizeCloud: async () => { calls++; return tone() } })
  try {
    const speaking = f.speak('第一句。第二句。')
    await settle()
    assert.equal(calls, 2, 'the playing first clip plus one lookahead')
    assert.deepEqual(f.outcomes, [])
    f.audio.end()
    await settle()
    assert.equal(calls, 2)
    assert.deepEqual(f.outcomes, [], 'not played until the last clip ends')
    f.audio.end()
    await speaking
    await settle()
    assert.deepEqual(f.outcomes, [['第一句。第二句。', 'played']])
    f.controller.cancel()
    await settle()
    assert.deepEqual(f.outcomes, [['第一句。第二句。', 'played']], 'a later cancel does not report again')
  }
  finally { f.close() }
})

test('cancel and a replacing speak() report cancelled for the earlier run only', async () => {
  const f = fixture({ synthesizeCloud: async () => tone() })
  try {
    void f.speak('要被取消的一句。', 'cloud', 'first')
    await settle()
    f.controller.cancel()
    await settle()
    assert.deepEqual(f.outcomes, [['first', 'cancelled']])

    void f.speak('旧的一句。', 'cloud', 'old')
    await settle()
    const replacing = f.speak('新的一句。', 'cloud', 'new')
    await settle()
    assert.deepEqual(f.outcomes.slice(1), [['old', 'cancelled']])
    f.audio.end()
    await replacing
    await settle()
    assert.deepEqual(f.outcomes.slice(1), [['old', 'cancelled'], ['new', 'played']])
  }
  finally { f.close() }
})

test('with browserFallback:false a failed first sentence is skipped, never sent to system speech', async () => {
  const f = fixture({ browserFallback: false, synthesizeCloud: async () => { throw new SpeechApiError('unavailable', 503) } })
  try {
    await f.speak('云端会失败。')
    await settle()
    assert.deepEqual(f.outcomes, [['云端会失败。', 'failed']])
    assert.equal(f.utterances.length, 0, 'no speechSynthesis.speak')
    assert.equal(f.problems.at(-1), '云端语音失败，本句已跳过。')
  }
  finally { f.close() }
})

test('the default still falls back to browser speech and reports its own outcome', async () => {
  const f = fixture({ synthesizeCloud: async () => { throw new SpeechApiError('unavailable', 503) } })
  try {
    const speaking = f.speak('回退到系统语音。')
    await settle()
    assert.equal(f.utterances.length, 1, 'existing pages keep the system-voice fallback')
    f.utterances[0].onstart()
    f.utterances[0].onend()
    await speaking
    await settle()
    assert.deepEqual(f.outcomes, [['回退到系统语音。', 'played']])
  }
  finally { f.close() }
})

test('a failure after audible audio reports partial once the played audio drains', async () => {
  let calls = 0
  const f = fixture({ browserFallback: false, synthesizeCloud: async () => {
    if (++calls === 2) throw new SpeechApiError('upstream', 502)
    return tone()
  } })
  try {
    const speaking = f.speak('第一句能播。第二句失败。')
    await settle()
    f.audio.end()
    await speaking
    await settle()
    assert.deepEqual(f.outcomes, [['第一句能播。第二句失败。', 'partial']])
    assert.equal(f.utterances.length, 0)
  }
  finally { f.close() }
})

test('nothing speakable reports empty; a media error reports failed', async () => {
  const f = fixture({ synthesizeCloud: async () => tone() })
  try {
    await f.speak('……', 'cloud', 'symbols')
    await f.speak('   ', 'cloud', 'blank')
    await settle()
    assert.deepEqual(f.outcomes, [['symbols', 'empty'], ['blank', 'empty']])

    void f.speak('坏掉的音频。', 'cloud', 'broken')
    await settle()
    f.audio.fail()
    await settle()
    assert.deepEqual(f.outcomes.at(-1), ['broken', 'failed'])
    assert.equal(f.outcomes.filter(([label]) => label === 'broken').length, 1, 'error then cancel reports once')
  }
  finally { f.close() }
})

test('the browser engine reports played only when every sentence confirmed start', async () => {
  const f = fixture()
  try {
    const confirmed = f.speak('你好。', 'browser', 'confirmed')
    await settle()
    f.utterances[0].onstart()
    f.utterances[0].onend()
    await confirmed
    const unconfirmed = f.speak('没开始。', 'browser', 'unconfirmed')
    await settle()
    f.utterances[1].onend()
    await unconfirmed
    await settle()
    assert.deepEqual(f.outcomes, [['confirmed', 'played'], ['unconfirmed', 'failed']])
  }
  finally { f.close() }
})

test('decodeCloudSpeechResponse decodes a real /api/speech payload from any same-origin route', async () => {
  // A structural MiniMax frame through the real server collector, then the
  // shared browser validator. Not provider audio or timing evidence.
  const mp3 = Buffer.alloc(576)
  Buffer.from([0xff, 0xfb, 0x98, 0xc0]).copy(mp3)
  const frame = { base_resp: { status_code: 0 }, data: { status: 2, audio: mp3.toString('hex') },
    extra_info: { audio_format: 'mp3', audio_sample_rate: 32000, audio_channel: 1, audio_size: mp3.length, audio_length: 36 } }
  const payload = await collectMinimaxStream(new Response(`data: ${JSON.stringify(frame)}\n\n`).body)
  const decoded = tone()
  let decodedBytes = 0
  const clip = await decodeCloudSpeechResponse(new Response(JSON.stringify(payload)), {}, {
    decodeAudio: async (encoded) => { decodedBytes = encoded.byteLength; return decoded },
  })
  assert.equal(decodedBytes, mp3.length)
  assert.equal(clip.samples, decoded.samples)
  assert.deepEqual(clip.words, [])

  for (const [status, code] of [[403, 'unauthorized'], [409, 'provider_changed'], [503, 'unavailable'], [429, 'rate_limited']]) {
    await assert.rejects(decodeCloudSpeechResponse(new Response('{}', { status }), {}, { decodeAudio: async () => decoded }),
      error => error instanceof SpeechApiError && error.code === code)
  }
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(decodeCloudSpeechResponse(new Response(JSON.stringify(payload)), { signal: aborted.signal },
    { decodeAudio: async () => decoded }), { name: 'AbortError' })
  assert.equal(canDecodeCloudSpeech({ decodeAudio: async () => decoded }), true)
  assert.equal(canDecodeCloudSpeech({}), typeof AudioContext !== 'undefined')
})
