import assert from 'node:assert/strict'
import test from 'node:test'

import { SentenceBuffer } from './sentence-buffer.ts'

test('keeps names split across streaming deltas intact', () => {
  const buffer = new SentenceBuffer()
  assert.deepEqual(buffer.push('Deep'), [])
  assert.deepEqual(buffer.push('Seek 今天好快。下'), ['DeepSeek 今天好快。'])
  assert.deepEqual(buffer.push('一句呢？'), ['下一句呢？'])
  assert.deepEqual(buffer.finish(), [])
})

test('flushes text without final punctuation', () => {
  const buffer = new SentenceBuffer()
  assert.deepEqual(buffer.push('嗯，我在'), [])
  assert.deepEqual(buffer.finish(), ['嗯，我在'])
})

test('bounds long unpunctuated text at a comma when possible', () => {
  const buffer = new SentenceBuffer()
  const text = `${'今天很开心'.repeat(24)}，${'我们继续聊'.repeat(24)}`
  const ready = buffer.push(text)
  assert.ok(ready.length >= 1)
  assert.equal([...ready, ...buffer.finish()].join(''), text)
})
