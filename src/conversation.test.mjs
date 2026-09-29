import assert from 'node:assert/strict'
import test from 'node:test'

import { clearConversation, CONVERSATION_STORAGE_KEY, loadConversation, saveConversation } from './conversation.ts'

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
    { role: 'assistant', text: '来啦！', delivery: 'bright' },
  ], storage)
  assert.deepEqual(loadConversation(storage), [
    { role: 'user', text: '你好' },
    { role: 'assistant', text: '来啦！', delivery: 'bright' },
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
    ...Array.from({ length: 30 }, (_, index) => ({
      role: 'user',
      text: `${index}`,
      delivery: 'invented',
    })),
  ]))
  const loaded = loadConversation(storage)
  assert.equal(loaded.length, 24)
  assert.equal(loaded[0].text, '6')
  assert.equal(loaded.at(-1).text, '29')
  assert.ok(loaded.every(message => message.delivery === undefined))
})
