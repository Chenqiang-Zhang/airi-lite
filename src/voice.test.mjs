import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_VOICE, loadVoice, saveVoice, VOICE_OPTIONS, VOICE_STORAGE_KEY } from './voice.ts'

function storage() {
  const values = new Map()
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  }
}

test('voice choice is opt-in and persists in this browser', () => {
  const local = storage()
  assert.equal(loadVoice(local), DEFAULT_VOICE)
  assert.equal(saveVoice('zf_002', local), 'zf_002')
  assert.equal(local.getItem(VOICE_STORAGE_KEY), 'zf_002')
  assert.equal(loadVoice(local), 'zf_002')
})

test('invalid stored or requested voices cannot load arbitrary files', () => {
  const local = storage()
  local.setItem(VOICE_STORAGE_KEY, '../private')
  assert.equal(loadVoice(local), DEFAULT_VOICE)
  assert.throws(() => saveVoice('../private', local), /未知声线/)
  assert.deepEqual(VOICE_OPTIONS.map(option => option.id), ['zf_001', 'zf_002', 'zf_003'])
})

test('a blocked localStorage getter falls back to the default voice', () => {
  const previousWindow = globalThis.window
  globalThis.window = Object.defineProperty({}, 'localStorage', {
    get: () => { throw new DOMException('The operation is insecure.', 'SecurityError') },
  })
  try {
    assert.equal(loadVoice(), DEFAULT_VOICE)
  }
  finally {
    globalThis.window = previousWindow
  }
})
