import assert from 'node:assert/strict'
import test from 'node:test'

import { signOpenLiveRequest, stringToSign } from './sign.mjs'

// Expected digests were produced independently with the macOS `md5` and
// `openssl dgst -sha256 -hmac` CLIs, not by this module (see the M4
// verification doc). Credentials here are placeholders.
test('signs the documented x-bili-* headers with seconds and lowercase hex HMAC-SHA256', () => {
  const body = '{"code":"TESTCODE","app_id":1234567890123}'
  const headers = signOpenLiveRequest({
    body,
    accessKeyId: 'test-access-key-id',
    accessKeySecret: 'test-access-key-secret',
    nonce: 'ad184c09-6d5c-4a5f-a8a1-6ac2b1c4e8a4',
    now: () => 1_760_000_000_999,
  })
  assert.deepEqual(headers, {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'x-bili-accesskeyid': 'test-access-key-id',
    'x-bili-content-md5': '44ab760bf4b433ab4d68e93cd7ac4bb6',
    'x-bili-signature-method': 'HMAC-SHA256',
    'x-bili-signature-nonce': 'ad184c09-6d5c-4a5f-a8a1-6ac2b1c4e8a4',
    'x-bili-signature-version': '1.0',
    'x-bili-timestamp': '1760000000',
    Authorization: 'e758cadd798d7263f6e5cc25d432f0c7784abef6555c26a7668a73835b6d8ca2',
  })
})

test('the content MD5 covers the exact UTF-8 body string and the signature changes with it', () => {
  const headers = signOpenLiveRequest({
    body: '{"game_id":"0f1e2d3c-测试"}', accessKeyId: 'AKID', accessKeySecret: 'S3CRET',
    nonce: 'nonce-2', now: () => 1_700_000_000_000,
  })
  assert.equal(headers['x-bili-content-md5'], 'bcb041eb97593a8e181ba2ad75b4eb90')
  assert.equal(headers.Authorization, '3a3bb0171c91ba31b0e79133c118d10923d436d7d2877bd0b3e12d90c601256d')
  const reordered = signOpenLiveRequest({
    body: '{ "game_id":"0f1e2d3c-测试"}', accessKeyId: 'AKID', accessKeySecret: 'S3CRET',
    nonce: 'nonce-2', now: () => 1_700_000_000_000,
  })
  assert.notEqual(reordered['x-bili-content-md5'], headers['x-bili-content-md5'])
  assert.notEqual(reordered.Authorization, headers.Authorization)
})

test('the string to sign is sorted, newline-joined, without a trailing newline and ignores other headers', () => {
  assert.equal(stringToSign({
    'x-bili-timestamp': '1', Accept: 'application/json', 'x-bili-accesskeyid': 'a', 'x-bili-content-md5': 'm',
  }), 'x-bili-accesskeyid:a\nx-bili-content-md5:m\nx-bili-timestamp:1')
})

test('nonces default to unique UUIDs and the body must already be a string', () => {
  const sign = () => signOpenLiveRequest({ body: '{}', accessKeyId: 'a', accessKeySecret: 'b' })
  const first = sign()['x-bili-signature-nonce']
  assert.match(first, /^[0-9a-f-]{36}$/)
  assert.notEqual(first, sign()['x-bili-signature-nonce'])
  assert.throws(() => signOpenLiveRequest({ body: { code: 1 }, accessKeyId: 'a', accessKeySecret: 'b' }), TypeError)
})

test('the secret never appears in the produced headers', () => {
  const headers = signOpenLiveRequest({ body: '{}', accessKeyId: 'id', accessKeySecret: 'very-secret-value' })
  assert.ok(!JSON.stringify(headers).includes('very-secret-value'))
})
