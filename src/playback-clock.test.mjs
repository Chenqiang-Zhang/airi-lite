import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createPlaybackClockGuard,
  PLAYBACK_CLOCK_MAX_OBSERVATION_GAP_MS,
  PLAYBACK_CLOCK_STALL_MS,
} from './playback-clock.ts'

test('a first finite sample establishes observation, including a nonzero media position', () => {
  for (const time of [0, 0.05, 20_000]) {
    const clock = createPlaybackClockGuard()
    assert.equal(clock.observe(time, 30_000), 'observing')
    assert.equal(clock.observe(time, 30_001), 'observing')
  }
})

test('continuous stationary observations stall only at the no-progress policy boundary', () => {
  const clock = createPlaybackClockGuard()
  const half = PLAYBACK_CLOCK_STALL_MS / 2
  assert.ok(half <= PLAYBACK_CLOCK_MAX_OBSERVATION_GAP_MS)
  assert.equal(clock.observe(0.05, 0), 'observing')
  assert.equal(clock.observe(0.05, half), 'observing')
  assert.equal(clock.observe(0.05, PLAYBACK_CLOCK_STALL_MS - 1), 'observing')
  assert.equal(clock.observe(0.05, PLAYBACK_CLOCK_STALL_MS), 'stalled')
  assert.equal(clock.observe(0.05, PLAYBACK_CLOCK_STALL_MS + 1), 'stalled')
})

test('actual forward media progress recovers a stalled clock without a media event', () => {
  const clock = createPlaybackClockGuard()
  assert.equal(clock.observe(0.05, 0), 'observing')
  for (let now = 500; now <= PLAYBACK_CLOCK_STALL_MS; now += 500)
    clock.observe(0.05, now)
  assert.equal(clock.observe(0.05, PLAYBACK_CLOCK_STALL_MS + 10), 'stalled')
  const resumedAt = PLAYBACK_CLOCK_STALL_MS + 20
  assert.equal(clock.observe(0.15, resumedAt), 'advancing')
  assert.equal(clock.observe(0.15, resumedAt + 500), 'observing')
  assert.equal(clock.observe(0.15, resumedAt + 1000), 'observing')
  assert.equal(clock.observe(0.15, resumedAt + PLAYBACK_CLOCK_STALL_MS), 'stalled')
})

test('100 ms media quantization does not falsely stall normal or low-frame-rate playback', () => {
  for (const fps of [60, 30, 10, 2]) {
    const clock = createPlaybackClockGuard()
    let advances = 0
    for (let frame = 0; frame <= fps * 20; frame++) {
      const timestamp = frame * 1000 / fps
      const mediaTime = Math.floor(timestamp / 100) / 10
      const state = clock.observe(mediaTime, timestamp)
      assert.notEqual(state, 'stalled', `${fps} fps at ${timestamp} ms`)
      if (state === 'advancing') advances++
    }
    assert.ok(advances > 0)
  }
})

test('stall detection uses elapsed observation time, not frame count or render profile', () => {
  for (const fps of [60, 30, 10, 2]) {
    const clock = createPlaybackClockGuard()
    for (let frame = 0; frame <= fps * 3; frame++) {
      const timestamp = frame * 1000 / fps
      assert.equal(clock.observe(0.05, timestamp),
        timestamp >= PLAYBACK_CLOCK_STALL_MS ? 'stalled' : 'observing',
        `${fps} fps at ${timestamp} ms`)
    }
  }
})

test('duplicate RAF timestamps cannot manufacture a long no-progress interval', () => {
  const clock = createPlaybackClockGuard()
  for (let frame = 0; frame < 1000; frame++)
    assert.equal(clock.observe(0.05, 50), 'observing')
  assert.equal(clock.observe(0.15, 50), 'advancing', 'a new media reading is still real progress')
  assert.equal(clock.observe(0.15, 50), 'observing')
})

test('a long background/observation gap re-establishes a baseline without claiming recovery', () => {
  const clock = createPlaybackClockGuard()
  clock.observe(0.05, 0)
  clock.observe(0.05, 500)
  clock.observe(0.05, 1000)
  assert.equal(clock.observe(0.05, 1500), 'stalled')
  const returnAt = 1500 + PLAYBACK_CLOCK_MAX_OBSERVATION_GAP_MS + 1
  assert.equal(clock.observe(5, returnAt), 'observing', 'unobserved advancement is not recovery evidence')
  assert.equal(clock.observe(5, returnAt + 500), 'observing')
  assert.equal(clock.observe(5.1, returnAt + 600), 'advancing')
})

test('an observation gap exactly at the policy limit remains continuous', () => {
  const clock = createPlaybackClockGuard()
  const gap = PLAYBACK_CLOCK_MAX_OBSERVATION_GAP_MS
  assert.equal(clock.observe(0, 0), 'observing')
  for (let now = gap; now < PLAYBACK_CLOCK_STALL_MS; now += gap)
    assert.equal(clock.observe(0, now), 'observing')
  assert.equal(clock.observe(0, PLAYBACK_CLOCK_STALL_MS), 'stalled')
})

test('sparse observations cannot establish a stall, even after a long stationary period', () => {
  const clock = createPlaybackClockGuard()
  const gap = PLAYBACK_CLOCK_MAX_OBSERVATION_GAP_MS + 1
  for (let sample = 0; sample < 100; sample++)
    assert.equal(clock.observe(0.05, sample * gap), 'observing')
})

test('backward media seeks reset elapsed stall evidence rather than claiming advancement', () => {
  const clock = createPlaybackClockGuard()
  clock.observe(8, 0)
  clock.observe(8, 500)
  clock.observe(8, 1000)
  assert.equal(clock.observe(8, 1500), 'stalled')
  assert.equal(clock.observe(2, 1600), 'observing')
  assert.equal(clock.observe(2, 2100), 'observing')
  assert.equal(clock.observe(2.1, 2200), 'advancing')
})

test('a backward RAF timestamp resets a potentially replaced time origin', () => {
  const clock = createPlaybackClockGuard()
  clock.observe(3, 1000)
  clock.observe(3, 1500)
  clock.observe(3, 2000)
  assert.equal(clock.observe(3, 2500), 'stalled')
  assert.equal(clock.observe(4, 10), 'observing')
  assert.equal(clock.observe(4, 510), 'observing')
  assert.equal(clock.observe(4.1, 610), 'advancing')
})

test('invalid readings abandon prior observation without declaring stalled or recovered', () => {
  const invalid = [NaN, Infinity, -Infinity, -1, undefined, null, '0', true, {}, []]
  for (const coordinate of ['media', 'timestamp']) {
    for (const value of invalid) {
      const clock = createPlaybackClockGuard()
      clock.observe(1, 0)
      clock.observe(1, 500)
      clock.observe(1, 1000)
      assert.equal(clock.observe(1, 1500), 'stalled')
      assert.equal(clock.observe(coordinate === 'media' ? value : 1,
        coordinate === 'timestamp' ? value : 1600), 'observing')
      assert.equal(clock.observe(10, 1700), 'observing', `${coordinate}: replacement baseline`)
      assert.equal(clock.observe(10.1, 1800), 'advancing')
    }
  }
})

test('explicit source abandonment reset prevents stale stall evidence from reaching a new source', () => {
  const clock = createPlaybackClockGuard()
  clock.observe(5, 0)
  clock.observe(5, 500)
  clock.observe(5, 1000)
  assert.equal(clock.observe(5, 1500), 'stalled')
  clock.reset()
  clock.reset()
  assert.equal(clock.observe(0, 1600), 'observing')
  assert.equal(clock.observe(0, 2100), 'observing')
  assert.equal(clock.observe(0.1, 2200), 'advancing')
})

test('independent guards do not share playback progress or reset state', () => {
  const first = createPlaybackClockGuard()
  const second = createPlaybackClockGuard()
  first.observe(0.05, 0)
  first.observe(0.05, 500)
  first.observe(0.05, 1000)
  assert.equal(first.observe(0.05, 1500), 'stalled')
  assert.equal(second.observe(20, 1500), 'observing')
  second.reset()
  assert.equal(first.observe(0.05, 1600), 'stalled')
  assert.equal(second.observe(21, 1600), 'observing')
})
