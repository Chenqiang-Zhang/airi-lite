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

function readChunks(chunks) {
  const parser = createDeliveryCueParser()
  const result = []
  for (const event of [...chunks.flatMap(chunk => parser.push(chunk)), ...parser.finish()]) {
    const previous = result.at(-1)
    if (event.type === 'delta' && previous?.type === 'delta')
      previous.content += event.content
    else
      result.push({ ...event })
  }
  return result
}

test('orders sentence-level cues with their text and preserves paragraph breaks', () => {
  const parser = createDeliveryCueParser()
  assert.deepEqual(parser.push('[[tone:bright]]好耶！\n\n[[tone:soft]] 但你累了就休息。\n[[tone:curious]]想聊什么？'), [
    { type: 'delivery', value: 'bright' },
    { type: 'delta', content: '好耶！\n\n' },
    { type: 'delivery', value: 'soft' },
    { type: 'delta', content: ' 但你累了就休息。\n' },
    { type: 'delivery', value: 'curious' },
    { type: 'delta', content: '想聊什么？' },
  ])
})

test('recognizes multiple cues at every possible split and in single-character deltas', () => {
  const reply = '  [[tone:bright]]\n好耶！\n\n[[tone:soft]]别急。[[tone:unknown]]\n[[tone:curious]]为什么？'
  const expected = [
    { type: 'delivery', value: 'bright' },
    { type: 'delta', content: '好耶！\n\n' },
    { type: 'delivery', value: 'soft' },
    { type: 'delta', content: '别急。\n' },
    { type: 'delivery', value: 'curious' },
    { type: 'delta', content: '为什么？' },
  ]
  for (let split = 0; split <= reply.length; split++)
    assert.deepEqual(readChunks([reply.slice(0, split), reply.slice(split)]), expected, `split ${split}`)
  assert.deepEqual(readChunks([...reply]), expected)
  for (let width = 2; width <= 17; width++) {
    const chunks = []
    for (let index = 0; index < reply.length; index += width)
      chunks.push(reply.slice(index, index + width))
    assert.deepEqual(readChunks(chunks), expected, `chunk width ${width}`)
  }
})

test('streams text before a split mid-reply marker immediately', () => {
  const parser = createDeliveryCueParser()
  assert.deepEqual(parser.push('第一句。\n[[to'), [{ type: 'delta', content: '第一句。\n' }])
  assert.deepEqual(parser.push('ne:soft]'), [])
  assert.deepEqual(parser.push(']\n第二句。'), [
    { type: 'delivery', value: 'soft' },
    { type: 'delta', content: '\n第二句。' },
  ])
  assert.deepEqual(parser.push('\n普通正文'), [{ type: 'delta', content: '\n普通正文' }])
})

test('does not drop unfinished mid-reply markers or normal brackets', () => {
  const reply = '正文 [链接] 结束。\n[[tone:soft'
  assert.deepEqual(readChunks([...reply]), [{ type: 'delta', content: reply }])
})

test('bounds marker and opening-whitespace buffering without losing oversized text', () => {
  const oversized = '[[tone:' + 'a'.repeat(200) + ']]'
  const parser = createDeliveryCueParser()
  let firstOutputAt = 0
  const events = []
  for (let index = 0; index < oversized.length; index++) {
    const next = parser.push(oversized[index])
    if (next.length && !firstOutputAt)
      firstOutputAt = index + 1
    events.push(...next)
  }
  events.push(...parser.finish())
  assert.ok(firstOutputAt <= 48, 'oversized candidates must start flowing at the buffer limit')
  assert.equal(events.map(event => event.content).join(''), oversized)
  assert.deepEqual(readChunks([oversized, '[[tone:soft]]恢复。']), [
    { type: 'delta', content: oversized },
    { type: 'delivery', value: 'soft' },
    { type: 'delta', content: '恢复。' },
  ])
  const whitespaceParser = createDeliveryCueParser()
  assert.deepEqual(whitespaceParser.push(' '.repeat(33)), [{ type: 'delta', content: ' '.repeat(33) }])
})

test('keeps malformed candidates literal and removes bounded unknown labels anywhere', () => {
  const reply = '正文[[tone:bad]label]]\n[[tone:]][[tone:unsupported]][[tone:soft]]别急。'
  const expected = [
    { type: 'delta', content: '正文[[tone:bad]label]]\n' },
    { type: 'delivery', value: 'soft' },
    { type: 'delta', content: '别急。' },
  ]
  assert.deepEqual(readChunks([reply]), expected)
  assert.deepEqual(readChunks([...reply]), expected)
})
