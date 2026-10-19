// The live subsystem controls a public broadcast and spends paid speech, so
// every /api/live/* request must come from this machine, directly. This does
// not use app.mjs clientIp(): that trusts X-Real-IP from a loopback proxy.
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const PROXY_HEADERS = ['x-real-ip', 'x-forwarded-for', 'forwarded']

export class LiveRequestError extends Error {
  constructor(status, code) {
    super(code)
    this.status = status
    this.code = code
  }
}

// The Host allowlist uses the socket's own port, so DNS-rebinding names and
// other ports never match. In live mode app.mjs applies it to every route:
// the public chat/speech routes share the stage's speech slots and ledger.
export function checkLocalHost(request) {
  const port = request.socket?.localPort
  if (!port || ![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(request.headers.host))
    return { status: 403, code: 'LIVE_BAD_HOST' }
  return null
}

// Returns null when allowed, otherwise {status, code}.
export function checkLocalRequest(request) {
  const socket = request.socket ?? {}
  if (!LOOPBACK_ADDRESSES.has(socket.remoteAddress))
    return { status: 403, code: 'LIVE_NOT_LOCAL' }
  // A reverse proxy (production Nginx) always adds one of these. Refuse them
  // even from loopback so a deployed server can never expose live control.
  if (PROXY_HEADERS.some(name => request.headers[name] !== undefined))
    return { status: 403, code: 'LIVE_NOT_LOCAL' }
  const badHost = checkLocalHost(request)
  if (badHost)
    return badHost
  const origin = request.headers.origin
  if (origin !== undefined && origin !== `http://${request.headers.host}`)
    return { status: 403, code: 'LIVE_BAD_ORIGIN' }
  // A cross-site no-cors GET (an <img>, a third-party overlay in OBS) sends
  // no Origin, but browsers do label it. Without this it could open an OBS
  // stream and take the speaking lease, muting the broadcast.
  const site = request.headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin')
    return { status: 403, code: 'LIVE_BAD_ORIGIN' }
  if (request.method === 'POST') {
    // A custom header plus JSON forces a CORS preflight for any cross-origin
    // page, which this server never answers, so a website cannot drive it.
    if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')
      || request.headers['x-airi-live'] !== '1')
      return { status: 403, code: 'LIVE_BAD_REQUEST_HEADERS' }
  }
  return null
}

export async function readSmallJson(request, limit = 2_048) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit)
      throw new LiveRequestError(400, 'LIVE_REQUEST_TOO_LARGE')
    chunks.push(chunk)
  }
  try {
    const value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(chunks)))
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new TypeError('not an object')
    return value
  }
  catch {
    throw new LiveRequestError(400, 'LIVE_INVALID_REQUEST')
  }
}
