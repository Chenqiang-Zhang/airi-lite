import assert from 'node:assert/strict'
import test from 'node:test'

import { EMOTIONS } from '../../shared/performance-cues.mjs'

import { decodeCloudSpeechResponse } from '../cloud-speech.ts'
import { mouthFrames } from '../mouth.ts'
import { speechBeats } from '../speech-beats.ts'
import { createMockSynthesizer, mockSpeechClip } from './mock-speech.ts'

const LINES = {
  neutral: '今天的直播就从这里开始吧。',
  happy: '太好了，我超开心的！',
  soft: '没关系的，慢慢来就好。',
  curious: '这是什么呀？',
  surprised: '诶？真的吗！',
  sad: '唉，有点可惜呢。',
  pout: '哼，才不理你呢。',
  shy: '被你这么一说，有点不好意思啦。',
}
const LONG = '今天天气很好，我们一起去公园散步吧。然后再去吃点好吃的，你觉得怎么样？我已经等不及了！'
const READABLE = /[\p{L}\p{N}]/u

const duration = clip => clip.samples.length / clip.sampleRate
const rms = (samples, from = 0, to = samples.length) => {
  let energy = 0
  for (let index = from; index < to; index++) energy += samples[index] ** 2
  return Math.sqrt(energy / Math.max(1, to - from))
}

// The same checks as consumeSegments in speech.ts, which rejects a cloud clip
// outright rather than playing it.
function passesControllerChecks(clip) {
  if (!Number.isInteger(clip.sampleRate) || clip.sampleRate <= 0 || !clip.samples.length) return false
  let energy = 0
  let peak = 0
  for (const sample of clip.samples) {
    if (!Number.isFinite(sample)) return false
    energy += sample * sample
    peak = Math.max(peak, Math.abs(sample))
  }
  return peak >= 0.001 && Math.sqrt(energy / clip.samples.length) >= 0.0001
}

// The real provider validator: bounded duration, audible RMS, and character
// alignment checked against the decoded clip's length.
async function viaProviderValidator(clip) {
  const payload = { format: 'wav', sampleRate: clip.sampleRate, audio: 'AAAA', words: clip.words,
    ...(clip.characters ? { characters: clip.characters } : {}) }
  const response = new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } })
  return decodeCloudSpeechResponse(response, {}, {
    decodeAudio: async () => ({ samples: clip.samples, sampleRate: clip.sampleRate }),
  })
}

test('the same sentence always gives the same clip, and each tone has its own pitch', () => {
  for (const act of [undefined, 'laugh', 'sigh']) {
    const sentence = { text: LINES.happy, delivery: 'happy', ...(act ? { act } : {}) }
    assert.deepEqual(mockSpeechClip(sentence), mockSpeechClip(sentence))
  }
  const byTone = EMOTIONS.map(delivery => mockSpeechClip({ text: '你好呀', delivery }))
  assert.ok(byTone.every(clip => clip.samples.length === byTone[0].samples.length), 'timing does not depend on the tone')
  for (const [index, clip] of byTone.entries()) {
    for (const other of byTone.slice(index + 1))
      assert.notDeepEqual(clip.samples, other.samples)
  }
  assert.deepEqual(mockSpeechClip({ text: '你好', delivery: 'bright' }), mockSpeechClip({ text: '你好', delivery: 'happy' }))
  assert.deepEqual(mockSpeechClip({ text: '你好', delivery: 'nope' }), mockSpeechClip({ text: '你好', delivery: 'neutral' }))
})

test('samples are finite, within [-1, 1], and pass the controller and provider checks', async () => {
  for (const sampleRate of [16_000, 24_000, 44_100]) {
    for (const delivery of EMOTIONS) {
      for (const act of [undefined, 'laugh', 'sigh', 'pause']) {
        const clip = mockSpeechClip({ text: LINES[delivery], delivery, ...(act ? { act } : {}) }, { sampleRate })
        assert.equal(clip.sampleRate, sampleRate)
        assert.ok(clip.samples instanceof Float32Array)
        assert.ok(clip.samples.every(sample => Number.isFinite(sample) && sample >= -1 && sample <= 1))
        assert.ok(passesControllerChecks(clip), `${delivery} ${act ?? ''} at ${sampleRate}`)
        const accepted = await viaProviderValidator(clip)
        assert.deepEqual(accepted.characters, clip.characters)
      }
    }
  }
  // The controller never sends unreadable text, but even that is not silent.
  assert.ok(passesControllerChecks(mockSpeechClip({ text: '。', delivery: 'neutral' })))
  assert.throws(() => mockSpeechClip({ text: '你好', delivery: 'neutral' }, { sampleRate: 4_000 }), RangeError)
  assert.throws(() => mockSpeechClip({ text: '你好', delivery: 'neutral' }, { sampleRate: 22_050.5 }), RangeError)
})

test('characters cover the text in order, with syllables and punctuation silences inside the clip', () => {
  const clip = mockSpeechClip({ text: LINES.happy, delivery: 'happy' })
  assert.deepEqual(clip.words, [])
  assert.equal(clip.characters.map(character => character.text).join(''), LINES.happy)
  let previousEnd = 0
  for (const character of clip.characters) {
    assert.ok(character.start >= previousEnd && character.end >= character.start)
    assert.ok(character.end <= duration(clip))
    previousEnd = character.end
  }
  const at = text => clip.characters.find(character => character.text === text)
  // 太好了 = three 0.2 s slots (0.17 s voiced, 0.03 s gap), then the comma.
  assert.equal(at('太').start, 0)
  assert.ok(Math.abs(at('太').end - 0.17) < 1e-9)
  assert.ok(Math.abs(at('，').start - 0.6) < 1e-9)
  assert.ok(Math.abs(at('，').end - at('，').start - 0.12) < 1e-9)
  assert.ok(Math.abs(at('我').start - 0.72) < 1e-9)
  assert.ok(Math.abs(at('！').end - at('！').start - 0.25) < 1e-9)
  assert.ok(Math.abs(duration(clip) - (8 * 0.2 + 0.12 + 0.25)) < 1e-9)
  for (const character of clip.characters.filter(character => READABLE.test(character.text))) {
    const from = Math.round(character.start * clip.sampleRate)
    const to = Math.round(character.end * clip.sampleRate)
    assert.ok(rms(clip.samples, from, to) > 0.05, 'every readable character is voiced')
  }
  // Silence between syllables and inside the punctuation pauses.
  const comma = at('，')
  assert.equal(rms(clip.samples, Math.round(comma.start * 24_000), Math.round(comma.end * 24_000)), 0)
})

test('measured beats come at least once every 2 s, and the mouth form varies', () => {
  for (const [delivery, text] of [...Object.entries(LINES), ['neutral', LONG]]) {
    for (const act of [undefined, 'laugh', 'sigh']) {
      const clip = mockSpeechClip({ text, delivery, ...(act ? { act } : {}) })
      const frames = mouthFrames(clip.samples, clip.sampleRate)
      const beats = speechBeats(clip, frames, duration(clip))
      assert.ok(beats.length >= Math.max(1, Math.floor(duration(clip) / 2)), `${beats.length} beats in ${duration(clip)} s of ${delivery} ${act ?? ''}`)
      for (const [index, beat] of beats.entries()) {
        // Strong enough to engage the blink guard (minBeat 0.15).
        assert.ok(beat.strength >= 0.15)
        if (index) assert.ok(beat.peak - beats[index - 1].peak <= 2)
      }
      const forms = frames.filter(frame => frame.open > 0.2).map(frame => frame.form)
      assert.ok(Math.max(...forms) - Math.min(...forms) > 0.1, 'alternating partials move the mouth form')
    }
  }
  // Every 3rd syllable is louder: 1.6x the others.
  const clip = mockSpeechClip({ text: '一二三四五六', delivery: 'neutral' })
  const levels = clip.characters.map(character =>
    rms(clip.samples, Math.round(character.start * 24_000), Math.round(character.end * 24_000)))
  for (const [index, level] of levels.entries()) {
    const expected = index % 3 === 0 ? 1.6 : 1
    assert.ok(Math.abs(level / levels[1] - expected) < 0.05, `syllable ${index}: ${level / levels[1]}`)
  }
})

test('laugh and sigh prefixes add sound before the words; pause is left to the controller', () => {
  const sentence = { text: LINES.sad, delivery: 'sad' }
  const plain = mockSpeechClip(sentence)
  assert.deepEqual(mockSpeechClip({ ...sentence, act: 'pause' }), plain)

  for (const [act, prefix] of [['laugh', 3 * 0.11 + 2 * 0.06 + 0.12], ['sigh', 0.7 + 0.12]]) {
    const clip = mockSpeechClip({ ...sentence, act })
    const offset = Math.round(prefix * clip.sampleRate)
    assert.equal(clip.samples.length, plain.samples.length + offset)
    // The words are the same clip, shifted after the prefix.
    assert.deepEqual(clip.samples.subarray(offset), plain.samples)
    for (const [index, character] of clip.characters.entries()) {
      const original = plain.characters[index]
      assert.equal(character.text, original.text)
      assert.ok(Math.abs(character.start - original.start - offset / 24_000) < 1e-9)
      assert.ok(Math.abs(character.end - original.end - offset / 24_000) < 1e-9)
    }
    assert.ok(rms(clip.samples, 0, offset) > 0.02, `${act} has energy at the start`)
    assert.ok(plain.characters[0].start === 0 && clip.characters[0].start >= prefix - 1e-9)
  }

  // Three separate bursts in a laugh: count 10 ms windows rising above a floor.
  const laugh = mockSpeechClip({ ...sentence, act: 'laugh' })
  let bursts = 0
  let loud = false
  for (let from = 0; from < Math.round(0.45 * 24_000); from += 240) {
    const now = rms(laugh.samples, from, from + 240) > 0.03
    if (now && !loud) bursts++
    loud = now
  }
  assert.equal(bursts, 3)
  // A sigh is one long breath, quieter than the words.
  const sigh = mockSpeechClip({ ...sentence, act: 'sigh' })
  assert.ok(rms(sigh.samples, 0, Math.round(0.7 * 24_000)) < rms(plain.samples))
})

test('unaligned clips have no characters and an empty word list, with the same audio', () => {
  const aligned = mockSpeechClip({ text: LINES.curious, delivery: 'curious' })
  const unaligned = mockSpeechClip({ text: LINES.curious, delivery: 'curious' }, { aligned: false })
  assert.deepEqual(unaligned.words, [])
  assert.equal(Object.hasOwn(unaligned, 'characters'), false)
  assert.equal(Object.hasOwn(unaligned, 'wordAlignmentAvailable'), false)
  assert.deepEqual(unaligned.samples, aligned.samples)
  // Without alignment the controller keeps the legacy envelope fallback.
  assert.equal(speechBeats(unaligned, mouthFrames(unaligned.samples, 24_000), duration(unaligned)), null)
})

test('the mock synthesizer waits for its latency and honours the abort signal', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const flush = () => new Promise(resolve => setImmediate(resolve))
  const sentence = { text: LINES.shy, delivery: 'shy', act: 'laugh' }
  const synthesize = createMockSynthesizer({ latencyMs: 400, aligned: false, sampleRate: 16_000 })

  let result = null
  const pending = synthesize(sentence, new AbortController().signal).then(clip => (result = clip))
  t.mock.timers.tick(399)
  await flush()
  assert.equal(result, null)
  t.mock.timers.tick(1)
  await pending
  assert.deepEqual(result, mockSpeechClip(sentence, { aligned: false, sampleRate: 16_000 }))

  const early = new AbortController()
  early.abort()
  await assert.rejects(synthesize(sentence, early.signal), { name: 'AbortError' })

  const late = new AbortController()
  let settled = null
  const canceled = synthesize(sentence, late.signal).then(() => (settled = 'resolved'), error => (settled = error.name))
  t.mock.timers.tick(200)
  late.abort()
  await canceled
  assert.equal(settled, 'AbortError')
  t.mock.timers.tick(1_000)
  await flush()
  assert.equal(settled, 'AbortError', 'a canceled request never resolves later')

  // Zero latency still answers asynchronously, like a real request.
  let instant = null
  const zero = createMockSynthesizer()(sentence, new AbortController().signal).then(clip => (instant = clip))
  await Promise.resolve()
  assert.equal(instant, null)
  t.mock.timers.tick(0)
  await zero
  assert.deepEqual(instant, mockSpeechClip(sentence))
})
