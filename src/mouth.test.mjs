import assert from 'node:assert/strict'
import test from 'node:test'

import { mouthFrames } from './mouth.ts'

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
