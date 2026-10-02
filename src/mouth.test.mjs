import assert from 'node:assert/strict'
import test from 'node:test'

import { MOUTH_FRAMES_PER_SECOND, mouthAtTime, mouthFrames } from './mouth.ts'

function sine(frequency, sampleRate = 24_000, seconds = 0.3) {
  return Float32Array.from({ length: Math.round(sampleRate * seconds) }, (_, index) =>
    0.12 * Math.sin(2 * Math.PI * frequency * index / sampleRate))
}

test('silence keeps mouth closed without inventing a vowel shape', () => {
  const frames = mouthFrames(new Float32Array(2_400), 24_000)
  assert.equal(frames.length, 4)
  assert.ok(frames.every(frame => frame.open === 0 && frame.form === 0))
})

test('audio brightness changes mouth form while both sounds drive opening', () => {
  const rounded = mouthFrames(sine(400), 24_000)
  const spread = mouthFrames(sine(2_500), 24_000)
  const middle = Math.floor(rounded.length / 2)
  assert.ok(rounded[middle].open > 0.1)
  assert.ok(spread[middle].open > 0.1)
  assert.ok(rounded[middle].form < 0)
  assert.ok(spread[middle].form > 0)
})

test('mouth frames remain bounded and follow the audio duration', () => {
  const frames = mouthFrames(sine(1_400, 24_000, 1), 24_000)
  assert.equal(frames.length, 40)
  assert.ok(frames.every(frame => frame.open >= 0 && frame.open <= 1 && frame.form >= -0.32 && frame.form <= 0.32))
  assert.deepEqual(mouthFrames(sine(400), 0), [])
})

test('per-clip calibration gives quiet and loud versions the same jaw and form without changing PCM', () => {
  const original = sine(700, 44_100, 0.8)
  const snapshot = original.slice()
  const baseline = mouthFrames(original, 44_100)
  for (const scale of [0.05, 0.25, 4]) {
    const scaled = original.map(value => value * scale)
    const frames = mouthFrames(scaled, 44_100)
    for (let index = 0; index < frames.length; index++) {
      assert.ok(Math.abs(frames[index].open - baseline[index].open) < 1e-6)
      assert.ok(Math.abs(frames[index].form - baseline[index].form) < 1e-6)
    }
  }
  assert.deepEqual(original, snapshot)
  assert.ok(baseline[15].open > 0.5 && baseline[15].open < 0.7)
})

test('calibration keeps syllable-level dynamics instead of flattening every frame', () => {
  const samples = sine(400, 24_000, 0.8)
  for (let index = 0; index < samples.length / 2; index++) samples[index] *= 0.25
  const frames = mouthFrames(samples, 24_000)
  assert.ok(frames[10].open > 0.1 && frames[10].open < 0.2)
  assert.ok(frames[25].open > 0.5 && frames[25].open < 0.7)
})

test('an isolated click does not set the calibration and near-zero audio stays closed', () => {
  const samples = sine(400, 24_000, 2)
  const baseline = mouthFrames(samples, 24_000)
  samples[24_000] = 1
  const clicked = mouthFrames(samples, 24_000)
  assert.ok(Math.abs(clicked[20].open - baseline[20].open) < 1e-6)
  assert.ok(Math.abs(clicked[70].open - baseline[70].open) < 1e-6)
  const nearZero = sine(400).map(value => value * 0.0005)
  assert.ok(mouthFrames(nearZero, 24_000).every(frame => frame.open === 0 && frame.form === 0))
})

test('very low-level background between speech regions is gated and silence closes within two frames', () => {
  const samples = sine(400, 24_000, 0.8)
  samples.fill(0, 0, 2400)
  for (let index = 9600; index < 12000; index++) samples[index] *= 0.015
  samples.fill(0, 14400)
  const frames = mouthFrames(samples, 24_000)
  assert.deepEqual(frames.slice(0, 4), Array.from({ length: 4 }, () => ({ open: 0, form: 0 })))
  assert.ok(frames.slice(17, 20).every(frame => frame.open === 0 && frame.form === 0))
  assert.ok(frames.slice(25).every(frame => frame.open === 0 && frame.form === 0))
})

test('a long faint tail cannot outvote a short spoken region or a single click', () => {
  const rate = 24_000
  for (const withClick of [false, true]) {
    const samples = Float32Array.from({ length: rate * 3 }, (_, index) =>
      (index < rate * 0.2 ? 0.1 : 0.001) * Math.sin(2 * Math.PI * 400 * index / rate))
    if (withClick) samples[rate] = 1
    const frames = mouthFrames(samples, rate)
    assert.ok(frames[5].open > 0.5 && frames[5].open < 0.7)
    assert.ok(frames.slice(10, 39).every(frame => frame.open === 0 && frame.form === 0))
    assert.ok(frames.slice(43).every(frame => frame.open === 0 && frame.form === 0))
  }
})

test('time-derived boundaries have exactly 40 frames per second across common sample rates', () => {
  assert.equal(MOUTH_FRAMES_PER_SECOND, 40)
  for (const rate of [8000, 22050, 24000, 32000, 44100, 48000, 96000]) {
    const frames = mouthFrames(sine(400, rate, 1), rate)
    assert.equal(frames.length, 40, `${rate} Hz`)
    assert.equal(mouthFrames(sine(400, rate, 1).slice(0, rate - 1), rate).length, 40)
    assert.equal(mouthFrames(new Float32Array(rate + 1), rate).length, 41)
  }
  // A fixed floor(44100/40) step would put this late onset in the wrong frame.
  const rate = 44100
  const samples = new Float32Array(rate * 180)
  const onset = Math.floor((7200 - 1) * rate / 40)
  for (let index = onset; index < samples.length; index++)
    samples[index] = 0.12 * Math.sin(2 * Math.PI * 400 * index / rate)
  const frames = mouthFrames(samples, rate)
  assert.equal(frames.length, 7200)
  assert.ok(frames.slice(0, 7199).every(frame => frame.open === 0))
  assert.ok(frames[7199].open > 0.1)
})

test('invalid rates, empty buffers and non-finite samples cannot produce invalid model values', () => {
  for (const rate of [0, -1, NaN, Infinity]) assert.deepEqual(mouthFrames(sine(400), rate), [])
  assert.deepEqual(mouthFrames(new Float32Array(), 24_000), [])
  const frames = mouthFrames(Float32Array.from([NaN, Infinity, -Infinity, 0]), 24_000)
  assert.deepEqual(frames, [{ open: 0, form: 0 }])
})

test('timeline lookup respects clip boundaries, gaps, partial frames and reverse seeks', () => {
  const a = [{ open: 0.2, form: -0.1 }, { open: 0.6, form: 0.1 }]
  const b = [{ open: 0.8, form: 0.2 }]
  const segments = [{ time: 0.1, duration: 0.037, frames: a }, { time: 0.2, duration: 0.017, frames: b }]
  for (const [time, expected] of [[0.1, a[0]], [0.125, a[1]], [0.136, a[1]], [0.2, b[0]], [0.1, a[0]], [0.125, a[1]]])
    assert.deepEqual(mouthAtTime(segments, time), expected)
  for (const time of [-1, NaN, Infinity, 0, 0.137, 0.19, 0.217, 1])
    assert.deepEqual(mouthAtTime(segments, time), { open: 0, form: 0 })
  assert.deepEqual(mouthAtTime([], 0), { open: 0, form: 0 })
  assert.deepEqual(mouthAtTime([{ time: 0, duration: 1, frames: [] }], 0.1), { open: 0, form: 0 })
})
