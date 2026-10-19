import { createHash, createHmac, randomUUID } from 'node:crypto'

// The only documented host. The test domain is unavailable (4001).
export const OPEN_LIVE_ORIGIN = 'https://live-open.biliapi.com'

// Bilibili live open-platform request signing (鉴权文档). Every API call is a
// POST of a JSON body. The x-bili-* headers, sorted by key and written as
// `key:value` joined with "\n" (no leading/trailing newline), are signed with
// HMAC-SHA256 using the access key secret; the lowercase hex digest is the
// Authorization header verbatim, without a scheme prefix.
// The timestamp is in SECONDS: the 2022 official JS demo used Date.now()
// milliseconds, which contradicts the auth document. Check this first if the
// very first real start is rejected (4003 or similar).
export function signOpenLiveRequest({ body, accessKeyId, accessKeySecret, nonce = randomUUID(), now = Date.now }) {
  if (typeof body !== 'string')
    throw new TypeError('body must be the exact JSON string that will be sent')
  const signed = {
    'x-bili-accesskeyid': accessKeyId,
    'x-bili-content-md5': createHash('md5').update(body, 'utf8').digest('hex'),
    'x-bili-signature-method': 'HMAC-SHA256',
    'x-bili-signature-nonce': nonce,
    'x-bili-signature-version': '1.0',
    'x-bili-timestamp': String(Math.floor(now() / 1_000)),
  }
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...signed,
    Authorization: createHmac('sha256', accessKeySecret).update(stringToSign(signed), 'utf8').digest('hex'),
  }
}

export function stringToSign(headers) {
  return Object.keys(headers)
    .filter(key => key.toLowerCase().startsWith('x-bili-'))
    .sort()
    .map(key => `${key}:${headers[key]}`)
    .join('\n')
}
