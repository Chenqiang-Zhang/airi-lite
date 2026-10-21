import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { ACT_PAUSE_SECONDS, ACTS, EMOTIONS, isAct, isEmotion, MAX_ACTS_PER_REPLY, normaliseActCues, normaliseEmotion } from './performance-cues.mjs'

test('one vocabulary: eight emotions, three acts, and bright read as happy', () => {
  assert.deepEqual(EMOTIONS, ['neutral', 'happy', 'soft', 'curious', 'surprised', 'sad', 'pout', 'shy'])
  assert.deepEqual(ACTS, ['laugh', 'sigh', 'pause'])
  assert.equal(normaliseEmotion('bright'), 'happy')
  assert.equal(isEmotion('bright'), false, 'an alias is input only')
  for (const value of ['angry', '', 'HAPPY', '__proto__', 'constructor', null, 1])
    assert.equal(normaliseEmotion(value), null, String(value))
  assert.equal(isAct('laugh'), true)
  assert.equal(isAct('cry'), false)
  assert.equal(MAX_ACTS_PER_REPLY, 1)
  assert.ok(ACT_PAUSE_SECONDS > 0 && ACT_PAUSE_SECONDS < 1)
})

test('act cues are validated, ordered and capped at one per reply', () => {
  assert.deepEqual(normaliseActCues([{ start: 5, act: 'sigh' }, { start: 2, act: 'laugh' }], 10), [{ start: 2, act: 'laugh' }])
  assert.deepEqual(normaliseActCues([{ start: 10, act: 'laugh' }, { start: -1, act: 'laugh' }, { start: 1.5, act: 'laugh' }, { start: 1, act: 'cry' }, null], 10), [])
  assert.deepEqual(normaliseActCues('nope', 10), [])
  assert.deepEqual(normaliseActCues([{ start: 0, act: 'pause', extra: 1 }], 3), [{ start: 0, act: 'pause' }], 'only start and act are kept')
})

test('the type declarations list the same values as the module', async () => {
  const declarations = await readFile(new URL('./performance-cues.d.mts', import.meta.url), 'utf8')
  const union = name => [...new RegExp(`export type ${name} = ([^\\n]+)`).exec(declarations)[1].matchAll(/'([a-z]+)'/g)].map(match => match[1])
  assert.deepEqual(union('Emotion'), [...EMOTIONS])
  assert.deepEqual(union('Act'), [...ACTS])
})
