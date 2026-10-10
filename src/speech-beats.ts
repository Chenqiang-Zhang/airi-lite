import type { SpeechWord, SpeechCharacter } from './cloud-speech'
import type { MouthFrame } from './mouth'
import { MOUTH_FRAMES_PER_SECOND } from './mouth.ts'

export interface SpeechBeat {
  start: number
  peak: number
  end: number
  strength: number
}

export interface SpeechBeatSegment {
  time: number
  duration: number
  // null means missing provider alignment; [] means aligned, without beats.
  events: readonly SpeechBeat[] | null
}

const READABLE = /[\p{L}\p{N}]/u
export const SPEECH_BEAT_COOLDOWN_SECONDS = 0.65

// Already-validated provider intervals only. Character captions are NOT
// phonemes; words are never subdivided or assigned semantic emphasis here.
// Merge their covered union in one pass, then scan the measured 40 Hz opening
// envelope once. Both time and storage are bounded by existing clip metadata.
export function speechBeats(alignment: {
  words?: readonly SpeechWord[]
  wordAlignmentAvailable?: true
  characters?: readonly SpeechCharacter[]
}, frames: readonly MouthFrame[], duration: number, previousPeak = -Infinity): SpeechBeat[] | null {
  const intervals = alignment.words?.length ? alignment.words
    : alignment.characters ?? (alignment.wordAlignmentAvailable ? [] : undefined)
  if (intervals === undefined) return null
  if (!Number.isFinite(duration) || duration <= 0) return []
  const coverage: { start: number, end: number }[] = []
  for (const interval of intervals) {
    if (!READABLE.test(interval.text) || !Number.isFinite(interval.start) || !Number.isFinite(interval.end)) continue
    const start = Math.max(0, interval.start), end = Math.min(duration, interval.end)
    if (end <= start) continue
    const last = coverage.at(-1)
    if (last && start < last.end) last.end = Math.max(last.end, end)
    else coverage.push({ start, end })
  }
  const events: SpeechBeat[] = []
  let coveredIndex = 0, lastPeak = previousPeak
  for (let index = 1; index < frames.length; index++) {
    const peak = index / MOUTH_FRAMES_PER_SECOND
    if (peak >= duration) break
    while (coverage[coveredIndex] && coverage[coveredIndex]!.end <= peak) coveredIndex++
    const covered = coverage[coveredIndex]
    if (!covered) break
    if (peak <= covered.start || peak - lastPeak < SPEECH_BEAT_COOLDOWN_SECONDS) continue
    const open = frames[index]!.open
    const previous = frames[index - 1]!.open
    const next = frames[index + 1]?.open ?? 0
    const floor = Math.min(previous, frames[Math.max(0, index - 2)]!.open, frames[Math.max(0, index - 3)]!.open)
    const rise = open - floor
    // An audible local peak with a measured recent rise, not a clock pulse.
    if (!Number.isFinite(open) || open < 0.1 || open <= previous || open < next || rise < 0.06) continue
    events.push({ start: Math.max(covered.start, peak - 0.08), peak,
      end: Math.min(covered.end, peak + 0.28),
      strength: Math.min(1, (rise - 0.05) / 0.2) * Math.min(1, open / 0.35) })
    lastPeak = peak
  }
  return events
}

// Stateless binary-search lookup supports replay and backward media seeks.
// null preserves the honest local/browser fallback; zero suppresses it on
// an aligned clip even in silence, punctuation, or uncovered caption gaps.
export function speechBeatAtTime(segments: readonly SpeechBeatSegment[], time: number): number | null {
  if (!Number.isFinite(time) || time < 0) return null
  let low = 0, high = segments.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (segments[middle]!.time <= time) low = middle + 1
    else high = middle
  }
  const segment = segments[low - 1]
  if (!segment || time >= segment.time + segment.duration || segment.events === null) return null
  const local = time - segment.time
  low = 0; high = segment.events.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (segment.events[middle]!.start <= local) low = middle + 1
    else high = middle
  }
  const event = segment.events[low - 1]
  if (!event || local >= event.end) return 0
  const progress = local <= event.peak
    ? (local - event.start) / (event.peak - event.start)
    : (event.end - local) / (event.end - event.peak)
  return event.strength * progress * progress * (3 - 2 * progress)
}
