import assert from 'node:assert/strict'
import test from 'node:test'

import { clearUserMemory, loadUserMemory, saveUserMemory, USER_MEMORY_LIMIT, USER_MEMORY_STORAGE_KEY } from './memory.ts'

function memoryStorage() {
  const values = new Map()
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  }
}

test('memory is stored only after an explicit save and can be cleared', () => {
  const storage = memoryStorage()
  assert.equal(loadUserMemory(storage), '')
  assert.equal(saveUserMemory('  可以叫我小陈。  ', storage), '可以叫我小陈。')
  assert.equal(loadUserMemory(storage), '可以叫我小陈。')
  clearUserMemory(storage)
  assert.equal(storage.getItem(USER_MEMORY_STORAGE_KEY), null)
})

test('memory is bounded and empty saves remove the stored value', () => {
  const storage = memoryStorage()
  saveUserMemory('a'.repeat(USER_MEMORY_LIMIT + 100), storage)
  assert.equal(loadUserMemory(storage).length, USER_MEMORY_LIMIT)
  saveUserMemory('   ', storage)
  assert.equal(loadUserMemory(storage), '')
})
