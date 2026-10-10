// Observation policy, not acoustic silence, audibility or voice-activity
// detection. Allow substantially more than 100 ms media-clock quantization;
// a long RAF gap instead means we no longer have continuous observations.
export const PLAYBACK_CLOCK_STALL_MS = 1_500
export const PLAYBACK_CLOCK_MAX_OBSERVATION_GAP_MS = 750

export type PlaybackClockState = 'observing' | 'advancing' | 'stalled'

// The owner must reset on source replacement, pause, seek and disposal. This
// helper neither owns the source nor starts/stops a player, timer or RAF loop.
export function createPlaybackClockGuard() {
  let previousMediaTime: number | null = null
  let previousTimestamp: number | null = null
  let lastAdvanceTimestamp: number | null = null

  const reset = () => {
    previousMediaTime = null
    previousTimestamp = null
    lastAdvanceTimestamp = null
  }

  const observe = (mediaSeconds: number, rafTimestampMs: number): PlaybackClockState => {
    if (!Number.isFinite(mediaSeconds) || mediaSeconds < 0
      || !Number.isFinite(rafTimestampMs) || rafTimestampMs < 0) {
      reset()
      return 'observing'
    }

    if (previousMediaTime === null || previousTimestamp === null
      || lastAdvanceTimestamp === null
      || mediaSeconds < previousMediaTime
      || rafTimestampMs < previousTimestamp
      || rafTimestampMs - previousTimestamp > PLAYBACK_CLOCK_MAX_OBSERVATION_GAP_MS) {
      previousMediaTime = mediaSeconds
      previousTimestamp = lastAdvanceTimestamp = rafTimestampMs
      // A fresh baseline is not evidence that playback resumed. In particular,
      // an owner that already suspended speaking must not reopen on this state.
      return 'observing'
    }

    const advanced = mediaSeconds > previousMediaTime
    previousMediaTime = mediaSeconds
    previousTimestamp = rafTimestampMs
    if (advanced) {
      lastAdvanceTimestamp = rafTimestampMs
      return 'advancing'
    }

    return rafTimestampMs - lastAdvanceTimestamp >= PLAYBACK_CLOCK_STALL_MS
      ? 'stalled'
      : 'observing'
  }

  return { observe, reset }
}
