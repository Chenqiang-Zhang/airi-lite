import type { Delivery } from './delivery'

import { INVALID_ACCESS_CODE_MESSAGE, isValidAccessCode } from './access-code.ts'
import { hasSpokenContent } from './spoken-text.ts'

export interface SpeechWord {
  text: string
  start: number
  end: number
}

// Character alignment is clip-relative caption metadata, not a viseme track.
export interface SpeechCharacter {
  text: string
  start: number
  end: number
}

export interface CloudSpeechClip {
  samples: Float32Array
  sampleRate: number
  words: SpeechWord[]
  characters?: SpeechCharacter[]
}

export interface CloudSpeechOptions {
  text: string
  delivery: Delivery
  // Match the explicitly confirmed service; this cannot select the server's
  // provider. Existing callers default to MiniMax rather than a new paid one.
  expectedProvider?: 'minimax' | 'elevenlabs'
  accessCode?: string
  signal?: AbortSignal
  // A root-relative proxy route, never a provider URL. This also lets Node
  // tests avoid depending on Vite's import.meta.env.
  endpoint?: string
}

export interface DecodedSpeechAudio {
  samples: Float32Array
  sampleRate: number
}

export interface CloudSpeechDependencies {
  fetch?: typeof fetch
  decodeAudio?: (encoded: ArrayBuffer, signal?: AbortSignal) => Promise<DecodedSpeechAudio>
}

export type SpeechApiErrorCode = 'invalid_request' | 'invalid_access_code'
  | 'unauthorized' | 'rate_limited' | 'unavailable' | 'upstream'
  | 'provider_changed' | 'invalid_response' | 'network'

const MESSAGES: Record<SpeechApiErrorCode, string> = {
  invalid_request: '这段文字无法生成语音，请使用不超过 360 字符的可朗读正文。',
  invalid_access_code: INVALID_ACCESS_CODE_MESSAGE,
  unauthorized: '语音服务需要有效体验码，请检查体验码后再试。',
  rate_limited: '语音额度已用完或请求过于频繁，请稍后再试。',
  unavailable: '云端语音暂时不可用或尚未启用，请稍后再试。',
  provider_changed: '云端语音供应商已变化，请重新选择并确认云端模式。',
  upstream: '语音服务暂时无法生成音频，请稍后再试。',
  invalid_response: '语音服务返回了无法使用的音频或字幕，请稍后再试。',
  network: '无法连接语音服务，请检查网络后再试。',
}

// Error messages come only from this table: provider bodies, fetch errors,
// headers and cancellation reasons must never become browser-facing errors.
export class SpeechApiError extends Error {
  readonly code: SpeechApiErrorCode
  readonly status?: number

  constructor(code: SpeechApiErrorCode, status?: number) {
    super(MESSAGES[code])
    this.name = 'SpeechApiError'
    this.code = code
    this.status = status
  }
}

const DEFAULT_SAMPLE_RATE = 32000
const MAX_TEXT_LENGTH = 360
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_AUDIO_BYTES = 2 * 1024 * 1024
const MAX_BASE64_LENGTH = Math.ceil(MAX_AUDIO_BYTES / 3) * 4
const MAX_WORDS = 1024
const MAX_CHARACTERS = 1024
const MAX_DURATION_SECONDS = 30
const MIN_RMS = 0.0001
const TIME_TOLERANCE = 0.05
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const DELIVERIES: Delivery[] = ['neutral', 'soft', 'bright', 'curious']

function abortError(): DOMException {
  return new DOMException('语音请求已取消。', 'AbortError')
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw abortError()
}

function isAbortError(error: unknown): boolean {
  return error !== null && typeof error === 'object'
    && 'name' in error && error.name === 'AbortError'
}

function cancelBody(response: Response): void {
  // Do not wait for a remote stream's cancellation to settle before reporting
  // an error or releasing a canceled turn.
  void response.body?.cancel().catch(() => {})
}

function proxyEndpoint(override?: string): string {
  const endpoint = override ?? `${import.meta.env?.BASE_URL ?? '/'}api/speech`
  // No scheme, protocol-relative URL, query, backslash, encoded separator or
  // traversal is accepted, even through the test/configuration override.
  if (!/^\/(?:[A-Za-z0-9_-]+\/)*api\/speech$/.test(endpoint))
    throw new SpeechApiError('invalid_request')
  return endpoint
}

async function readBoundedJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  const length = response.headers.get('Content-Length')
  if (length !== null && /^\d+$/.test(length) && Number(length) > MAX_RESPONSE_BYTES) {
    cancelBody(response)
    throw new SpeechApiError('invalid_response')
  }
  if (!response.body)
    throw new SpeechApiError('invalid_response')

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let received = 0
  let json = ''
  let complete = false
  const cancelReader = () => { void reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', cancelReader, { once: true })
  try {
    throwIfAborted(signal)
    while (true) {
      const { done, value } = await reader.read()
      throwIfAborted(signal)
      if (done) {
        json += decoder.decode()
        complete = true
        break
      }
      received += value.byteLength
      if (received > MAX_RESPONSE_BYTES)
        throw new SpeechApiError('invalid_response')
      json += decoder.decode(value, { stream: true })
    }
    return JSON.parse(json) as unknown
  }
  finally {
    signal?.removeEventListener('abort', cancelReader)
    if (!complete)
      cancelReader()
    reader.releaseLock()
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function decodeBase64(audio: unknown): ArrayBuffer {
  if (typeof audio !== 'string' || !audio.length || audio.length > MAX_BASE64_LENGTH
    || audio.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(audio))
    throw new SpeechApiError('invalid_response')

  // atob tolerates non-canonical padding bits; require actual base64 audio.
  if ((audio.endsWith('==') && BASE64_ALPHABET.indexOf(audio.at(-3)!) % 16 !== 0)
    || (!audio.endsWith('==') && audio.endsWith('=') && BASE64_ALPHABET.indexOf(audio.at(-2)!) % 4 !== 0))
    throw new SpeechApiError('invalid_response')

  const binary = atob(audio)
  if (!binary.length || binary.length > MAX_AUDIO_BYTES)
    throw new SpeechApiError('invalid_response')

  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++)
    bytes[index] = binary.charCodeAt(index)
  return bytes.buffer
}

async function withAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal)
    return operation
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal!.removeEventListener('abort', abort)
      reject(abortError())
    }
    signal.addEventListener('abort', abort, { once: true })
    // Attach both handlers even when already aborted: a late decoder failure
    // must not become an unhandled rejection or reopen canceled playback.
    operation.then((value) => {
      signal.removeEventListener('abort', abort)
      resolve(value)
    }, (error: unknown) => {
      signal.removeEventListener('abort', abort)
      reject(error)
    })
    if (signal.aborted)
      abort()
  })
}

async function decodeWithAudioContext(encoded: ArrayBuffer, signal?: AbortSignal, requestedSampleRate = DEFAULT_SAMPLE_RATE): Promise<DecodedSpeechAudio> {
  throwIfAborted(signal)
  if (typeof AudioContext === 'undefined')
    throw new SpeechApiError('invalid_response')
  let context: AudioContext | null = null
  try {
    try {
      context = new AudioContext({ sampleRate: requestedSampleRate })
    }
    catch {
      // Some devices only accept their native sample rate. AudioBuffer reports
      // the real decoded rate; never relabel those samples with a wire hint.
      context = new AudioContext()
    }
    const decoded = await withAbort(context.decodeAudioData(encoded), signal)
    throwIfAborted(signal)
    if ((decoded.numberOfChannels !== 1 && decoded.numberOfChannels !== 2) || !Number.isInteger(decoded.sampleRate)
      || decoded.sampleRate < 8000 || decoded.sampleRate > 96000
      || !Number.isInteger(decoded.length) || decoded.length <= 0
      || decoded.length / decoded.sampleRate > MAX_DURATION_SECONDS)
      throw new SpeechApiError('invalid_response')
    const left = decoded.getChannelData(0)
    if (!(left instanceof Float32Array) || left.length !== decoded.length)
      throw new SpeechApiError('invalid_response')
    if (decoded.numberOfChannels === 1)
      return { samples: left.slice(), sampleRate: decoded.sampleRate }

    const right = decoded.getChannelData(1)
    if (!(right instanceof Float32Array) || right.length !== decoded.length)
      throw new SpeechApiError('invalid_response')
    const samples = new Float32Array(decoded.length)
    for (let index = 0; index < samples.length; index++) {
      const leftSample = left[index]!
      const rightSample = right[index]!
      if (!Number.isFinite(leftSample) || !Number.isFinite(rightSample))
        throw new SpeechApiError('invalid_response')
      // Bounded mean, not a louder-channel selector. Opposite phases may
      // cancel and honestly fail the same audible-RMS gate as mono silence.
      samples[index] = Math.max(-1, Math.min(1, (leftSample + rightSample) / 2))
    }
    return { samples, sampleRate: decoded.sampleRate }
  }
  finally {
    // Decoding never creates a source or starts playback. Closing here also
    // releases a context promptly when the uncancelable decoder finishes late.
    if (context)
      void context.close().catch(() => {})
  }
}

function validateDecodedAudio(decoded: DecodedSpeechAudio): DecodedSpeechAudio {
  const { samples, sampleRate } = decoded
  if (!(samples instanceof Float32Array) || !samples.length
    || !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000
    || samples.length / sampleRate > MAX_DURATION_SECONDS)
    throw new SpeechApiError('invalid_response')
  let energy = 0
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index]!
    if (!Number.isFinite(sample))
      throw new SpeechApiError('invalid_response')
    energy += sample * sample
  }
  if (Math.sqrt(energy / samples.length) < MIN_RMS)
    throw new SpeechApiError('invalid_response')
  return { samples, sampleRate }
}

function decodeWords(value: unknown, duration: number): SpeechWord[] {
  if (!Array.isArray(value) || value.length > MAX_WORDS)
    throw new SpeechApiError('invalid_response')

  const words: SpeechWord[] = []
  let previousStart = -1
  for (const word of value) {
    if (!record(word) || typeof word.text !== 'string'
      || !word.text.trim() || word.text.length > MAX_TEXT_LENGTH
      || typeof word.start !== 'number' || !Number.isFinite(word.start)
      || typeof word.end !== 'number' || !Number.isFinite(word.end)
      || word.start < 0 || word.end <= word.start || word.start > duration
      || word.end > duration + TIME_TOLERANCE || word.start < previousStart)
      throw new SpeechApiError('invalid_response')
    previousStart = word.start
    words.push({ text: word.text, start: word.start, end: word.end })
  }
  // Invalid metadata rejects the clip; it never invents words or shifts times
  // to the current playback position. An explicit empty list is valid.
  return words
}

function decodeCharacters(value: unknown, duration: number): SpeechCharacter[] {
  if (value === undefined)
    return []
  if (!Array.isArray(value) || value.length > MAX_CHARACTERS)
    throw new SpeechApiError('invalid_response')

  const characters: SpeechCharacter[] = []
  let previousEnd = 0
  for (const character of value) {
    if (!record(character) || typeof character.text !== 'string'
      || character.text.length < 1 || character.text.length > 2)
      throw new SpeechApiError('invalid_response')
    const scalar = character.text.codePointAt(0)!
    // Spaces/punctuation and zero-duration characters are valid alignment.
    // A surrogate half or several characters is not one Unicode scalar.
    if ((scalar >= 0xD800 && scalar <= 0xDFFF) || String.fromCodePoint(scalar) !== character.text
      || typeof character.start !== 'number' || !Number.isFinite(character.start)
      || typeof character.end !== 'number' || !Number.isFinite(character.end)
      || character.start < previousEnd || character.end < character.start
      || character.start > duration || character.end > duration + TIME_TOLERANCE)
      throw new SpeechApiError('invalid_response')
    previousEnd = character.end
    characters.push({ text: character.text, start: character.start, end: character.end })
  }
  return characters
}

function httpError(status: number): SpeechApiError {
  if (status === 401 || status === 403)
    return new SpeechApiError('unauthorized', status)
  if (status === 429)
    return new SpeechApiError('rate_limited', status)
  if (status === 409)
    return new SpeechApiError('provider_changed', status)
  if (status === 503)
    return new SpeechApiError('unavailable', status)
  if (status === 400)
    return new SpeechApiError('invalid_request', status)
  return new SpeechApiError('upstream', status)
}

export async function fetchCloudSpeech(
  options: CloudSpeechOptions,
  dependencies: CloudSpeechDependencies = {},
): Promise<CloudSpeechClip> {
  throwIfAborted(options.signal)
  const expectedProvider = options.expectedProvider === undefined ? 'minimax' : options.expectedProvider
  if (expectedProvider !== 'minimax' && expectedProvider !== 'elevenlabs')
    throw new SpeechApiError('invalid_request')
  if (typeof options.text !== 'string' || options.text.length > MAX_TEXT_LENGTH
    || !hasSpokenContent(options.text) || !DELIVERIES.includes(options.delivery))
    throw new SpeechApiError('invalid_request')
  if (options.accessCode !== undefined && (typeof options.accessCode !== 'string'
    || (options.accessCode !== '' && !isValidAccessCode(options.accessCode))))
    throw new SpeechApiError('invalid_access_code')
  const endpoint = proxyEndpoint(options.endpoint)
  // Feature detection is read-only: do not create a context before validating
  // the response, or spend a provider request when this device cannot decode.
  if (!dependencies.decodeAudio && typeof AudioContext === 'undefined')
    throw new SpeechApiError('invalid_response')

  let response: Response
  try {
    response = await (dependencies.fetch ?? fetch)(endpoint, {
      method: 'POST',
      mode: 'same-origin',
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        ...(options.accessCode ? { 'X-Demo-Access-Code': options.accessCode } : {}),
      },
      body: JSON.stringify({ text: options.text, delivery: options.delivery, expectedProvider }),
      signal: options.signal,
    })
  }
  catch (error) {
    if (options.signal?.aborted || isAbortError(error))
      throw abortError()
    throw new SpeechApiError('network')
  }
  if (options.signal?.aborted) {
    cancelBody(response)
    throw abortError()
  }
  if (!response.ok) {
    cancelBody(response)
    throw httpError(response.status)
  }

  try {
    const payload = await readBoundedJson(response, options.signal)
    throwIfAborted(options.signal)
    if (!record(payload) || payload.format !== 'mp3'
      || (payload.sampleRate !== 32000 && payload.sampleRate !== 44100))
      throw new SpeechApiError('invalid_response')
    const requestedSampleRate = payload.sampleRate
    const encoded = decodeBase64(payload.audio)
    // Validate structure and global time bounds before asking a browser codec
    // to allocate audio buffers, then check against the actual decoded clip.
    const words = decodeWords(payload.words, MAX_DURATION_SECONDS)
    const characters = decodeCharacters(payload.characters, MAX_DURATION_SECONDS)
    throwIfAborted(options.signal)
    const decodeAudio = dependencies.decodeAudio
      ?? ((audio: ArrayBuffer, signal?: AbortSignal) => decodeWithAudioContext(audio, signal, requestedSampleRate))
    const decoded = await withAbort(decodeAudio(encoded, options.signal), options.signal)
    throwIfAborted(options.signal)
    const { samples, sampleRate } = validateDecodedAudio(decoded)
    decodeWords(words, samples.length / sampleRate)
    decodeCharacters(characters, samples.length / sampleRate)
    throwIfAborted(options.signal)
    return { samples, sampleRate, words, characters }
  }
  catch (error) {
    if (options.signal?.aborted || isAbortError(error))
      throw abortError()
    if (error instanceof SpeechApiError)
      throw error
    throw new SpeechApiError('invalid_response')
  }
}
