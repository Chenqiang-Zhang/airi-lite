import assert from 'node:assert/strict'
import test from 'node:test'

import { clearUserMemory, loadUserMemory, proposeUserMemory, saveUserMemory, USER_MEMORY_LIMIT, USER_MEMORY_STORAGE_KEY } from './memory.ts'

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

test('a selected message only changes the draft and never writes storage', () => {
  const storage = memoryStorage()
  saveUserMemory('叫我小陈。', storage)
  const draft = proposeUserMemory(loadUserMemory(storage), '我喜欢柠檬茶。')
  assert.equal(draft, '叫我小陈。\n我喜欢柠檬茶。')
  assert.equal(loadUserMemory(storage), '叫我小陈。')
  assert.equal(proposeUserMemory(draft, '我喜欢柠檬茶。'), draft)
})

test('a proposed message is not silently truncated when memory is full', () => {
  const existing = 'a'.repeat(USER_MEMORY_LIMIT - 2)
  assert.equal(proposeUserMemory(existing, '我喜欢柠檬茶。'), existing)
})
