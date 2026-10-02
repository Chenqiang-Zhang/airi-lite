import { SpeechProviderError } from './speech-error.mjs'

const MODEL = 'eleven_v4'
const ENDPOINT = 'https://api.elevenlabs.io/v1/text-to-dialogue/with-timestamps?output_format=mp3_44100_128'
const SAMPLE_RATE = 44_100
const MAX_SECONDS = 30
const MAX_AUDIO_BYTES = 2 * 1_024 * 1_024
const MAX_JSON_BYTES = 4 * 1_024 * 1_024
const MAX_CHARACTERS = 1_024
const ID3_HEADER = Buffer.from('ID3', 'ascii')
const ID3_FOOTER = Buffer.from('3DI', 'ascii')
const ID3_TRAILER = Buffer.from('TAG', 'ascii')
const DELIVERIES = new Set(['neutral', 'soft', 'bright', 'curious'])
// Only server-owned delivery controls become executable audio tags. Do not
// invent breath/laughter or a soft tag whose real voice behavior is unverified.
const DELIVERY_PREFIX = { neutral: '', soft: '', bright: '[happy] ', curious: '[curious] ' }
const validApiKey = value => typeof value === 'string' && /^[\x21-\x7e]{1,4096}$/.test(value)
const validVoiceId = value => typeof value === 'string' && /^[a-z\d_-]{1,256}$/i.test(value)

export function readElevenLabsConfig(env = process.env) {
  const selectedModel = typeof env.ELEVENLABS_TTS_MODEL === 'string'
    ? env.ELEVENLABS_TTS_MODEL.trim() || MODEL : MODEL
  const apiKey = env.ELEVENLABS_API_KEY || ''
  const voiceId = env.ELEVENLABS_VOICE_ID || ''
  const rawLimit = typeof env.ELEVENLABS_TTS_DAILY_CHAR_LIMIT === 'string'
    ? env.ELEVENLABS_TTS_DAILY_CHAR_LIMIT.trim() : ''
  const dailyLimit = /^\d+$/.test(rawLimit) ? Number(rawLimit) : 0
  const configured = env.ELEVENLABS_TTS_ENABLED === '1' && selectedModel === MODEL
    && validApiKey(apiKey) && validVoiceId(voiceId)
    && Number.isSafeInteger(dailyLimit) && dailyLimit > 0
  // A supplied endpoint/region is never accepted: credentials go only to this
  // official origin. Turbo has a different protocol and is intentionally OFF.
  return Object.freeze({ provider: 'elevenlabs', configured, model: MODEL,
    apiKey, voiceId, dailyLimit, endpoint: ENDPOINT })
}

export function buildElevenLabsRequest(config, { text, delivery } = {}) {
  if (typeof text !== 'string' || !text.isWellFormed() || !text.trim()
    || text.length > 360 || !DELIVERIES.has(delivery))
    throw new SpeechProviderError('TTS_INVALID_REQUEST')
  // Literal text is not trusted tag syntax. This is a syntactic barrier, not a
  // claim that a generative model can never interpret an instruction in prose.
  // Keep ordinary line/tab separators: removing them would join adjacent words
  // and erase punctuation-like pacing. Strip only forbidden C0/C1 controls.
  const literal = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
    .replaceAll('[', '［').replaceAll(']', '］')
  if (!literal.trim())
    throw new SpeechProviderError('TTS_INVALID_REQUEST')
  return { inputs: [{ text: DELIVERY_PREFIX[delivery] + literal, voice_id: config.voiceId }],
    model_id: MODEL, language_code: 'zh' }
}

export function estimateElevenLabsReservation(config, request) {
  // The local ledger reserves UTF-16 units for ALL submitted text, including
  // trusted tags. It is NOT MiniMax's Han-character x2 tariff, ElevenLabs credits
  // or a promise of an upstream bill. Failed/cancelled requests are not refunded.
  return buildElevenLabsRequest(config, request).inputs[0].text.length
}

export async function synthesiseElevenLabs(config, request, { fetchImpl = fetch, signal } = {}) {
  if (!config.configured || config.provider !== 'elevenlabs' || config.model !== MODEL
    || config.endpoint !== ENDPOINT || !validApiKey(config.apiKey) || !validVoiceId(config.voiceId)
    || !Number.isSafeInteger(config.dailyLimit) || config.dailyLimit <= 0)
    throw new SpeechProviderError('TTS_NOT_CONFIGURED')
  signal?.throwIfAborted()
  const payload = buildElevenLabsRequest(config, request)
  let upstream
  try {
    upstream = await abortable(fetchImpl(ENDPOINT, {
      method: 'POST', headers: { 'xi-api-key': config.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), redirect: 'error', signal,
    }), signal, response => cancelBody(response?.body))
    signal?.throwIfAborted()
  }
  catch {
    cancelBody(upstream?.body)
    signal?.throwIfAborted()
    throw new SpeechProviderError('TTS_UPSTREAM_FAILED')
  }
  if (!upstream?.ok) {
    cancelBody(upstream?.body)
    throw new SpeechProviderError('TTS_UPSTREAM_FAILED')
  }
  const contentType = upstream.headers?.get('content-type')?.trim().toLowerCase() || ''
  if (!/^application\/json(?:\s*;|$)/.test(contentType) || !upstream.body?.getReader) {
    cancelBody(upstream.body)
    throw new SpeechProviderError()
  }
  const contentLength = upstream.headers.get('content-length')
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_JSON_BYTES)) {
    cancelBody(upstream.body)
    throw new SpeechProviderError()
  }
  const response = await readBoundedJson(upstream.body, signal)
  if (!response || typeof response !== 'object' || Array.isArray(response))
    throw new SpeechProviderError()
  const audio = decodeAudio(response.audio_base64)
  const duration = validateMp3(audio)
  // Both supplied alignment variants must be sound, even if one is not used.
  // Prefer normalized spoken characters, not invented words/phonemes/visemes.
  const raw = validateAlignment(response.alignment, duration)
  const normalized = validateAlignment(response.normalized_alignment, duration)
  const characters = response.normalized_alignment != null ? normalized : raw
  // Ignore voice_segments and all upstream URLs; this adapter never fetches a
  // provider-supplied resource or exposes provider error bodies/identifiers.
  return { audio: audio.toString('base64'), format: 'mp3', sampleRate: SAMPLE_RATE,
    words: [], characters }
}

function cancelBody(body) {
  try { void body?.cancel()?.catch(() => {}) }
  catch { /* Cancellation must not block or replace the stable error. */ }
}

function abortable(promise, signal, onLateValue = () => {}) {
  if (!signal)
    return Promise.resolve(promise)
  return new Promise((resolve, reject) => {
    let aborted = false
    const abort = () => {
      aborted = true
      signal.removeEventListener('abort', abort)
      reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted)
      abort()
    Promise.resolve(promise).then((value) => {
      signal.removeEventListener('abort', abort)
      if (aborted)
        onLateValue(value)
      else
        resolve(value)
    }, (error) => {
      signal.removeEventListener('abort', abort)
      if (!aborted)
        reject(error)
    })
  })
}

async function readBoundedJson(body, signal) {
  let reader
  try { reader = body.getReader() }
  catch {
    cancelBody(body)
    signal?.throwIfAborted()
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
      const { done, value } = await abortable(reader.read(), signal)
      signal?.throwIfAborted()
      if (value !== undefined) {
        if (!(value instanceof Uint8Array) || (bytes += value.byteLength) > MAX_JSON_BYTES)
          throw new SpeechProviderError()
        chunks.push(Buffer.from(value))
      }
      if (done)
        break
    }
    return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(chunks, bytes)))
  }
  catch (error) {
    cancel()
    signal?.throwIfAborted()
    throw error instanceof SpeechProviderError ? error : new SpeechProviderError()
  }
  finally {
    signal?.removeEventListener('abort', cancel)
    try { reader.releaseLock() }
    catch { /* A still-pending mocked/aborted read must not mask cancellation. */ }
  }
}

function decodeAudio(base64) {
  if (typeof base64 !== 'string' || !base64 || base64.length > Math.ceil(MAX_AUDIO_BYTES / 3) * 4
    || base64.length % 4 || !/^(?:[a-z\d+/]{4})*(?:[a-z\d+/]{2}==|[a-z\d+/]{3}=)?$/i.test(base64))
    throw new SpeechProviderError()
  const audio = Buffer.from(base64, 'base64')
  if (!audio.length || audio.length > MAX_AUDIO_BYTES || audio.toString('base64') !== base64)
    throw new SpeechProviderError()
  return audio
}

function validateAlignment(value, duration) {
  if (value == null)
    return []
  if (typeof value !== 'object' || Array.isArray(value))
    throw new SpeechProviderError()
  const { characters, character_start_times_seconds: starts, character_end_times_seconds: ends } = value
  if (!Array.isArray(characters) || !Array.isArray(starts) || !Array.isArray(ends)
    || characters.length > MAX_CHARACTERS || starts.length !== characters.length || ends.length !== characters.length)
    throw new SpeechProviderError()
  let previousEnd = 0
  return characters.map((text, index) => {
    const start = starts[index]
    const end = ends[index]
    if (typeof text !== 'string' || !text.isWellFormed() || [...text].length !== 1
      || !Number.isFinite(start) || !Number.isFinite(end) || start < previousEnd || start > duration
      || end < start || end > duration + 0.05)
      throw new SpeechProviderError()
    previousEnd = end
    return { text, start, end }
  })
}

function validateMp3(audio) {
  let offset = 0
  if (audio.subarray(0, 3).equals(ID3_HEADER)) {
    const version = audio[3]
    const reservedFlags = version === 2 ? 0x3f : version === 3 ? 0x1f : 0x0f
    if (audio.length < 10 || ![2, 3, 4].includes(version) || audio[4] === 0xff
      || audio[5] & reservedFlags || [6, 7, 8, 9].some(index => audio[index] > 0x7f))
      throw new SpeechProviderError()
    const size = audio[6] << 21 | audio[7] << 14 | audio[8] << 7 | audio[9]
    offset = 10 + size
    if (offset > audio.length)
      throw new SpeechProviderError()
    if (version === 4 && audio[5] & 0x10) {
      if (offset + 10 > audio.length || !audio.subarray(offset, offset + 3).equals(ID3_FOOTER)
        || !audio.subarray(offset + 3, offset + 10).equals(audio.subarray(3, 10)))
        throw new SpeechProviderError()
      offset += 10
    }
  }
  let frames = 0
  let channels = null
  const bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
  while (offset < audio.length) {
    // A complete optional ID3v1 trailer is metadata, not audio samples.
    if (audio.length - offset === 128 && audio.subarray(offset, offset + 3).equals(ID3_TRAILER)) {
      offset += 128
      break
    }
    if (offset + 4 > audio.length || audio[offset] !== 0xff || (audio[offset + 1] & 0xe0) !== 0xe0)
      throw new SpeechProviderError()
    const version = audio[offset + 1] >> 3 & 3
    const layer = audio[offset + 1] >> 1 & 3
    const rateIndex = audio[offset + 2] >> 2 & 3
    const bitrateIndex = audio[offset + 2] >> 4
    const frameChannels = audio[offset + 3] >> 6 === 3 ? 1 : 2
    if (version !== 3 || layer !== 1 || rateIndex !== 0 || bitrateIndex === 0 || bitrateIndex === 15
      || (audio[offset + 3] & 3) === 2 || channels !== null && frameChannels !== channels)
      throw new SpeechProviderError()
    channels = frameChannels
    const padding = audio[offset + 2] >> 1 & 1
    offset += Math.floor(144_000 * bitrates[bitrateIndex] / SAMPLE_RATE) + padding
    if (offset > audio.length || ++frames * 1_152 / SAMPLE_RATE > MAX_SECONDS)
      throw new SpeechProviderError()
  }
  if (!frames || offset !== audio.length)
    throw new SpeechProviderError()
  // Structural frame duration only. Browser decoding owns audible-signal checks
  // and mouth animation; character timing is neither a phoneme nor a viseme.
  return frames * 1_152 / SAMPLE_RATE
}
