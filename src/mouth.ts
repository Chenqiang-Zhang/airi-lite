export interface MouthFrame {
  open: number
  form: number
}

const FRAMES_PER_SECOND = 40

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

// Audio-synchronous approximation, not phoneme/viseme forced alignment.
// The mid-band share loosely tracks rounded versus spread vowel colour.
export function mouthFrames(samples: Float32Array, sampleRate: number): MouthFrame[] {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0)
    return []

  const step = Math.max(1, Math.floor(sampleRate / FRAMES_PER_SECOND))
  const lowAlpha = 1 - Math.exp(-2 * Math.PI * 1_400 / sampleRate)
  const upperAlpha = 1 - Math.exp(-2 * Math.PI * 3_500 / sampleRate)
  const frames: MouthFrame[] = []
  let lowPass = 0
  let upperPass = 0
  let previousOpen = 0
  let previousForm = 0

  for (let start = 0; start < samples.length; start += step) {
    const end = Math.min(samples.length, start + step)
    let energy = 0
    let lowEnergy = 0
    let midEnergy = 0
    for (let index = start; index < end; index++) {
      const sample = samples[index]
      lowPass += lowAlpha * (sample - lowPass)
      upperPass += upperAlpha * (sample - upperPass)
      const mid = upperPass - lowPass
      energy += sample * sample
      lowEnergy += lowPass * lowPass
      midEnergy += mid * mid
    }

    const rms = Math.sqrt(energy / (end - start))
    const targetOpen = rms < 0.002 ? 0 : clamp(rms * 5, 0, 1)
    const midShare = midEnergy / (lowEnergy + midEnergy + 1e-9)
    // Centered on a real Kokoro Chinese sample rather than a pure tone.
    const targetForm = targetOpen < 0.08 ? 0 : clamp((midShare - 0.08) * 2.5, -0.32, 0.32)
    const open = targetOpen > previousOpen
      ? previousOpen * 0.25 + targetOpen * 0.75
      : previousOpen * 0.55 + targetOpen * 0.45
    const form = previousForm * 0.55 + targetForm * 0.45
    frames.push({ open, form })
    previousOpen = open
    previousForm = form
  }

  return frames
}
