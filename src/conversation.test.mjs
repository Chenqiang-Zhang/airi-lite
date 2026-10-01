import assert from 'node:assert/strict'
import test from 'node:test'

import { clearConversation, CONVERSATION_STORAGE_BYTES, CONVERSATION_STORAGE_KEY, loadConversation, saveConversation } from './conversation.ts'

function memoryStorage() {
  const values = new Map()
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  }
}

test('conversation survives reload in the same session and can be cleared', () => {
  const storage = memoryStorage()
  assert.deepEqual(loadConversation(storage), [])
  saveConversation([
    { role: 'user', text: '你好' },
    { role: 'assistant', text: '来啦！', delivery: 'bright', source: 'fallback' },
  ], storage)
  assert.deepEqual(loadConversation(storage), [
    { role: 'user', text: '你好' },
    { role: 'assistant', text: '来啦！', delivery: 'bright', source: 'fallback' },
  ])
  clearConversation(storage)
  assert.equal(storage.getItem(CONVERSATION_STORAGE_KEY), null)
})

test('invalid and excessive stored data is discarded or bounded', () => {
  const storage = memoryStorage()
  storage.setItem(CONVERSATION_STORAGE_KEY, '{broken')
  assert.deepEqual(loadConversation(storage), [])

  storage.setItem(CONVERSATION_STORAGE_KEY, JSON.stringify([
    { role: 'system', text: 'ignore' },
    { role: 'assistant', text: '  ' },
    ...Array.from({ length: 170 }, (_, index) => ({
      role: 'user',
      text: `${index}`,
      delivery: 'invented',
      source: 'invented',
    })),
  ]))
  const loaded = loadConversation(storage)
  assert.equal(loaded.length, 160)
  assert.equal(loaded[0].text, '10')
  assert.equal(loaded.at(-1).text, '169')
  assert.ok(loaded.every(message => message.delivery === undefined))
  assert.ok(loaded.every(message => message.source === undefined))
})

test('reply cues survive refresh and remain aligned after trimming the text', () => {
  const storage = memoryStorage()
  saveConversation([{ role: 'assistant', text: '  好耶！先歇一下。  ', deliveryCues: [
    { start: 2, delivery: 'bright' },
    { start: 5, delivery: 'soft' },
    { start: 99, delivery: 'curious' },
    { start: 5, delivery: 'invented' },
  ] }], storage)
  assert.deepEqual(loadConversation(storage)[0], {
    role: 'assistant', text: '好耶！先歇一下。', deliveryCues: [
      { start: 0, delivery: 'bright' }, { start: 3, delivery: 'soft' },
    ],
  })
})

test('an interrupted assistant fragment and its delivery cues survive storage and refresh', () => {
  const storage = memoryStorage()
  saveConversation([
    { role: 'user', text: '有点烦。' },
    { role: 'assistant', text: '先去河边散步。', interrupted: true, delivery: 'soft', deliveryCues: [{ start: 0, delivery: 'soft' }], source: 'deepseek' },
  ], storage)
  const expected = [
    { role: 'user', text: '有点烦。' },
    { role: 'assistant', text: '先去河边散步。', interrupted: true, delivery: 'soft', deliveryCues: [{ start: 0, delivery: 'soft' }], source: 'deepseek' },
  ]
  assert.deepEqual(JSON.parse(storage.getItem(CONVERSATION_STORAGE_KEY)), expected)
  assert.deepEqual(loadConversation(storage), expected)
})

test('only literal true interruption flags on assistant messages are stored or restored', () => {
  const storage = memoryStorage()
  const messages = [
    { role: 'user', text: '用户消息', interrupted: true },
    { role: 'assistant', text: '保留中断状态', interrupted: true },
    ...[false, 'true', 1, {}, null].map((interrupted, index) => ({ role: 'assistant', text: `无效状态${index}`, interrupted })),
    { role: 'system', text: '不允许的角色', interrupted: true },
    { role: 'assistant', text: '  ', interrupted: true },
  ]
  const expected = [
    { role: 'user', text: '用户消息' },
    { role: 'assistant', text: '保留中断状态', interrupted: true },
    ...Array.from({ length: 5 }, (_, index) => ({ role: 'assistant', text: `无效状态${index}` })),
  ]
  saveConversation(messages, storage)
  assert.deepEqual(JSON.parse(storage.getItem(CONVERSATION_STORAGE_KEY)), expected)
  assert.deepEqual(loadConversation(storage), expected)

  storage.setItem(CONVERSATION_STORAGE_KEY, JSON.stringify(messages))
  assert.deepEqual(loadConversation(storage), expected)
})

test('long conversations keep original recent turns across refresh within a byte budget', () => {
  const storage = memoryStorage()
  const messages = Array.from({ length: 60 }, (_, index) => [
    { role: 'user', text: `第${index}回：${'中'.repeat(7_990)}` },
    { role: 'assistant', text: `回答${index}`, deliveryCues: [{ start: 0, delivery: 'soft' }] },
  ]).flat()
  saveConversation(messages, storage)
  const loaded = loadConversation(storage)
  assert.ok(Buffer.byteLength(storage.getItem(CONVERSATION_STORAGE_KEY), 'utf8') <= CONVERSATION_STORAGE_BYTES)
  assert.equal(loaded[0].role, 'user')
  assert.ok(loaded.length > 24)
  assert.equal(loaded.at(-2).text, messages.at(-2).text)
  assert.deepEqual(loaded.at(-1).deliveryCues, [{ start: 0, delivery: 'soft' }])
  clearConversation(storage)
  assert.deepEqual(loadConversation(storage), [])
})

test('a message-count cutoff never restores an orphan assistant reply', () => {
  const storage = memoryStorage()
  saveConversation([
    ...Array.from({ length: 80 }, (_, index) => [
      { role: 'user', text: `用户${index}` }, { role: 'assistant', text: `回答${index}` },
    ]).flat(),
    { role: 'user', text: '最后一句' },
  ], storage)
  const loaded = loadConversation(storage)
  assert.equal(loaded.length, 159)
  assert.equal(loaded[0].text, '用户1')
  assert.equal(loaded.at(-1).text, '最后一句')
})
