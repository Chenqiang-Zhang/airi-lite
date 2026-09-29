import assert from 'node:assert/strict'
import test from 'node:test'

import { createDeliveryCueParser } from './delivery-cue.mjs'

test('parses a cue split across DeepSeek stream deltas', () => {
  const parser = createDeliveryCueParser()
  assert.deepEqual(parser.push('  [[to'), [])
  assert.deepEqual(parser.push('ne:soft]]\n \n别急'), [
    { type: 'delivery', value: 'soft' },
    { type: 'delta', content: '别急' },
  ])
  assert.deepEqual(parser.push('，先喝口水。'), [{ type: 'delta', content: '，先喝口水。' }])
  assert.deepEqual(parser.finish(), [])
})

test('streams untagged replies without waiting for punctuation', () => {
  const parser = createDeliveryCueParser()
  assert.deepEqual(parser.push('嘿，'), [{ type: 'delta', content: '嘿，' }])
  assert.deepEqual(parser.push('我在！'), [{ type: 'delta', content: '我在！' }])
})

test('drops unknown tone labels without exposing them to the user', () => {
  const parser = createDeliveryCueParser()
  assert.deepEqual(parser.push('[[tone:excited]]好耶！'), [{ type: 'delta', content: '好耶！' }])
})

test('removes whitespace that arrives after a marker in later deltas', () => {
  const parser = createDeliveryCueParser()
  assert.deepEqual(parser.push('[[tone:curious]]'), [{ type: 'delivery', value: 'curious' }])
  assert.deepEqual(parser.push('\n '), [])
  assert.deepEqual(parser.push(' 为什么？'), [{ type: 'delta', content: '为什么？' }])
})

test('does not silently lose an unfinished opening marker', () => {
  const parser = createDeliveryCueParser()
  assert.deepEqual(parser.push('[[tone:bri'), [])
  assert.deepEqual(parser.finish(), [{ type: 'delta', content: '[[tone:bri' }])
})
