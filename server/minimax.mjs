import { SpeechProviderError } from './speech-error.mjs'

const MODELS = new Set(['speech-2.8-hd', 'speech-2.8-turbo'])
const ENDPOINTS = { cn: 'https://api.minimax.cn/v1/t2a_v2' }
export const SPEECH_SAMPLE_RATE = 32_000
export const MAX_SPEECH_SECONDS = 30
export const MAX_AUDIO_BYTES = 2 * 1_024 * 1_024
const MAX_STREAM_BYTES = 6_000_000
const MAX_FRAME_BYTES = 4_500_000
const MAX_STREAM_EVENTS = 2_048
const MAX_WORDS = 720

export class MinimaxSpeechError extends SpeechProviderError {}

export function readMinimaxConfig(env = process.env) {
  const selectedModel = env.MINIMAX_TTS_MODEL?.trim() || 'speech-2.8-turbo'
  const model = MODELS.has(selectedModel) ? selectedModel : 'speech-2.8-turbo'
  const region = env.MINIMAX_TTS_REGION?.trim() || 'cn'
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
  const endpoint = Object.hasOwn(ENDPOINTS, region) ? ENDPOINTS[region] : null
  const configured = env.MINIMAX_TTS_ENABLED === '1' && validApiKey && validVoiceId && Boolean(endpoint)
    && MODELS.has(selectedModel) && Number.isSafeInteger(dailyLimit) && dailyLimit > 0
  return Object.freeze({ configured, model, endpoint, apiKey, voiceId, dailyLimit })
}

export function speechHealth(config) {
  return { configured: config.configured, provider: 'minimax', model: config.model }
}

export function buildMinimaxRequest(config, { text, delivery }) {
  const voice = { voice_id: config.voiceId, speed: delivery === 'soft' ? 0.96 : 1, vol: 1, pitch: 0 }
  if (delivery === 'bright')
    voice.emotion = 'happy'
  if (delivery === 'soft')
    voice.emotion = 'calm'
  // The documented enum has no "auto": omitting emotion selects automatic
  // text-conditioned delivery. Never add laugh/breath or pause tags implicitly.
  return {
    model: config.model,
    text,
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

export async function synthesiseMinimax(config, request, { fetchImpl = fetch, signal } = {}) {
  if (!config.configured)
    throw new MinimaxSpeechError('TTS_NOT_CONFIGURED')
  signal?.throwIfAborted()
  let upstream
  try {
    upstream = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildMinimaxRequest(config, request)),
      redirect: 'error', // Do not forward credentials to an unexpected redirect host.
      signal,
    })
  }
  catch {
    signal?.throwIfAborted()
    throw new MinimaxSpeechError('TTS_UPSTREAM_FAILED')
  }
  if (!upstream.ok) {
    void upstream.body?.cancel().catch(() => {})
    throw new MinimaxSpeechError('TTS_UPSTREAM_FAILED')
  }
  if (!upstream.body || !upstream.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
    void upstream.body?.cancel().catch(() => {})
    throw new MinimaxSpeechError()
  }
  return await collectMinimaxStream(upstream.body, { textLength: request.text.length, signal })
}

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

  const acceptSubtitle = (subtitle) => {
    if (!subtitle || typeof subtitle !== 'object' || Array.isArray(subtitle)
      || !Number.isInteger(subtitle.text_begin) || !Number.isInteger(subtitle.text_end)
      || subtitle.text_begin < 0 || subtitle.text_end <= subtitle.text_begin
      || subtitle.text_end > textLength || typeof subtitle.text !== 'string' || subtitle.text.length > 720
      || !validTime(subtitle.time_begin) || !validTime(subtitle.time_end)
      || subtitle.time_end < subtitle.time_begin)
      throw new MinimaxSpeechError()
    const old = segments.get(subtitle.text_begin)
    if (old && (old.time_begin !== subtitle.time_begin || old.time_end > subtitle.time_end))
      throw new MinimaxSpeechError()
    const words = subtitle.timestamped_words
    if (words != null && (!Array.isArray(words) || words.length > MAX_WORDS))
      throw new MinimaxSpeechError()
    for (const word of words ?? []) {
      if (typeof word?.word !== 'string' || !word.word.trim() || word.word.length > 360
        || !Number.isInteger(word.word_begin) || !Number.isInteger(word.word_end)
        || word.word_begin < subtitle.text_begin || word.word_end > subtitle.text_end
        || word.word_end <= word.word_begin || !validTime(word.time_begin) || !validTime(word.time_end)
        || word.time_end < word.time_begin || word.time_begin < subtitle.time_begin
        || word.time_end > subtitle.time_end)
        throw new MinimaxSpeechError()
    }
    segments.set(subtitle.text_begin, subtitle)
    if (segments.size > 360)
      throw new MinimaxSpeechError()
  }

  const consumeEvent = () => {
    const data = eventLines.join('\n').trim()
    eventLines = []
    eventBytes = 0
    if (!data)
      return
    if (++events > MAX_STREAM_EVENTS)
      throw new MinimaxSpeechError()
    if (data === '[DONE]') {
      if (!final)
        throw new MinimaxSpeechError()
      terminal = true
      return
    }
    if (final || terminal)
      throw new MinimaxSpeechError()
    let chunk
    try {
      chunk = JSON.parse(data)
    }
    catch {
      throw new MinimaxSpeechError()
    }
    if (chunk?.base_resp?.status_code !== 0 || ![1, 2].includes(chunk?.data?.status))
      throw new MinimaxSpeechError()
    const audio = chunk.data.audio
    if (audio != null && typeof audio !== 'string')
      throw new MinimaxSpeechError()
    if (audio) {
      if (audio.length % 2 || !/^[\da-f]+$/i.test(audio) || audioBytes + audio.length / 2 > MAX_AUDIO_BYTES)
        throw new MinimaxSpeechError()
      const bytes = Buffer.from(audio, 'hex')
      audioBytes += bytes.length
      audioChunks.push(bytes)
    }
    // Ignore subtitle_file entirely: never fetch provider-supplied URLs.
    if (chunk.data.subtitle != null)
      acceptSubtitle(chunk.data.subtitle)
    if (chunk.data.subtitles != null) {
      if (chunk.data.status !== 2 || !Array.isArray(chunk.data.subtitles) || chunk.data.subtitles.length > 360)
        throw new MinimaxSpeechError()
      for (const subtitle of chunk.data.subtitles)
        acceptSubtitle(subtitle)
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
        throw new MinimaxSpeechError()
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
          throw new MinimaxSpeechError()
      }
      buffer += decoder.decode(value, { stream: !done })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES)
        throw new MinimaxSpeechError()
      for (const line of lines)
        consumeLine(line.replace(/\r$/, ''))
      if (done)
        break
    }
    // SSE events must be blank-line terminated. EOF inside a final JSON frame is
    // truncated too; never play partial synthesis just because some audio arrived.
    if (buffer.trim() || eventLines.length || !final || !audioBytes)
      throw new MinimaxSpeechError()
    const audio = Buffer.concat(audioChunks, audioBytes)
    const duration = finalInfo?.audio_length / 1_000
    if (finalInfo?.audio_format !== 'mp3' || finalInfo.audio_sample_rate !== SPEECH_SAMPLE_RATE
      || finalInfo.audio_channel !== 1 || finalInfo.audio_size !== audioBytes
      || !Number.isFinite(duration) || duration <= 0 || duration > MAX_SPEECH_SECONDS)
      throw new MinimaxSpeechError()
    // Structural frame validation rejects obvious wrong/truncated audio. Actual
    // decoder validity and silence checks happen on browser-decoded Float32 PCM.
    validateMp3(audio)

    const words = []
    let previousStart = -1
    let previousTextEnd = -1
    for (const segment of [...segments.values()].sort((a, b) => a.text_begin - b.text_begin)) {
      if (segment.time_end / 1_000 > duration || segment.text_begin < previousTextEnd)
        throw new MinimaxSpeechError()
      previousTextEnd = segment.text_end
      for (const word of segment.timestamped_words ?? []) {
        const start = word.time_begin / 1_000
        const end = word.time_end / 1_000
        // A zero-duration word has no playback interval. Drop it without
        // inventing/expanding timing; negative/backward values already failed.
        if (start === end)
          continue
        if (start < previousStart || end > duration || words.length >= MAX_WORDS)
          throw new MinimaxSpeechError()
        previousStart = start
        words.push({ text: word.word, start, end })
      }
    }
    return { audio: audio.toString('base64'), format: 'mp3', sampleRate: SPEECH_SAMPLE_RATE, words }
  }
  catch (error) {
    void reader.cancel().catch(() => {})
    if (signal?.aborted)
      signal.throwIfAborted()
    throw error instanceof MinimaxSpeechError ? error : new MinimaxSpeechError()
  }
  finally {
    signal?.removeEventListener('abort', abortRead)
    reader.releaseLock()
  }
}

function validTime(value) {
  return Number.isFinite(value) && value >= 0 && value <= MAX_SPEECH_SECONDS * 1_000
}

function validateMp3(audio) {
  let offset = 0
  // Optional ID3v2 header. The size is sync-safe; never treat the tag as audio.
  if (audio.subarray(0, 3).equals(Buffer.from('ID3'))) {
    if (audio.length < 10 || [6, 7, 8, 9].some(index => audio[index] > 0x7f))
      throw new MinimaxSpeechError()
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
      throw new MinimaxSpeechError()
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
      throw new MinimaxSpeechError()
    const bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
    const padding = audio[offset + 2] >> 1 & 1
    offset += Math.floor(144_000 * bitrates[bitrateIndex] / SPEECH_SAMPLE_RATE) + padding
    if (offset > audio.length)
      throw new MinimaxSpeechError()
    frames++
  }
  if (!frames)
    throw new MinimaxSpeechError()
}
