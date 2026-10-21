import { normaliseEmotion } from '../shared/performance-cues.mjs'
import { SpeechProviderError } from './speech-error.mjs'
import { stripMinimaxSyntax } from './speech-syntax.mjs'

const MODELS = new Set(['speech-2.8-hd', 'speech-2.8-turbo'])
export const MINIMAX_ENDPOINTS = Object.freeze({
  cn: 'https://api.minimax.cn/v1/t2a_v2',
  global: 'https://api.minimax.io/v1/t2a_v2',
})
export const SPEECH_SAMPLE_RATE = 32_000
export const MAX_SPEECH_SECONDS = 30
export const MAX_AUDIO_BYTES = 2 * 1_024 * 1_024
const MAX_STREAM_BYTES = 6_000_000
const MAX_FRAME_BYTES = 4_500_000
const MAX_STREAM_EVENTS = 2_048
const MAX_WORDS = 720
// A protocol-sanity ceiling, not a provider billing rule or Chinese multiplier.
// The request is independently capped at 360 UTF-16 units by the handler; this
// generous ceiling rejects nonsensical upstream accounting without guessing how
// either region bills any particular language. It does not alter reservations.
export const MAX_USAGE_CHARACTERS = 1_000_000

// speech-2.8 voice settings, one row per shared emotion. Checked against the
// official T2A docs on 2026-10-20: the 2.8 emotion enum is happy, sad, angry,
// fearful, disgusted, surprised, calm, and leaving it out lets the model pick
// from the text. whisper is unsupported on 2.8 and fluent is unclear, so
// neither is ever sent. speed stays within 0.5–2; pitch is always 0.
const EMOTION_VOICE = Object.freeze({
  neutral: Object.freeze({}),
  happy: Object.freeze({ emotion: 'happy' }),
  soft: Object.freeze({ emotion: 'calm', speed: 0.96 }),
  curious: Object.freeze({}),
  surprised: Object.freeze({ emotion: 'surprised' }),
  sad: Object.freeze({ emotion: 'sad', speed: 0.96 }),
  // 'angry' can turn pretend annoyance into real anger; the model chooses
  // until a human audition (P5b) has listened to it.
  pout: Object.freeze({}),
  shy: Object.freeze({ speed: 0.97 }),
})
// Official 2.8 interjection tags, put before the words. A pause is silence
// the player adds, never a <#x#> marker (not allowed at the start of text).
const ACT_TAG = Object.freeze({ laugh: '(laughs)', sigh: '(sighs)', pause: '' })
// Sound tags and pause markers written by anyone but this server would be
// performed, so literal text loses them (server/speech-syntax.mjs). The live
// gate refuses any sentence this would change, so nothing is spliced.

// `detail` names which check failed, for local diagnosis (the audition
// script prints it). It is always built here from fixed words and numbers,
// never from upstream text, and speechErrorResponse never sends it.
export class MinimaxSpeechError extends SpeechProviderError {
  constructor(code, detail) {
    super(code)
    if (detail)
      this.detail = detail
  }
}

const invalid = detail => new MinimaxSpeechError('TTS_UPSTREAM_INVALID', detail)

// MiniMax reports errors such as rate limits as a 200 JSON body; keep only
// its numeric status code, reading at most 16 KB.
async function upstreamStatusCode(upstream) {
  const reader = upstream.body?.getReader()
  if (!reader)
    return undefined
  const chunks = []
  let size = 0
  try {
    while (size <= 16_384) {
      const { done, value } = await reader.read()
      if (done) {
        const code = JSON.parse(Buffer.concat(chunks).toString('utf8'))?.base_resp?.status_code
        return Number.isSafeInteger(code) ? code : undefined
      }
      chunks.push(value)
      size += value.byteLength
    }
    return undefined
  }
  catch {
    return undefined
  }
  finally {
    void reader.cancel().catch(() => {})
  }
}

export function readMinimaxConfig(env = process.env) {
  const selectedModel = env.MINIMAX_TTS_MODEL?.trim() || 'speech-2.8-turbo'
  const model = MODELS.has(selectedModel) ? selectedModel : 'speech-2.8-turbo'
  const selectedRegion = env.MINIMAX_TTS_REGION?.trim() || 'cn'
  const region = typeof selectedRegion === 'string' && Object.hasOwn(MINIMAX_ENDPOINTS, selectedRegion)
    ? selectedRegion : null
  // Reject malformed configuration before health=true or any paid reservation.
  // Native fetch headers cannot represent arbitrary Unicode; do not trim away
  // hidden key whitespace/control characters and accidentally advertise success.
  const apiKey = env.MINIMAX_API_KEY || ''
  const validApiKey = typeof apiKey === 'string' && /^[\x21-\x7e]{1,4096}$/.test(apiKey)
  const rawVoiceId = env.MINIMAX_VOICE_ID || ''
  const voiceId = typeof rawVoiceId === 'string' ? rawVoiceId.trim() : ''
  const validVoiceId = typeof rawVoiceId === 'string' && rawVoiceId.length <= 256 && Boolean(voiceId)
    && rawVoiceId.isWellFormed() && !/[\u0000-\u001f\u007f-\u009f]/.test(rawVoiceId)
  const rawLimit = env.MINIMAX_TTS_DAILY_CHAR_LIMIT?.trim() || ''
  const dailyLimit = /^\d+$/.test(rawLimit) ? Number(rawLimit) : 0
  const endpoint = region ? MINIMAX_ENDPOINTS[region] : null
  const configured = env.MINIMAX_TTS_ENABLED === '1' && validApiKey && validVoiceId && Boolean(endpoint)
    && MODELS.has(selectedModel) && Number.isSafeInteger(dailyLimit) && dailyLimit > 0
  return Object.freeze({ configured, model, region, endpoint, apiKey, voiceId, dailyLimit })
}

export function speechHealth(config) {
  const selectedRegion = config.region === undefined ? 'cn' : config.region
  const region = typeof selectedRegion === 'string' && Object.hasOwn(MINIMAX_ENDPOINTS, selectedRegion)
    ? selectedRegion : null
  return { configured: config.configured === true && MODELS.has(config.model) && Boolean(region)
    && config.endpoint === MINIMAX_ENDPOINTS[region], provider: 'minimax', model: config.model, region }
}


export function buildMinimaxRequest(config, { text, delivery, act } = {}) {
  const emotion = normaliseEmotion(delivery)
  if (typeof text !== 'string' || !emotion || !Object.hasOwn(EMOTION_VOICE, emotion)
    || (act !== undefined && !Object.hasOwn(ACT_TAG, act)))
    throw new MinimaxSpeechError('TTS_INVALID_REQUEST')
  const literal = stripMinimaxSyntax(text)
  if (!literal.trim())
    throw new MinimaxSpeechError('TTS_INVALID_REQUEST')
  const { emotion: voiceEmotion, speed = 1 } = EMOTION_VOICE[emotion]
  // No emotion key selects automatic text-conditioned delivery (the enum has
  // no "auto"). Only the server-owned act tag is ever executable syntax.
  const voice = { voice_id: config.voiceId, speed, vol: 1, pitch: 0,
    ...(voiceEmotion ? { emotion: voiceEmotion } : {}) }
  return {
    model: config.model,
    text: (act === undefined ? '' : ACT_TAG[act]) + literal,
    stream: true,
    // By default the final chunk repeats the whole audio. Exclude that aggregate.
    stream_options: { exclude_aggregated_audio: true },
    voice_setting: voice,
    // MP3 is explicitly documented; raw PCM bit depth/byte order is not. The
    // browser decodes MP3 to Float32 PCM instead of assuming an upstream layout.
    audio_setting: { sample_rate: SPEECH_SAMPLE_RATE, bitrate: 128_000, format: 'mp3', channel: 1 },
    language_boost: 'auto',
    subtitle_enable: true,
    subtitle_type: 'word_streaming',
  }
}

// The protective local reservation: twice the UTF-16 length of the text
// actually sent (act tag included, removed literal tags excluded). It is not
// the account balance and failed requests are not refunded.
export function estimateMinimaxReservation(config, request) {
  return 2 * buildMinimaxRequest(config, request).text.length
}

export async function synthesiseMinimax(config, request, { fetchImpl = fetch, signal } = {}) {
  // Defend injected configs as well as readMinimaxConfig: neither a caller nor
  // a client-provided field may select another host for the secret header.
  const region = config.region === undefined ? 'cn' : config.region
  if (!config.configured || !MODELS.has(config.model) || typeof region !== 'string'
    || !Object.hasOwn(MINIMAX_ENDPOINTS, region)
    || config.endpoint !== MINIMAX_ENDPOINTS[region])
    throw new MinimaxSpeechError('TTS_NOT_CONFIGURED')
  signal?.throwIfAborted()
  const payload = buildMinimaxRequest(config, request)
  let upstream
  try {
    upstream = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'error', // Do not forward credentials to an unexpected redirect host.
      signal,
    })
  }
  catch {
    signal?.throwIfAborted()
    throw new MinimaxSpeechError('TTS_UPSTREAM_FAILED', 'fetch-failed')
  }
  if (!upstream.ok) {
    void upstream.body?.cancel().catch(() => {})
    throw new MinimaxSpeechError('TTS_UPSTREAM_FAILED', `http-${upstream.status}`)
  }
  const contentType = upstream.headers.get('content-type')?.toLowerCase() ?? ''
  if (!upstream.body || !contentType.includes('text/event-stream')) {
    const code = contentType.includes('json') ? await upstreamStatusCode(upstream) : undefined
    if (!contentType.includes('json'))
      void upstream.body?.cancel().catch(() => {})
    throw invalid(code === undefined ? 'not-event-stream' : `status-code-${code}`)
  }
  // Subtitle offsets index the text actually sent, act tag included.
  return await collectMinimaxStream(upstream.body, { textLength: payload.text.length, signal })
}

const AGGREGATE_SLACK_BYTES = 4_096

export async function collectMinimaxStream(body, { textLength, signal } = {}) {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf8', { fatal: true })
  const audioChunks = []
  const segments = new Map()
  let buffer = ''
  let eventLines = []
  let eventBytes = 0
  let streamBytes = 0
  let audioBytes = 0
  let events = 0
  let finalInfo = null
  let final = false
  let terminal = false

  // `replay`: the final event's list, which speech-2.8 fills with every
  // cumulative update of a segment, earliest first (verified on a real
  // stream, 2026-10-20).
  const acceptSubtitle = (subtitle, { replay = false } = {}) => {
    if (!subtitle || typeof subtitle !== 'object' || Array.isArray(subtitle)
      || !Number.isInteger(subtitle.text_begin) || !Number.isInteger(subtitle.text_end)
      || subtitle.text_begin < 0 || subtitle.text_end <= subtitle.text_begin
      || subtitle.text_end > textLength || typeof subtitle.text !== 'string' || subtitle.text.length > 720
      || !validTime(subtitle.time_begin) || !validTime(subtitle.time_end)
      || subtitle.time_end < subtitle.time_begin)
      throw invalid('subtitle-shape')
    const old = segments.get(subtitle.text_begin)
    if (old && old.time_begin !== subtitle.time_begin)
      throw invalid('subtitle-time-begin-changed')
    // An earlier snapshot is history in the final replay, but a contradiction
    // while streaming.
    const earlier = old && old.time_end > subtitle.time_end
    if (earlier && !replay)
      throw invalid('subtitle-shrank-while-streaming')
    const words = subtitle.timestamped_words
    if (words != null && (!Array.isArray(words) || words.length > MAX_WORDS))
      throw invalid('subtitle-words-shape')
    for (const word of words ?? []) {
      if (typeof word?.word !== 'string' || !word.word.trim() || word.word.length > 360
        || !Number.isInteger(word.word_begin) || !Number.isInteger(word.word_end)
        || word.word_begin < subtitle.text_begin || word.word_end > subtitle.text_end
        || word.word_end <= word.word_begin || !validTime(word.time_begin) || !validTime(word.time_end)
        || word.time_end < word.time_begin || word.time_begin < subtitle.time_begin
        || word.time_end > subtitle.time_end)
        throw invalid('subtitle-word-out-of-range')
    }
    if (earlier)
      return
    // The last update of a segment can arrive without word timings; the
    // earlier ones still describe the same words.
    const keepWords = old?.timestamped_words?.length && !subtitle.timestamped_words?.length
    segments.set(subtitle.text_begin, keepWords ? { ...subtitle, timestamped_words: old.timestamped_words } : subtitle)
    if (segments.size > 360)
      throw invalid('too-many-segments')
  }

  const consumeEvent = () => {
    const data = eventLines.join('\n').trim()
    eventLines = []
    eventBytes = 0
    if (!data)
      return
    if (++events > MAX_STREAM_EVENTS)
      throw invalid('too-many-events')
    if (data === '[DONE]') {
      if (!final)
        throw invalid('done-before-final')
      terminal = true
      return
    }
    if (final || terminal)
      throw invalid('event-after-final')
    let chunk
    try {
      chunk = JSON.parse(data)
    }
    catch {
      throw invalid('event-not-json')
    }
    if (chunk?.base_resp?.status_code !== 0) {
      const code = chunk?.base_resp?.status_code
      throw invalid(Number.isSafeInteger(code) ? `status-code-${code}` : 'no-status-code')
    }
    if (![1, 2].includes(chunk?.data?.status))
      throw invalid('data-status')
    const audio = chunk.data.audio
    if (audio != null && typeof audio !== 'string')
      throw invalid('audio-not-string')
    if (audio) {
      if (audio.length % 2 || !/^[\da-f]+$/i.test(audio) || audioBytes + audio.length / 2 > MAX_AUDIO_BYTES)
        throw invalid('audio-chunk-invalid')
      const bytes = Buffer.from(audio, 'hex')
      audioBytes += bytes.length
      audioChunks.push(bytes)
    }
    // Ignore subtitle_file entirely: never fetch provider-supplied URLs.
    if (chunk.data.subtitle != null)
      acceptSubtitle(chunk.data.subtitle)
    if (chunk.data.subtitles != null) {
      if (chunk.data.status !== 2 || !Array.isArray(chunk.data.subtitles) || chunk.data.subtitles.length > 360)
        throw invalid('final-subtitles-shape')
      for (const subtitle of chunk.data.subtitles)
        acceptSubtitle(subtitle, { replay: true })
    }
    if (chunk.data.status === 2) {
      final = true
      finalInfo = chunk.extra_info
    }
  }

  const consumeLine = (line) => {
    if (!line) {
      consumeEvent()
      return
    }
    if (line.startsWith('data:')) {
      const value = line.slice(5).replace(/^ /, '')
      eventBytes += Buffer.byteLength(value)
      if (eventBytes > MAX_FRAME_BYTES)
        throw invalid('frame-too-large')
      eventLines.push(value)
    }
  }

  const abortRead = () => { void reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', abortRead, { once: true })
  try {
    signal?.throwIfAborted()
    while (true) {
      const { done, value } = await reader.read()
      signal?.throwIfAborted()
      if (value) {
        streamBytes += value.byteLength
        if (streamBytes > MAX_STREAM_BYTES)
          throw invalid('stream-too-large')
      }
      try {
        buffer += decoder.decode(value, { stream: !done })
      }
      catch {
        throw invalid('not-utf8')
      }
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES)
        throw invalid('frame-too-large')
      for (const line of lines)
        consumeLine(line.replace(/\r$/, ''))
      if (done)
        break
    }
    // SSE events must be blank-line terminated. EOF inside a final JSON frame is
    // truncated too; never play partial synthesis just because some audio arrived.
    if (buffer.trim() || eventLines.length || !final || !audioBytes)
      throw invalid(!final ? 'no-final-event' : !audioBytes ? 'no-audio' : 'unterminated-event')
    const audio = Buffer.concat(audioChunks, audioBytes)
    const duration = finalInfo?.audio_length / 1_000
    // audio_size describes MiniMax's aggregated file, which this request
    // excludes; the streamed chunks lack about 1 KB of it (a real speech-2.8
    // stream, 2026-10-20: 50100 reported, 49005 streamed). Anything more
    // missing is a truncated stream.
    if (finalInfo?.audio_format !== 'mp3' || finalInfo.audio_sample_rate !== SPEECH_SAMPLE_RATE
      || finalInfo.audio_channel !== 1)
      throw invalid('final-format')
    if (!Number.isSafeInteger(finalInfo.audio_size) || audioBytes > finalInfo.audio_size
      || finalInfo.audio_size - audioBytes > AGGREGATE_SLACK_BYTES)
      throw invalid(`audio-size streamed=${audioBytes} reported=${Number.isSafeInteger(finalInfo.audio_size) ? finalInfo.audio_size : '?'}`)
    if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_SPEECH_SECONDS)
      throw invalid('duration')
    const usage = readUsage(finalInfo)
    // Structural frame validation rejects obvious wrong/truncated audio. Actual
    // decoder validity and silence checks happen on browser-decoded Float32 PCM.
    validateMp3(audio)

    const words = []
    let wordAlignmentAvailable = false
    let previousStart = -1
    let previousTextEnd = -1
    for (const segment of [...segments.values()].sort((a, b) => a.text_begin - b.text_begin)) {
      if (segment.time_end / 1_000 > duration || segment.text_begin < previousTextEnd)
        throw invalid('segment-past-end-or-overlap')
      previousTextEnd = segment.text_end
      // Only accepted provider arrays prove availability, including [] or
      // all-zero intervals. A legacy words:[] without this fact stays missing.
      if (Array.isArray(segment.timestamped_words)) wordAlignmentAvailable = true
      for (const word of segment.timestamped_words ?? []) {
        const start = word.time_begin / 1_000
        const end = word.time_end / 1_000
        // A zero-duration word has no playback interval. Drop it without
        // inventing/expanding timing; negative/backward values already failed.
        if (start === end)
          continue
        if (start < previousStart || end > duration || words.length >= MAX_WORDS)
          throw invalid('word-order-or-past-end')
        previousStart = start
        words.push({ text: word.word, start, end })
      }
    }
    return { audio: audio.toString('base64'), format: 'mp3', sampleRate: SPEECH_SAMPLE_RATE, words,
      ...(wordAlignmentAvailable ? { wordAlignmentAvailable: true } : {}),
      ...(usage ? { usage } : {}) }
  }
  catch (error) {
    void reader.cancel().catch(() => {})
    if (signal?.aborted)
      signal.throwIfAborted()
    // A dropped connection surfaces here; keep Node's fixed error names only.
    throw error instanceof MinimaxSpeechError ? error
      : invalid(`read-failed ${error?.name ?? '?'}${typeof error?.cause?.code === 'string' ? ` ${error.cause.code}` : ''}`)
  }
  finally {
    signal?.removeEventListener('abort', abortRead)
    reader.releaseLock()
  }
}

function readUsage(finalInfo) {
  const hasBillable = Object.hasOwn(finalInfo, 'usage_characters')
  const hasText = Object.hasOwn(finalInfo, 'word_count')
  for (const field of ['usage_characters', 'word_count']) {
    if (Object.hasOwn(finalInfo, field) && (!Number.isSafeInteger(finalInfo[field])
      || finalInfo[field] < 0 || finalInfo[field] > MAX_USAGE_CHARACTERS))
      throw invalid('usage-invalid')
  }
  // word_count is informational, not billable. Do not infer billable usage from
  // it, the text length, local reservations, region, or any language heuristic.
  if (!hasBillable)
    return undefined
  return { billableCharacters: finalInfo.usage_characters,
    ...(hasText ? { textCharacters: finalInfo.word_count } : {}) }
}

function validTime(value) {
  return Number.isFinite(value) && value >= 0 && value <= MAX_SPEECH_SECONDS * 1_000
}

function validateMp3(audio) {
  let offset = 0
  // Optional ID3v2 header. The size is sync-safe; never treat the tag as audio.
  if (audio.subarray(0, 3).equals(Buffer.from('ID3'))) {
    if (audio.length < 10 || [6, 7, 8, 9].some(index => audio[index] > 0x7f))
      throw invalid('mp3-id3-invalid')
    offset = 10 + (audio[6] << 21 | audio[7] << 14 | audio[8] << 7 | audio[9])
    if (audio[5] & 0x10)
      offset += 10
  }
  let frames = 0
  while (offset < audio.length) {
    // Optional fixed-length ID3v1 tag after the final frame.
    if (audio.length - offset === 128 && audio.subarray(offset, offset + 3).equals(Buffer.from('TAG')))
      break
    if (offset + 4 > audio.length || audio[offset] !== 0xff || (audio[offset + 1] & 0xe0) !== 0xe0)
      throw invalid('mp3-frame-sync')
    const version = audio[offset + 1] >> 3 & 3
    const layer = audio[offset + 1] >> 1 & 3
    const rateIndex = audio[offset + 2] >> 2 & 3
    const bitrateIndex = audio[offset + 2] >> 4
    const mono = audio[offset + 3] >> 6 === 3
    const rates = [44_100, 48_000, 32_000]
    // Our fixed 32k mono contract implies MPEG-1 Layer III. Reject free-format,
    // reserved encodings and changed rate/channel instead of guessing offsets.
    if (version !== 3 || layer !== 1 || rates[rateIndex] !== SPEECH_SAMPLE_RATE
      || bitrateIndex === 0 || bitrateIndex === 15 || !mono)
      throw invalid('mp3-not-32k-mono-layer3')
    const bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
    const padding = audio[offset + 2] >> 1 & 1
    offset += Math.floor(144_000 * bitrates[bitrateIndex] / SPEECH_SAMPLE_RATE) + padding
    if (offset > audio.length)
      throw invalid('mp3-truncated-frame')
    frames++
  }
  if (!frames)
    throw invalid('mp3-no-frames')
}
