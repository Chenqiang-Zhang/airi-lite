import { isIP } from 'node:net'

import { SpeechProviderError } from './speech-error.mjs'

const SPEECH_PATH = '/v1/audio/speech'
const MAX_SECONDS = 30
const MAX_AUDIO_BYTES = 2 * 1_024 * 1_024
const MIN_SAMPLE_RATE = 8_000
const MAX_SAMPLE_RATE = 96_000
// A runaway guard for an engine we run ourselves, not a bill: about 14 hours
// of continuous speech, yet a synthesis loop at full concurrency hits it fast.
export const DEFAULT_LOCAL_DAILY_CHAR_LIMIT = 500_000
const ACCEPT = { wav: 'audio/wav', mp3: 'audio/mpeg' }
// The single delivery table for self-hosted engines. `instructions` is sent
// only when LOCAL_TTS_INSTRUCTIONS=1, because many OpenAI-compatible wrappers
// ignore or reject the field. Widening the delivery list means one new row.
const DELIVERY_STYLE = Object.freeze({
  neutral: Object.freeze({ speed: 1, instructions: '' }),
  soft: Object.freeze({ speed: 0.96, instructions: '用轻柔、平静的语气说。' }),
  bright: Object.freeze({ speed: 1, instructions: '用开心、明亮的语气说。' }),
  curious: Object.freeze({ speed: 1, instructions: '用好奇、略带疑问的语气说。' }),
})
const MODEL_PATTERN = /^[A-Za-z0-9][\w.:/@+-]{0,127}$/
const validApiKey = value => value === '' || (typeof value === 'string' && /^[\x21-\x7e]{1,4096}$/.test(value))
const validVoice = value => typeof value === 'string' && value.length >= 1 && value.length <= 256
  && value === value.trim() && value.isWellFormed() && !/[\u0000-\u001f\u007f-\u009f]/.test(value)
const validSampleRate = value => Number.isInteger(value) && value >= MIN_SAMPLE_RATE && value <= MAX_SAMPLE_RATE
const trimmed = value => typeof value === 'string' ? value.trim() : ''

export const isLocalTtsModel = value => typeof value === 'string' && MODEL_PATTERN.test(value)

// Loopback, RFC1918 or link-local only. Names other than "localhost" are not
// resolved here: a DNS answer could change after this check (rebinding).
export function isPrivateTtsHost(hostname) {
  if (hostname === 'localhost')
    return true
  const address = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  const family = isIP(address)
  if (family === 4) {
    const [a, b] = address.split('.').map(Number)
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 169 && b === 254)
  }
  if (family === 6) {
    // WHATWG URL already compressed the address. IPv4-mapped forms are not
    // special-cased: they fail closed instead of being re-interpreted.
    if (address === '::1')
      return true
    const first = address.startsWith('::') ? 0 : Number.parseInt(address.split(':')[0], 16)
    return (first & 0xffc0) === 0xfe80
  }
  return false
}

function parseLocalUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 2_048)
    return null
  let url
  try { url = new URL(value) }
  catch { return null }
  // Never send a key or a viewer's text to a host the operator did not pin.
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password
    || url.search || url.hash || value.includes('?') || value.includes('#') || !isPrivateTtsHost(url.hostname))
    return null
  return url
}

// LOCAL_TTS_URL is the engine's base URL; a URL that already ends in the
// speech path is taken as it is rather than getting the path twice.
function localEndpoint(value) {
  const url = parseLocalUrl(trimmed(value))
  if (!url)
    return ''
  const path = url.pathname.replace(/\/+$/, '')
  return `${url.origin}${path.endsWith(SPEECH_PATH) ? path : `${path}${SPEECH_PATH}`}`
}

// Why LOCAL_TTS_URL would be refused (null when it is usable), in the words
// the go-live checklist shows the host. The same rules as parseLocalUrl.
export function localTtsUrlProblem(value) {
  const raw = trimmed(value)
  if (!raw)
    return 'missing'
  if (raw.length > 2_048)
    return 'invalid'
  let url
  try { url = new URL(raw) }
  catch { return 'invalid' }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return 'scheme'
  if (url.username || url.password)
    return 'credentials'
  if (url.search || url.hash || raw.includes('?') || raw.includes('#'))
    return 'query'
  if (!isPrivateTtsHost(url.hostname))
    return 'host'
  return null
}

function validLocalConfig(config) {
  const url = parseLocalUrl(config?.endpoint)
  return config.provider === 'local' && url?.href === config.endpoint && url.pathname.endsWith(SPEECH_PATH)
    && isLocalTtsModel(config.model) && validVoice(config.voice) && Object.hasOwn(ACCEPT, config.format)
    && validApiKey(config.apiKey) && typeof config.instructions === 'boolean'
    && (config.sampleRate === null ? config.format === 'wav' : validSampleRate(config.sampleRate))
    && Number.isSafeInteger(config.dailyLimit) && config.dailyLimit > 0
}

export function readLocalTtsConfig(env = process.env) {
  const rawRate = trimmed(env.LOCAL_TTS_SAMPLE_RATE)
  const rawLimit = trimmed(env.LOCAL_TTS_DAILY_CHAR_LIMIT)
  const config = {
    provider: 'local',
    endpoint: localEndpoint(env.LOCAL_TTS_URL),
    model: trimmed(env.LOCAL_TTS_MODEL),
    voice: trimmed(env.LOCAL_TTS_VOICE),
    format: trimmed(env.LOCAL_TTS_FORMAT) || 'wav',
    // Like the cloud keys, never trim: hidden whitespace must fail, not pass.
    apiKey: typeof env.LOCAL_TTS_API_KEY === 'string' ? env.LOCAL_TTS_API_KEY : '',
    // WAV carries its rate in the RIFF header; MP3 needs the operator's value.
    sampleRate: rawRate === '' ? null : /^\d{1,6}$/.test(rawRate) ? Number(rawRate) : Number.NaN,
    dailyLimit: rawLimit === '' ? DEFAULT_LOCAL_DAILY_CHAR_LIMIT : /^\d+$/.test(rawLimit) ? Number(rawLimit) : 0,
    instructions: env.LOCAL_TTS_INSTRUCTIONS === '1',
  }
  return Object.freeze({ ...config, configured: env.LOCAL_TTS_ENABLED === '1' && validLocalConfig(config) })
}

export function buildLocalRequest(config, { text, delivery } = {}) {
  if (typeof text !== 'string' || !text.isWellFormed() || !text.trim() || text.length > 360
    || typeof delivery !== 'string' || !Object.hasOwn(DELIVERY_STYLE, delivery))
    throw new SpeechProviderError('TTS_INVALID_REQUEST')
  const style = DELIVERY_STYLE[delivery]
  return { model: config.model, input: text, voice: config.voice, response_format: config.format,
    speed: style.speed, ...(config.instructions && style.instructions ? { instructions: style.instructions } : {}) }
}

export function estimateLocalReservation(config, request) {
  // UTF-16 units of the spoken text only; server-owned instructions are not
  // viewer text and the ledger is a runaway guard, not an upstream tariff.
  return buildLocalRequest(config, request).input.length
}

export async function synthesiseLocal(config, request, { fetchImpl = fetch, signal } = {}) {
  // Defend injected configs too: no caller may point the key or text elsewhere.
  if (config?.configured !== true || !validLocalConfig(config))
    throw new SpeechProviderError('TTS_NOT_CONFIGURED')
  signal?.throwIfAborted()
  const body = JSON.stringify(buildLocalRequest(config, request))
  let upstream
  try {
    upstream = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: ACCEPT[config.format],
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
      body,
      redirect: 'error', // A redirect could leave the pinned private address.
      signal,
    })
  }
  catch {
    signal?.throwIfAborted()
    throw new SpeechProviderError('TTS_UPSTREAM_FAILED')
  }
  if (!upstream?.ok) {
    cancelBody(upstream?.body)
    throw new SpeechProviderError('TTS_UPSTREAM_FAILED')
  }
  // Engines label audio inconsistently; the bytes are checked below anyway.
  // JSON/text bodies are error payloads that must never reach the browser.
  const contentType = upstream.headers?.get('content-type')?.split(';')[0].trim().toLowerCase() || ''
  if ((!contentType.startsWith('audio/') && contentType !== 'application/octet-stream')
    || !upstream.body?.getReader) {
    cancelBody(upstream.body)
    throw new SpeechProviderError()
  }
  const contentLength = upstream.headers.get('content-length')
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_AUDIO_BYTES)) {
    cancelBody(upstream.body)
    throw new SpeechProviderError()
  }
  const encoded = await readBoundedBody(upstream.body, signal)
  const { audio, sampleRate } = config.format === 'wav'
    ? readLocalWav(encoded)
    : { audio: encoded, sampleRate: checkLocalMp3(encoded, config.sampleRate) }
  // No word timing and no usage: OpenAI-style speech returns neither, and a
  // local engine has no bill. wordAlignmentAvailable is true-only on the wire.
  return { audio: audio.toString('base64'), format: config.format, sampleRate, words: [] }
}

function cancelBody(body) {
  try { void body?.cancel()?.catch(() => {}) }
  catch { /* Cancellation must not block or replace the stable error. */ }
}

async function readBoundedBody(body, signal) {
  let reader
  try { reader = body.getReader() }
  catch {
    cancelBody(body)
    throw new SpeechProviderError()
  }
  const chunks = []
  let bytes = 0
  const cancel = () => {
    try { void reader.cancel()?.catch(() => {}) }
    catch { /* Never await an uncooperative cancel implementation. */ }
  }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    signal?.throwIfAborted()
    while (true) {
      const { done, value } = await reader.read()
      signal?.throwIfAborted()
      if (value !== undefined) {
        if (!(value instanceof Uint8Array) || (bytes += value.byteLength) > MAX_AUDIO_BYTES)
          throw new SpeechProviderError()
        chunks.push(value)
      }
      if (done)
        break
    }
    if (!bytes)
      throw new SpeechProviderError()
    return Buffer.concat(chunks, bytes)
  }
  catch (error) {
    cancel()
    signal?.throwIfAborted()
    throw error instanceof SpeechProviderError ? error : new SpeechProviderError()
  }
  finally {
    signal?.removeEventListener('abort', cancel)
    try { reader.releaseLock() }
    catch { /* A still-pending read must not mask the stable error. */ }
  }
}

// KSDATAFORMAT_SUBTYPE_* GUID bytes after the 32-bit format code.
const EXTENSIBLE_GUID_TAIL = Buffer.from('00001000800000aa00389b71', 'hex')

// Reads the rate from the RIFF header and bounds duration before any browser
// codec sees the bytes. Streaming encoders that cannot know the length write
// 0 or 0xFFFFFFFF as sizes; those are patched to the received length.
export function readLocalWav(audio) {
  if (audio.length < 44 || audio.toString('latin1', 0, 4) !== 'RIFF' || audio.toString('latin1', 8, 12) !== 'WAVE')
    throw new SpeechProviderError()
  let offset = 12
  let format = null
  let data = null
  for (let chunk = 0; !data && chunk < 64 && offset + 8 <= audio.length; chunk++) {
    const id = audio.toString('latin1', offset, offset + 4)
    const size = audio.readUInt32LE(offset + 4)
    const start = offset + 8
    if (id === 'data') {
      if (!format)
        throw new SpeechProviderError()
      const placeholder = size === 0 || size === 0xffff_ffff
      const length = placeholder
        ? Math.floor((audio.length - start) / format.blockAlign) * format.blockAlign : size
      // A declared length past the received bytes is truncated synthesis.
      if (!length || start + length > audio.length)
        throw new SpeechProviderError()
      data = { start, length, placeholder }
      break
    }
    if (start + size > audio.length)
      throw new SpeechProviderError()
    if (id === 'fmt ') {
      if (format || size < 16)
        throw new SpeechProviderError()
      format = readWavFormat(audio, start, size)
    }
    offset = start + size + (size & 1)
  }
  if (!data || data.length / format.byteRate > MAX_SECONDS)
    throw new SpeechProviderError()
  const riffSize = audio.readUInt32LE(4)
  if (!data.placeholder && riffSize !== 0 && riffSize !== 0xffff_ffff)
    return { audio, sampleRate: format.sampleRate }
  const patched = Buffer.from(audio.subarray(0, data.placeholder ? data.start + data.length : audio.length))
  patched.writeUInt32LE(patched.length - 8, 4)
  patched.writeUInt32LE(data.length, data.start - 4)
  return { audio: patched, sampleRate: format.sampleRate }
}

function readWavFormat(audio, start, size) {
  let encoding = audio.readUInt16LE(start)
  const channels = audio.readUInt16LE(start + 2)
  const sampleRate = audio.readUInt32LE(start + 4)
  const byteRate = audio.readUInt32LE(start + 8)
  const blockAlign = audio.readUInt16LE(start + 12)
  const bits = audio.readUInt16LE(start + 14)
  if (encoding === 0xfffe) {
    if (size < 40 || audio.readUInt16LE(start + 16) < 22
      || !audio.subarray(start + 28, start + 40).equals(EXTENSIBLE_GUID_TAIL))
      throw new SpeechProviderError()
    encoding = audio.readUInt32LE(start + 24)
  }
  // Only what browsers decode everywhere: integer PCM or 32-bit float, 1–2 ch.
  if (!((encoding === 1 && [8, 16, 24, 32].includes(bits)) || (encoding === 3 && bits === 32))
    || (channels !== 1 && channels !== 2) || !validSampleRate(sampleRate)
    || blockAlign !== channels * bits / 8 || byteRate !== sampleRate * blockAlign)
    throw new SpeechProviderError()
  return { sampleRate, byteRate, blockAlign }
}

const MP3_RATES = { 3: [44_100, 48_000, 32_000], 2: [22_050, 24_000, 16_000], 0: [11_025, 12_000, 8_000] }
const MP3_BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
const MP3_BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]

// Structural Layer III walk (MPEG-1, 2 and 2.5). Every frame must carry the
// configured rate, so a wrong LOCAL_TTS_SAMPLE_RATE fails instead of guessing.
export function checkLocalMp3(audio, sampleRate) {
  let offset = 0
  if (audio.subarray(0, 3).toString('latin1') === 'ID3') {
    if (audio.length < 10 || [6, 7, 8, 9].some(index => audio[index] > 0x7f))
      throw new SpeechProviderError()
    offset = 10 + (audio[6] << 21 | audio[7] << 14 | audio[8] << 7 | audio[9]) + (audio[5] & 0x10 ? 10 : 0)
  }
  let frames = 0
  let seconds = 0
  while (offset < audio.length) {
    if (audio.length - offset === 128 && audio.subarray(offset, offset + 3).toString('latin1') === 'TAG')
      break
    if (offset + 4 > audio.length || audio[offset] !== 0xff || (audio[offset + 1] & 0xe0) !== 0xe0)
      throw new SpeechProviderError()
    const version = audio[offset + 1] >> 3 & 3
    const layer = audio[offset + 1] >> 1 & 3
    const bitrateIndex = audio[offset + 2] >> 4
    const rateIndex = audio[offset + 2] >> 2 & 3
    if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3
      || MP3_RATES[version][rateIndex] !== sampleRate)
      throw new SpeechProviderError()
    const mpeg1 = version === 3
    const bitrate = (mpeg1 ? MP3_BITRATES_V1 : MP3_BITRATES_V2)[bitrateIndex]
    offset += Math.floor((mpeg1 ? 144_000 : 72_000) * bitrate / sampleRate) + (audio[offset + 2] >> 1 & 1)
    seconds += (mpeg1 ? 1_152 : 576) / sampleRate
    if (offset > audio.length || seconds > MAX_SECONDS)
      throw new SpeechProviderError()
    frames++
  }
  if (!frames)
    throw new SpeechProviderError()
  return sampleRate
}
