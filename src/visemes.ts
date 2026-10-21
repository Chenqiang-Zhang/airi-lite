import type { SpeechCharacter, SpeechWord } from './cloud-speech'
import type { MouthFrame } from './mouth'
import type { Viseme } from '../shared/performance-cues.mjs'

import { VISEMES } from '../shared/performance-cues.mjs'
import { MOUTH_FRAMES_PER_SECOND } from './mouth.ts'
import { VOWEL_TABLE } from './vowel-table.ts'

// Vowel shapes from the reply text plus the timings the client already
// receives. The audio envelope still decides how much and when the mouth
// opens; this only says which shape an open mouth takes, on voiced frames.
// No track (Kokoro, local TTS, unaligned, stale or ambiguous timings) keeps
// exactly the volume and spectral-form mouth.

// A unit's voiced hull runs between its first and last frame this open.
export const VOICED_OPEN = 0.08
// A voiced frame for the lead check (open at or above this).
export const LEAD_VOICED = 0.15
// MiniMax word times are one token late on every measured clip; the shifted
// interval must be this much more voiced than the reported one.
export const LEAD_MARGIN = 0.2
// Otherwise the reported interval itself must be at least half voiced.
export const REPORTED_VOICED = 0.5
// Seconds of audio after the last word: more means a stale subtitle snapshot
// (healthy clips 0.19-0.44 s, stale 1.8-3.2 s).
export const STALE_TAIL = 1.0
// Lips move ahead of the sound, so shapes lead the envelope by 25 ms.
export const LEAD_FRAMES = 1
// A b/p/m onset closes the lips for two frames, on hulls this long or more.
export const CLOSE_FRAMES = 2
export const CLOSE_MIN_HULL = 4
// Weights fade with the opening below this, and a closed frame has none.
export const GATE_OPEN = 0.15
// Smaller totals are left out of the frame.
export const MIN_WEIGHT = 0.01

// [shape, the fraction of the voiced part where it starts].
export type VowelKey = readonly [Viseme, number]

function keys(...list: VowelKey[]): readonly VowelKey[] {
  return Object.freeze(list.map(key => Object.freeze(key)))
}

const A = keys(['a', 0])
const E = keys(['e', 0])
const I = keys(['i', 0])
const U = keys(['u', 0])
const N = keys(['n', 0])
const UE = keys(['u', 0], ['e', 0.3])
const UA = keys(['u', 0], ['a', 0.3])

// Medial, nucleus and coda per canonical final (scripts/build-vowel-table.mjs
// lists the same finals). The apical -i and the syllabic nasals use the
// narrow n shape; the syllabic m (呣) is closed for its whole hull.
export const FINAL_KEYS: Readonly<Record<string, readonly VowelKey[]>> = Object.freeze({
  'a': A, 'an': A, 'ang': A,
  'ai': keys(['a', 0], ['e', 0.65]),
  'ao': keys(['a', 0], ['u', 0.65]),
  'o': keys(['o', 0]),
  'uo': keys(['u', 0], ['o', 0.3]),
  'ou': keys(['o', 0], ['u', 0.65]),
  'ong': keys(['o', 0], ['u', 0.5]),
  'e': E, 'en': E, 'eng': E, 'er': E, 'ê': E,
  'ie': keys(['i', 0], ['e', 0.3]),
  'üe': UE, 'üan': UE,
  'ei': keys(['e', 0], ['i', 0.6]),
  'i': I, 'in': I, 'ing': I,
  '-i': N,
  'u': U, 'ü': U, 'ün': U,
  'ia': keys(['i', 0], ['a', 0.3]), 'iang': keys(['i', 0], ['a', 0.3]),
  'iao': keys(['i', 0], ['a', 0.25], ['u', 0.7]),
  'iou': keys(['i', 0], ['o', 0.25], ['u', 0.7]),
  'ian': keys(['i', 0], ['e', 0.3]),
  'iong': keys(['i', 0], ['u', 0.3]),
  'io': keys(['i', 0], ['o', 0.3]),
  'ua': UA, 'uan': UA, 'uang': UA,
  'uai': keys(['u', 0], ['a', 0.25], ['e', 0.7]),
  'uei': keys(['u', 0], ['e', 0.25], ['i', 0.7]),
  'uen': UE, 'ueng': UE,
  'ng': N,
  'm': keys(['m', 0]),
})

const BILABIAL = 'b:'
// The same readable-token rule as speech-beats.
const READABLE = /[\p{L}\p{N}]/u
const CHANNEL = Object.freeze(Object.fromEntries(VISEMES.map((viseme, index) => [viseme, index]))) as Readonly<Record<Viseme, number>>
const BLUR = [0.25, 0.5, 0.25] as const

let readings: Map<string, string> | null = null

// The VOWEL_TABLE key of one Han character: its canonical final, with b: in
// front for a b/p/m initial. Anything else (Latin, digits, punctuation, a
// multi-character dictionary group, an unknown character) has none.
export function readingOf(character: string): string | undefined {
  if (!readings) {
    readings = new Map()
    for (const [key, characters] of Object.entries(VOWEL_TABLE)) {
      for (const each of characters) readings.set(each, key)
    }
  }
  return readings.get(character)
}

export interface VowelAlignment {
  words?: readonly SpeechWord[]
  wordAlignmentAvailable?: true
  characters?: readonly SpeechCharacter[]
}

export interface VowelUnit {
  text: string
  // Absent for a blank unit: no shape, but it still bounds its neighbours.
  reading?: string
  // Clip-relative seconds, from this unit's onset to the next unit's.
  start: number
  end: number
}

export interface VowelTrack {
  // 1 when MiniMax word times were one token late against the envelope.
  lead: 0 | 1
  units: VowelUnit[]
}

// Same epsilon idea as mouthAtTime: clip offsets can move an exact frame
// boundary by a few ulps.
function frameAt(time: number): number {
  return Math.round(time * MOUTH_FRAMES_PER_SECOND + 1e-7)
}

function voicedShare(frames: readonly MouthFrame[], start: number, end: number): number {
  const from = Math.max(0, Math.floor(start * MOUTH_FRAMES_PER_SECOND + 1e-7))
  const to = Math.min(frames.length, Math.ceil(end * MOUTH_FRAMES_PER_SECOND - 1e-7))
  if (to <= from)
    return 0
  let voiced = 0
  for (let index = from; index < to; index++) {
    if (frames[index]!.open >= LEAD_VOICED) voiced++
  }
  return voiced / (to - from)
}

// Readable tokens with their spans, or null when the clip has no usable
// track. Same source precedence as speechBeats: words, then characters.
export function vowelUnits(alignment: VowelAlignment, frames: readonly MouthFrame[], duration: number): VowelTrack | null {
  const fromWords = Boolean(alignment.words?.length)
  const source = fromWords ? alignment.words : alignment.characters
  if (!source?.length || !frames.length || !Number.isFinite(duration) || duration <= 0)
    return null
  const tokens = source.filter(token => typeof token?.text === 'string'
    && Number.isFinite(token.start) && Number.isFinite(token.end) && token.end >= token.start)
  const readable: number[] = []
  tokens.forEach((token, index) => {
    if (READABLE.test(token.text)) readable.push(index)
  })
  if (!readable.length)
    return null

  let lead: 0 | 1 = 0
  if (fromWords) {
    // A final subtitle update without word times leaves an early snapshot
    // whose tail words are placeholders; its timings cannot place shapes.
    const lastEnd = tokens.reduce((end, token) => Math.max(end, token.end), 0)
    if (duration - lastEnd > STALE_TAIL)
      return null
    // Compared within the clip, not against a fixed threshold, so a browser
    // decoder that strips the MP3 priming does not flip the decision.
    const first = readable[0]!
    const reported = voicedShare(frames, tokens[first]!.start, tokens[first]!.end)
    const next = tokens[first + 1]
    const shifted = next ? voicedShare(frames, next.start, tokens[first + 2]?.start ?? next.end) : 0
    // Only a mostly silent first interval is shifted: an on-time word whose
    // syllable starts softly (我, 一) is still voiced over half its interval
    // and keeps its timings; a shift there would put every shape one
    // syllable late. Ambiguous clips get no track.
    if (reported >= REPORTED_VOICED)
      lead = 0
    else if (shifted - reported >= LEAD_MARGIN)
      lead = 1
    else
      return null
  }

  // Shifted, a unit starts where the token after it was reported (punctuation
  // counts), so a pause after punctuation folds into the character before it.
  const onset = (index: number) => lead ? tokens[index + 1]?.start ?? tokens[index]!.end : tokens[index]!.start
  const clampTime = (time: number) => Math.min(duration, Math.max(0, time))
  const units = readable.map((index, order): VowelUnit => {
    const text = tokens[index]!.text
    const start = clampTime(onset(index))
    const end = order + 1 < readable.length ? clampTime(onset(readable[order + 1]!)) : duration
    const reading = readingOf(text.trim())
    return { text, ...(reading ? { reading } : {}), start, end: Math.max(start, end) }
  })
  return { lead, units }
}

// Splits [from, to] (inclusive) between the keys; too few frames for every
// key keeps only the one with the largest share (the nucleus).
function layKeys(targets: Int8Array, list: readonly VowelKey[], from: number, to: number): void {
  const length = to - from + 1
  if (length <= 0)
    return
  if (length < list.length) {
    const share = (index: number) => (list[index + 1]?.[1] ?? 1) - list[index]![1]
    let longest = 0
    for (let index = 1; index < list.length; index++) {
      if (share(index) > share(longest)) longest = index
    }
    targets.fill(CHANNEL[list[longest]![0]], from, to + 1)
    return
  }
  list.forEach(([viseme, fraction], index) => {
    const start = from + Math.round(fraction * length)
    const end = index + 1 < list.length ? from + Math.round(list[index + 1]![1] * length) : to + 1
    targets.fill(CHANNEL[viseme], start, end)
  })
}

// The same array when the clip has no track. Otherwise new frames with open
// and form copied unchanged (so speechBeats sees identical input) and a
// vowel only where the total weight reaches MIN_WEIGHT.
export function withVowels(frames: readonly MouthFrame[], alignment: VowelAlignment, duration: number): readonly MouthFrame[] {
  const track = vowelUnits(alignment, frames, duration)
  if (!track)
    return frames
  const count = frames.length
  // One target shape per frame (-1: none), before the lead and the blur.
  const targets = new Int8Array(count).fill(-1)
  const closed = new Uint8Array(count)
  for (const unit of track.units) {
    if (!unit.reading)
      continue
    const bilabial = unit.reading.startsWith(BILABIAL)
    const list = FINAL_KEYS[bilabial ? unit.reading.slice(BILABIAL.length) : unit.reading]
    if (!list)
      continue
    const first = Math.max(0, frameAt(unit.start))
    const last = Math.min(count, frameAt(unit.end)) - 1
    let hullStart = -1
    let hullEnd = -1
    for (let index = first; index <= last; index++) {
      if (frames[index]!.open < VOICED_OPEN)
        continue
      if (hullStart < 0) hullStart = index
      hullEnd = index
    }
    if (hullStart < 0)
      continue
    let from = hullStart
    if (bilabial && hullEnd - hullStart + 1 >= CLOSE_MIN_HULL) {
      // The envelope barely closes on b/p/m, so the closure goes where it
      // dips most at the onset.
      let low = Math.max(0, hullStart - 1)
      for (let index = low + 1; index <= hullStart + 1; index++) {
        if (frames[index]!.open < frames[low]!.open) low = index
      }
      closed.fill(1, low, low + CLOSE_FRAMES)
      from = low + CLOSE_FRAMES
    }
    layKeys(targets, list, from, hullEnd)
  }

  const m = CHANNEL.m
  return frames.map((frame, index): MouthFrame => {
    const { open, form } = frame
    if (!(open > 0))
      return { open, form }
    const weights: number[] = Array.from({ length: VISEMES.length }, () => 0)
    if (closed[index]) {
      // Hard: no lead, blur or gate.
      weights[m] = 1
      return { open, form, vowel: weights }
    }
    const gate = Math.min(1, open / GATE_OPEN)
    let total = 0
    for (let offset = -1; offset <= 1; offset++) {
      const at = index + LEAD_FRAMES + offset
      if (at < 0 || at >= count || targets[at]! < 0)
        continue
      const weight = BLUR[offset + 1]! * gate
      weights[targets[at]!] += weight
      total += weight
    }
    return total >= MIN_WEIGHT ? { open, form, vowel: weights } : { open, form }
  })
}
