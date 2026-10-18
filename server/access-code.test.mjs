import assert from 'node:assert/strict'
import test from 'node:test'

import { ACCESS_CODE_STORAGE_KEY, forgetStoredAccessCode, isValidAccessCode, loadStoredAccessCode, storeAccessCode } from '../src/access-code.ts'

test('accepts printable ASCII experience codes', () => {
  assert.equal(isValidAccessCode('abcDEF0123-_!'), true)
  assert.equal(isValidAccessCode('x'.repeat(256)), true)
})

test('rejects characters that cannot safely be sent as a header', () => {
  for (const code of ['', '体验码', 'abc中文', 'ａｂｃ', 'abc def', 'abc\n', 'abc\u200b', 'x'.repeat(257)])
    assert.equal(isValidAccessCode(code), false, `unexpectedly accepted ${JSON.stringify(code)}`)
})

test('the unlocked code is kept for this tab and can be forgotten', () => {
  const values = new Map()
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  }
  assert.equal(loadStoredAccessCode(storage), '')
  storeAccessCode('abcDEF0123', storage)
  assert.equal(values.get(ACCESS_CODE_STORAGE_KEY), 'abcDEF0123')
  assert.equal(loadStoredAccessCode(storage), 'abcDEF0123')
  forgetStoredAccessCode(storage)
  assert.equal(loadStoredAccessCode(storage), '')
})

test('blocked sessionStorage leaves the access code for this page only, without throwing', () => {
  const previousWindow = globalThis.window
  globalThis.window = Object.defineProperty({}, 'sessionStorage', {
    get: () => { throw new DOMException('The operation is insecure.', 'SecurityError') },
  })
  try {
    assert.equal(loadStoredAccessCode(), '')
    assert.doesNotThrow(() => storeAccessCode('abcDEF0123'))
    assert.doesNotThrow(() => forgetStoredAccessCode())
  }
  finally {
    globalThis.window = previousWindow
  }
})
