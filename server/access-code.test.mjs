import assert from 'node:assert/strict'
import test from 'node:test'

import { isValidAccessCode } from '../src/access-code.ts'

test('accepts printable ASCII experience codes', () => {
  assert.equal(isValidAccessCode('abcDEF0123-_!'), true)
  assert.equal(isValidAccessCode('x'.repeat(256)), true)
})

test('rejects characters that cannot safely be sent as a header', () => {
  for (const code of ['', '体验码', 'abc中文', 'ａｂｃ', 'abc def', 'abc\n', 'abc\u200b', 'x'.repeat(257)])
    assert.equal(isValidAccessCode(code), false, `unexpectedly accepted ${JSON.stringify(code)}`)
})
