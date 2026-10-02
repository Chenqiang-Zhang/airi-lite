export interface MouthFrame {
  open: number
  form: number
}

export const MOUTH_FRAMES_PER_SECOND = 40

export interface MouthSegment {
  time: number
  duration: number
  frames: readonly MouthFrame[]
}

const CLOSED_MOUTH: Readonly<MouthFrame> = Object.freeze({ open: 0, form: 0 })
const MIN_RMS = 0.0001

// Tracks are ordered by their start time and use half-open intervals. Reading
// media time, rather than advancing a counter, also supports backward seeks.
export function mouthAtTime(segments: readonly MouthSegment[], time: number): MouthFrame {
  if (!Number.isFinite(time) || time < 0)
    return CLOSED_MOUTH
  let low = 0
  let high = segments.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (segments[middle]!.time <= time)
      low = middle + 1
    else
      high = middle
  }
  const segment = segments[low - 1]
  if (!segment || !Number.isFinite(segment.time) || !Number.isFinite(segment.duration)
    || segment.duration <= 0
    || time >= segment.time + segment.duration - Number.EPSILON * Math.max(1, time) * 8)
    return CLOSED_MOUTH
  // Addition/subtraction of clip offsets can move an exact frame boundary by
  // a few floating-point ulps. The epsilon is far below a media-clock tick.
  const index = Math.floor((time - segment.time) * MOUTH_FRAMES_PER_SECOND + 1e-7)
  return segment.frames[index] ?? CLOSED_MOUTH
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

// Audio-synchronous approximation, not phoneme/viseme forced alignment.
// The mid-band share loosely tracks rounded versus spread vowel colour.
export function mouthFrames(samples: Float32Array, sampleRate: number): MouthFrame[] {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0)
    return []

  const count = Math.ceil(samples.length / sampleRate * MOUTH_FRAMES_PER_SECOND)
  const lowAlpha = 1 - Math.exp(-2 * Math.PI * 1_400 / sampleRate)
  const upperAlpha = 1 - Math.exp(-2 * Math.PI * 3_500 / sampleRate)
  const levels: { rms: number, midShare: number }[] = []
  let lowPass = 0
  let upperPass = 0
  for (let frame = 0; frame < count; frame++) {
    // Calculate each boundary from time: fixed floor(sampleRate / 40) steps
    // accumulate drift at 44.1 kHz and other non-divisible sample rates.
    const start = Math.floor(frame * sampleRate / MOUTH_FRAMES_PER_SECOND)
    const end = Math.min(samples.length, Math.floor((frame + 1) * sampleRate / MOUTH_FRAMES_PER_SECOND))
    let energy = 0
    let lowEnergy = 0
    let midEnergy = 0
    for (let index = start; index < end; index++) {
      const sample = Number.isFinite(samples[index]) ? samples[index]! : 0
      lowPass += lowAlpha * (sample - lowPass)
      upperPass += upperAlpha * (sample - upperPass)
      const mid = upperPass - lowPass
      energy += sample * sample
      lowEnergy += lowPass * lowPass
      midEnergy += mid * mid
    }

    levels.push({ rms: end > start ? Math.sqrt(energy / (end - start)) : 0,
      midShare: midEnergy / (lowEnergy + midEnergy + 1e-20) })
  }

  // A sentence's robust upper level, not a single peak, controls only its jaw
  // gain. Do not normalize playback PCM or erase quieter syllable dynamics.
  // This is an amplitude gate, not a voice-activity/noise classifier.
  // The largest three-frame median anchors the speech-level population. A
  // long faint tail must not outvote a short spoken region; one isolated click
  // must not become the anchor either. Very short clips keep the simple path.
  let anchor = 0
  for (let index = 1; index < levels.length - 1; index++) {
    const a = levels[index - 1]!.rms
    const b = levels[index]!.rms
    const c = levels[index + 1]!.rms
    anchor = Math.max(anchor, a + b + c - Math.min(a, b, c) - Math.max(a, b, c))
  }
  const activeLevels = levels.map(level => level.rms)
    .filter(rms => rms >= Math.max(MIN_RMS, anchor * 0.08)).sort((a, b) => a - b)
  const reference = activeLevels[Math.floor((activeLevels.length - 1) * 0.85)] ?? 0
  const gain = reference > 0 ? clamp(0.6 / reference, 0.6, 700) : 0
  const gate = Math.max(MIN_RMS, reference * 0.04)
  const frames: MouthFrame[] = []
  let previousOpen = 0
  let previousForm = 0
  for (const { rms, midShare } of levels) {
    const targetOpen = rms < gate ? 0 : clamp(rms * gain, 0, 1)
    // Centered on a real Kokoro Chinese sample rather than a pure tone.
    const targetForm = targetOpen < 0.08 ? 0 : clamp((midShare - 0.08) * 2.5, -0.32, 0.32)
    let open = targetOpen > previousOpen
      ? previousOpen * 0.25 + targetOpen * 0.75
      : targetOpen === 0 ? previousOpen * 0.2 : previousOpen * 0.55 + targetOpen * 0.45
    if (targetOpen === 0 && open < 0.025)
      open = 0
    const form = open === 0 ? 0 : previousForm * 0.55 + targetForm * 0.45
    frames.push({ open, form })
    previousOpen = open
    previousForm = form
  }

  return frames
}
