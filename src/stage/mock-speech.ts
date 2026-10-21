import type { CloudSpeechClip, SpeechCharacter } from '../cloud-speech'
import type { SpokenSentence } from '../speech-sentences'
import type { Emotion } from '../../shared/performance-cues.mjs'

import { normaliseEmotion } from '../../shared/performance-cues.mjs'

// An offline stand-in for a cloud voice, for the DEV performance panel. It is
// not speech: a pitched buzz per character with the timing, loudness pattern
// and alignment shape the controller, mouth and beat code expect.

export interface MockSpeechOptions {
  sampleRate?: number
  // true adds clip-relative `characters`, so the controller derives aligned
  // beats; false leaves only `words: []` (the legacy envelope fallback).
  aligned?: boolean
}

export interface MockSynthesizerOptions extends MockSpeechOptions {
  latencyMs?: number
}

const F0: Record<Emotion, number> = {
  neutral: 210,
  happy: 260,
  soft: 190,
  curious: 240,
  surprised: 280,
  sad: 175,
  pout: 230,
  shy: 220,
}

const READABLE = /[\p{L}\p{N}]/u
const COMMA = /[，,、；;：:]/u
const STOP = /[。！？!?.…]/u

const SYLLABLE_SECONDS = 0.17
const ATTACK_SECONDS = 0.025
const RELEASE_SECONDS = 0.05
const GAP_SECONDS = 0.03
const COMMA_SECONDS = 0.12
const STOP_SECONDS = 0.25
const LEVEL = 0.28
const LOUD_EVERY = 3
const LOUD_GAIN = 1.6
const PARTIAL_HZ = 1_900
const DECAY = 0.3
// [voice gain, bright partial]: the same power either way (0.64·0.145 + 0.32²/2
// ≈ 0.145), so the partial changes the mouth form but not the loudness.
const VOICED: readonly [number, number] = [1, 0]
const VOICED_BRIGHT: readonly [number, number] = [0.8, 0.32]

const LAUGH_BURSTS = 3
const LAUGH_BURST_SECONDS = 0.11
const LAUGH_GAP_SECONDS = 0.06
const SIGH_SECONDS = 0.7
const PREFIX_GAP_SECONDS = 0.12

// Raised-cosine edges: a linear ramp from 0 would click at every syllable.
function edge(progress: number): number {
  const clamped = Math.min(1, Math.max(0, progress))
  return Math.sin(clamped * Math.PI / 2) ** 2
}

function envelope(time: number, length: number, attack: number, release: number): number {
  return Math.min(edge(time / attack), edge((length - time) / release))
}

// A fixed-seed LCG keeps the breath noise identical on every run and engine.
function noise(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 2 ** 32 * 2 - 1
  }
}

function seconds(value: number, sampleRate: number): number {
  return Math.round(value * sampleRate)
}

function writeSyllable(out: Float32Array, at: number, sampleRate: number, f0: number, index: number): void {
  const length = seconds(SYLLABLE_SECONDS, sampleRate)
  const level = LEVEL * (index % LOUD_EVERY === 0 ? LOUD_GAIN : 1)
  // Alternating a bright partial moves the mouth form between syllables.
  const [voice, partial] = index % 2 === 1 ? VOICED_BRIGHT : VOICED
  for (let sample = 0; sample < length; sample++) {
    const time = sample / sampleRate
    const phase = 2 * Math.PI * time
    const wave = voice * (0.5 * Math.sin(phase * f0) + 0.2 * Math.sin(phase * f0 * 2))
      + partial * Math.sin(phase * PARTIAL_HZ)
    // Like a spoken syllable, it peaks just after the attack and then fades,
    // which is where the beat detector looks for a rise.
    const decay = 1 - DECAY * Math.max(0, time - ATTACK_SECONDS) / (SYLLABLE_SECONDS - ATTACK_SECONDS)
    out[at + sample] = level * decay * envelope(time, SYLLABLE_SECONDS, ATTACK_SECONDS, RELEASE_SECONDS) * wave
  }
}

function writeLaugh(out: Float32Array, sampleRate: number, f0: number): void {
  const length = seconds(LAUGH_BURST_SECONDS, sampleRate)
  const step = length + seconds(LAUGH_GAP_SECONDS, sampleRate)
  const random = noise(0x1a7)
  for (let burst = 0; burst < LAUGH_BURSTS; burst++) {
    // Each "ha" starts higher and falls, like a real laugh's bursts.
    const pitch = f0 * (1.35 - 0.08 * burst)
    for (let sample = 0; sample < length; sample++) {
      const time = sample / sampleRate
      const wave = 0.55 * Math.sin(2 * Math.PI * pitch * time) + 0.25 * random()
      out[burst * step + sample] = LEVEL * LOUD_GAIN * envelope(time, LAUGH_BURST_SECONDS, 0.01, 0.07) * wave
    }
  }
}

function writeSigh(out: Float32Array, sampleRate: number): void {
  const length = seconds(SIGH_SECONDS, sampleRate)
  const random = noise(0x5164)
  const smoothing = 1 - Math.exp(-2 * Math.PI * 900 / sampleRate)
  let breath = 0
  for (let sample = 0; sample < length; sample++) {
    const time = sample / sampleRate
    // Low-passed noise reads as breath rather than hiss; a quick rise and a
    // long fall is the shape of an outward sigh.
    breath += smoothing * (random() - breath)
    out[sample] = 0.3 * envelope(time, SIGH_SECONDS, 0.2, 0.45) * breath
  }
}

function prefixSeconds(sentence: SpokenSentence): number {
  if (sentence.act === 'laugh')
    return LAUGH_BURSTS * LAUGH_BURST_SECONDS + (LAUGH_BURSTS - 1) * LAUGH_GAP_SECONDS + PREFIX_GAP_SECONDS
  if (sentence.act === 'sigh')
    return SIGH_SECONDS + PREFIX_GAP_SECONDS
  // A pause is silence the controller adds itself.
  return 0
}

// Pure and deterministic: the same sentence and options give identical
// samples and times. Character times are clip-relative, as from a provider.
export function mockSpeechClip(sentence: SpokenSentence, { sampleRate = 24_000, aligned = true }: MockSpeechOptions = {}): CloudSpeechClip {
  if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 96_000)
    throw new RangeError('Mock speech needs an integer sample rate from 8000 to 96000')
  const f0 = F0[normaliseEmotion(sentence.delivery) ?? 'neutral']
  const syllable = seconds(SYLLABLE_SECONDS, sampleRate)
  const slot = syllable + seconds(GAP_SECONDS, sampleRate)

  // Lay out in whole samples first, so every time is exact and inside the clip.
  const prefix = seconds(prefixSeconds(sentence), sampleRate)
  const syllables: number[] = []
  const characters: SpeechCharacter[] = []
  let position = prefix
  for (const text of sentence.text) {
    const start = position
    // A lone surrogate half is not a character a provider could align.
    const scalar = text.codePointAt(0)!
    if (scalar >= 0xD800 && scalar <= 0xDFFF)
      continue
    if (READABLE.test(text)) {
      syllables.push(position)
      position += slot
      characters.push({ text, start: start / sampleRate, end: (start + syllable) / sampleRate })
      continue
    }
    if (COMMA.test(text))
      position += seconds(COMMA_SECONDS, sampleRate)
    else if (STOP.test(text))
      position += seconds(STOP_SECONDS, sampleRate)
    characters.push({ text, start: start / sampleRate, end: position / sampleRate })
  }
  // The controller only sends spoken text, but a clip must never be silent.
  if (!syllables.length) {
    syllables.push(position)
    position += slot
  }

  const samples = new Float32Array(position)
  if (sentence.act === 'laugh')
    writeLaugh(samples, sampleRate, f0)
  else if (sentence.act === 'sigh')
    writeSigh(samples, sampleRate)
  syllables.forEach((at, index) => writeSyllable(samples, at, sampleRate, f0, index))

  return { samples, sampleRate, words: [], ...(aligned ? { characters } : {}) }
}

function abortError(): DOMException {
  return new DOMException('语音请求已取消。', 'AbortError')
}

// The controller's `synthesizeCloud` dependency, with a simulated network
// latency (always at least a macrotask, like a real request). Like
// fetchCloudSpeech it rejects with an AbortError when canceled.
export function createMockSynthesizer({ latencyMs = 0, ...options }: MockSynthesizerOptions = {}): (sentence: SpokenSentence, signal: AbortSignal) => Promise<CloudSpeechClip> {
  return (sentence, signal) => new Promise<CloudSpeechClip>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError())
      return
    }
    const finish = () => {
      signal.removeEventListener('abort', abort)
      try {
        resolve(mockSpeechClip(sentence, options))
      }
      catch (error) {
        reject(error)
      }
    }
    const timer = setTimeout(finish, Math.max(0, latencyMs))
    const abort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}
