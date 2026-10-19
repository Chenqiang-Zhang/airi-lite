import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'

import { checkLocalHost, checkLocalRequest, LiveRequestError, readSmallJson } from './local-request.mjs'

const PORT = 4176
function request({ method = 'GET', remoteAddress = '127.0.0.1', localPort = PORT, headers = {} } = {}) {
  return { method, socket: { remoteAddress, localPort }, headers: { host: `127.0.0.1:${PORT}`, ...headers } }
}
const post = headers => request({ method: 'POST', headers: { 'content-type': 'application/json', 'x-airi-live': '1', ...headers } })

test('a direct loopback request with the right host is allowed', () => {
  for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1'])
    assert.equal(checkLocalRequest(request({ remoteAddress })), null)
  for (const host of [`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`])
    assert.equal(checkLocalRequest(request({ headers: { host, origin: `http://${host}` } })), null)
  assert.equal(checkLocalRequest(post({ 'content-type': 'application/json; charset=utf-8' })), null)
})

test('remote sockets and anything a proxy would add are refused', () => {
  assert.deepEqual(checkLocalRequest(request({ remoteAddress: '192.168.1.20' })), { status: 403, code: 'LIVE_NOT_LOCAL' })
  assert.deepEqual(checkLocalRequest(request({ remoteAddress: null })), { status: 403, code: 'LIVE_NOT_LOCAL' })
  for (const header of ['x-real-ip', 'x-forwarded-for', 'forwarded'])
    assert.deepEqual(checkLocalRequest(request({ headers: { [header]: '127.0.0.1' } })), { status: 403, code: 'LIVE_NOT_LOCAL' })
})

test('DNS-rebinding hosts, other ports and foreign origins are refused', () => {
  for (const host of ['evil.test', `evil.test:${PORT}`, `127.0.0.1:${PORT + 1}`, '127.0.0.1', undefined])
    assert.deepEqual(checkLocalRequest(request({ headers: { host } })), { status: 403, code: 'LIVE_BAD_HOST' })
  assert.deepEqual(checkLocalRequest(request({ localPort: null })), { status: 403, code: 'LIVE_BAD_HOST' })
  for (const origin of ['http://evil.test', `https://127.0.0.1:${PORT}`, `http://localhost:${PORT}`, 'null'])
    assert.deepEqual(checkLocalRequest(request({ headers: { origin } })), { status: 403, code: 'LIVE_BAD_ORIGIN' })
})

test('browser-labelled cross-site or no-origin GETs cannot open a stage stream', () => {
  // EventSource from our own page is same-origin; an <img>, a third-party
  // overlay in OBS or a typed URL is not, and sends no Origin for a GET.
  for (const site of ['cross-site', 'same-site', 'none'])
    assert.deepEqual(checkLocalRequest(request({ headers: { 'sec-fetch-site': site, 'sec-fetch-mode': 'no-cors' } })),
      { status: 403, code: 'LIVE_BAD_ORIGIN' }, site)
  assert.equal(checkLocalRequest(request({ headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' } })), null)
  assert.equal(checkLocalRequest(post({ 'sec-fetch-site': 'same-origin' })), null)
})

test('checkLocalHost alone accepts only loopback names on the socket port', () => {
  assert.equal(checkLocalHost(request()), null)
  assert.equal(checkLocalHost(request({ remoteAddress: '192.168.1.20' })), null, 'host only; the socket is checked separately')
  for (const host of ['evil.example', `evil.example:${PORT}`, `127.0.0.1:${PORT + 1}`])
    assert.deepEqual(checkLocalHost(request({ headers: { host } })), { status: 403, code: 'LIVE_BAD_HOST' })
})

test('writes need JSON plus the custom header, which forces a CORS preflight', () => {
  for (const headers of [{ 'x-airi-live': undefined }, { 'x-airi-live': 'yes' }, { 'content-type': 'text/plain' },
    { 'content-type': 'application/x-www-form-urlencoded' }, { 'content-type': undefined }])
    assert.deepEqual(checkLocalRequest(post(headers)), { status: 403, code: 'LIVE_BAD_REQUEST_HEADERS' })
  // EventSource cannot send custom headers, so GET does not require it.
  assert.equal(checkLocalRequest(request()), null)
})

test('bodies are small JSON objects only', async () => {
  assert.deepEqual(await readSmallJson(Readable.from([Buffer.from('{"action":"stop"}')])), { action: 'stop' })
  for (const [body, code] of [['x'.repeat(2_049), 'LIVE_REQUEST_TOO_LARGE'], ['{bad', 'LIVE_INVALID_REQUEST'],
    ['[1]', 'LIVE_INVALID_REQUEST'], ['null', 'LIVE_INVALID_REQUEST'], ['', 'LIVE_INVALID_REQUEST']]) {
    await assert.rejects(readSmallJson(Readable.from([Buffer.from(body)])),
      error => error instanceof LiveRequestError && error.status === 400 && error.code === code)
  }
  await assert.rejects(readSmallJson(Readable.from([Buffer.from([0x7b, 0xff, 0x7d])])),
    error => error.code === 'LIVE_INVALID_REQUEST', 'malformed UTF-8 is refused')
  assert.deepEqual(await readSmallJson(Readable.from([Buffer.from(`{"t":"${'x'.repeat(3_000)}"}`)]), 4_096),
    { t: 'x'.repeat(3_000) })
})
