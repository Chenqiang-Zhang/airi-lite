import type { KokoroTTS, TextSplitterStream } from '@uzen/kokoro-js'
import type { Delivery } from './delivery'

import { chooseDelivery, deliverySpeed } from './delivery'
import { SentenceBuffer } from './sentence-buffer'

export type VoiceState = 'idle' | 'loading' | 'ready' | 'fallback'

interface AudioClip {
  samples: Float32Array
  sampleRate: number
}

interface PlaybackRun {
  token: number
  queue: AudioClip[]
  chunks: Float32Array[]
  sampleRate: number | null
  total: number
  synthesisFinished: boolean
  playingChunk: boolean
}

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.1-zh-ONNX'
const VOICE_ID = 'zf_001'
const LETTERS: Record<string, string> = {
  A: '诶', B: '比', C: '西', D: '迪', E: '伊', F: '艾弗', G: '吉',
  H: '艾尺', I: '艾', J: '杰', K: '凯', L: '艾勒', M: '艾姆',
  N: '恩', O: '欧', P: '皮', Q: '丘', R: '阿尔', S: '艾丝',
  T: '提', U: '优', V: '维', W: '达布流', X: '艾克斯', Y: '外', Z: '贼德',
}

// The packaged English phonemizer is unreliable in browsers. Keep the whole
// reply on Kokoro's fixed voice, approximating unfamiliar Latin words by letter.
function forChineseVoice(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '网址')
    .replace(/\bAPI\s*Key\b/gi, '接口密钥')
    .replace(/\bHiyori\b/gi, '日和')
    .replace(/\bDeepSeek\b/gi, '深度求索')
    .replace(/\bLive2D\b/gi, '立绘')
    .replace(/\bKokoro\b/gi, '可可罗')
    .replace(/\bHello\b/gi, '你好')
    .replace(/\bOpenAI\b/gi, '开放人工智能')
    .replace(/\bLLM\b/gi, '大语言模型')
    .replace(/\bAI\b/gi, '人工智能')
    .replace(/[A-Za-z]+/g, word => [...word.toUpperCase()].map(letter => LETTERS[letter]).join(''))
    .replace(/[`*_#~]/g, '')
}

function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const writeText = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++)
      view.setUint8(offset + i, value.charCodeAt(i))
  }
  writeText(0, 'RIFF')
  view.setUint32(4, buffer.byteLength - 8, true)
  writeText(8, 'WAVE')
  writeText(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeText(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  samples.forEach((sample, index) => {
    const clamped = Math.max(-1, Math.min(1, sample))
    view.setInt16(44 + index * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
  })
  return buffer
}

function mouthEnvelope(samples: Float32Array, sampleRate: number): number[] {
  const step = Math.max(1, Math.floor(sampleRate / 40))
  const envelope: number[] = []
  for (let start = 0; start < samples.length; start += step) {
    let energy = 0
    const end = Math.min(samples.length, start + step)
    for (let i = start; i < end; i++)
      energy += samples[i] * samples[i]
    envelope.push(Math.min(1, Math.sqrt(energy / (end - start)) * 5))
  }
  return envelope
}

export function createSpeechController(audio: HTMLAudioElement, callbacks: {
  onState: (state: VoiceState) => void
  onPlaying: (playing: boolean) => void
  onMouth: (opening: number | null) => void
  onAudioReady: (ready: boolean) => void
  onProblem: (message: string) => void
}) {
  let modelPromise: Promise<KokoroTTS> | null = null
  let unavailable = false
  let objectUrl: string | null = null
  let envelope: number[] = []
  let frame = 0
  let run = 0
  let activeRun: PlaybackRun | null = null

  audio.volume = 1
  audio.muted = false
  const animateMouth = () => {
    if (audio.paused)
      return
    callbacks.onMouth(envelope[Math.floor(audio.currentTime * 40)] ?? 0)
    frame = requestAnimationFrame(animateMouth)
  }
  const onPlaying = () => {
    callbacks.onProblem('')
    callbacks.onPlaying(true)
    cancelAnimationFrame(frame)
    animateMouth()
  }
  const onStopped = () => {
    cancelAnimationFrame(frame)
    callbacks.onMouth(0)
    callbacks.onPlaying(false)
  }
  const onEnded = () => {
    onStopped()
    if (!activeRun?.playingChunk)
      return
    activeRun.playingChunk = false
    advance(activeRun)
  }
  const onError = () => {
    onStopped()
    activeRun = null
    callbacks.onProblem('音频文件无法播放。请刷新页面重试，或更换浏览器。')
  }
  audio.addEventListener('playing', onPlaying)
  audio.addEventListener('pause', onStopped)
  audio.addEventListener('ended', onEnded)
  audio.addEventListener('error', onError)

  function replaceAudioSource(samples: Float32Array, sampleRate: number) {
    if (objectUrl)
      URL.revokeObjectURL(objectUrl)
    objectUrl = URL.createObjectURL(new Blob([encodeWav(samples, sampleRate)], { type: 'audio/wav' }))
    envelope = mouthEnvelope(samples, sampleRate)
    audio.src = objectUrl
    audio.load()
    callbacks.onAudioReady(true)
  }

  function advance(session: PlaybackRun) {
    if (session !== activeRun || session.token !== run || session.playingChunk)
      return

    const next = session.queue.shift()
    if (next) {
      session.playingChunk = true
      replaceAudioSource(next.samples, next.sampleRate)
      void audio.play().catch((error) => {
        if (session !== activeRun)
          return
        console.warn('Automatic audio playback was blocked', error)
        callbacks.onProblem('语音已生成，但自动播放被浏览器拦截。请点击下方播放器的播放键。')
      })
      return
    }

    if (!session.synthesisFinished || !session.sampleRate)
      return

    const samples = new Float32Array(session.total)
    let offset = 0
    for (const chunk of session.chunks) {
      samples.set(chunk, offset)
      offset += chunk.length
    }
    activeRun = null
    replaceAudioSource(samples, session.sampleRate)
  }

  async function prepare() {
    if (unavailable)
      throw new Error('Kokoro is unavailable in this browser')
    if (modelPromise)
      return modelPromise
    callbacks.onState('loading')
    modelPromise = (async () => {
      const { KokoroTTS } = await import('@uzen/kokoro-js')
      const voicePath = `${import.meta.env.BASE_URL}kokoro/voices`
      // Browser q4f16 returned silence and q8 returned invalid samples in testing.
      // The upstream browser demo recommends fp32 for both execution providers.
      if ('gpu' in navigator) {
        try {
          return await KokoroTTS.from_pretrained(MODEL_ID, { device: 'webgpu', dtype: 'fp32', voicePath })
        }
        catch (error) {
          console.warn('Kokoro WebGPU load failed; retrying with WASM', error)
        }
      }
      return KokoroTTS.from_pretrained(MODEL_ID, { device: 'wasm', dtype: 'fp32', voicePath })
    })()
    try {
      const model = await modelPromise
      callbacks.onState('ready')
      return model
    }
    catch (error) {
      unavailable = true
      modelPromise = null
      callbacks.onState('fallback')
      throw error
    }
  }

  function cancel() {
    run++
    activeRun = null
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
    if (objectUrl)
      URL.revokeObjectURL(objectUrl)
    objectUrl = null
    envelope = []
    callbacks.onAudioReady(false)
    callbacks.onMouth(0)
    callbacks.onPlaying(false)
    window.speechSynthesis?.cancel()
  }

  function browserFallback(text: string, token: number, delivery: Delivery) {
    if (token !== run)
      return
    callbacks.onState('fallback')
    callbacks.onMouth(null)
    if (!('speechSynthesis' in window)) {
      callbacks.onProblem('当前浏览器没有可用的语音播放功能。')
      return
    }
    callbacks.onProblem('本地声线不可用，正在尝试浏览器语音；若仍无声，请检查输出设备。')
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = 'zh-CN'
    utterance.rate = deliverySpeed(delivery)
    utterance.onstart = () => callbacks.onPlaying(true)
    utterance.onend = () => callbacks.onPlaying(false)
    utterance.onerror = () => {
      callbacks.onPlaying(false)
      callbacks.onProblem('浏览器语音播放失败。请检查网站静音、系统输出设备或改用 Chrome。')
    }
    window.speechSynthesis.speak(utterance)
  }

  async function consumeSegments(source: ReturnType<KokoroTTS['stream']>, token: number) {
    const session: PlaybackRun = {
      token,
      queue: [],
      chunks: [],
      sampleRate: null,
      total: 0,
      synthesisFinished: false,
      playingChunk: false,
    }
    activeRun = session
    try {
      for await (const segment of source) {
        if (token !== run)
          return
        const data = new Float32Array(segment.audio.data as Float32Array)
        const sampleRate = segment.audio.sampling_rate
        if (session.sampleRate && sampleRate !== session.sampleRate)
          throw new Error('Kokoro changed its audio sample rate during synthesis')
        let energy = 0
        let peak = 0
        for (const sample of data) {
          if (!Number.isFinite(sample))
            throw new Error('Kokoro returned invalid audio samples')
          energy += sample * sample
          peak = Math.max(peak, Math.abs(sample))
        }
        if (!data.length || peak < 0.001 || Math.sqrt(energy / data.length) < 0.0001)
          continue
        session.sampleRate = sampleRate
        session.chunks.push(data)
        session.total += data.length
        session.queue.push({ samples: data, sampleRate })
        advance(session)
      }
      if (token !== run)
        return
      if (!session.total)
        throw new Error('Kokoro returned silent audio')
      session.synthesisFinished = true
      callbacks.onState('ready')
      advance(session)
    }
    catch (error) {
      if (token !== run)
        return
      if (session.total) {
        console.warn('Kokoro synthesis stopped after partial audio', error)
        session.synthesisFinished = true
        callbacks.onProblem('后续语音生成中断；可以点击「朗读」重试。')
        advance(session)
      }
      else {
        activeRun = null
        throw error
      }
    }
  }

  async function speak(text: string, delivery: Delivery = 'neutral') {
    cancel()
    if (!text.trim())
      return
    const token = run
    callbacks.onProblem('正在生成语音…')
    try {
      const model = await prepare()
      if (token !== run)
        return
      await consumeSegments(model.stream(forChineseVoice(text), { voice: VOICE_ID, speed: deliverySpeed(delivery), maxChunkLength: 130 }), token)
    }
    catch (error) {
      if (token !== run)
        return
      console.warn('Kokoro synthesis failed; using browser speech', error)
      browserFallback(text, token, delivery)
    }
  }

  function beginStream(userText: string, onDelivery?: (delivery: Delivery) => void, preferredDelivery?: Delivery) {
    cancel()
    const token = run
    const buffer = new SentenceBuffer()
    const pendingSentences: string[] = []
    let splitter: TextSplitterStream | null = null
    let complete = false
    let fullText = ''
    let delivery: Delivery | null = null
    let resolveFirst!: () => void
    let resolveComplete!: () => void
    const firstSentence = new Promise<void>(resolve => (resolveFirst = resolve))
    const completion = new Promise<void>(resolve => (resolveComplete = resolve))

    const feed = (sentences: string[]) => {
      for (const sentence of sentences) {
        if (!delivery) {
          delivery = preferredDelivery ?? chooseDelivery(userText, sentence)
          onDelivery?.(delivery)
          callbacks.onProblem('正在生成语音…')
          resolveFirst()
        }
        const normalised = forChineseVoice(sentence)
        if (splitter) {
          splitter.push(normalised)
          splitter.flush()
        }
        else {
          pendingSentences.push(normalised)
        }
      }
    }

    const push = (delta: string) => {
      if (complete || token !== run)
        return
      fullText += delta
      feed(buffer.push(delta))
    }

    const finish = () => {
      if (complete || token !== run)
        return
      complete = true
      feed(buffer.finish())
      resolveFirst()
      splitter?.close()
      resolveComplete()
    }

    const cancelStream = () => {
      if (token !== run)
        return
      cancel()
      resolveFirst()
      resolveComplete()
    }

    const synthesize = async () => {
      try {
        const [model, { TextSplitterStream }] = await Promise.all([prepare(), import('@uzen/kokoro-js')])
        if (token !== run)
          return
        await firstSentence
        if (token !== run || !fullText.trim())
          return
        splitter = new TextSplitterStream()
        for (const sentence of pendingSentences) {
          splitter.push(sentence)
          splitter.flush()
        }
        pendingSentences.length = 0
        if (complete)
          splitter.close()
        await consumeSegments(model.stream(splitter, { voice: VOICE_ID, speed: deliverySpeed(delivery ?? 'neutral'), maxChunkLength: 130 }), token)
      }
      catch (error) {
        if (token !== run)
          return
        await completion
        if (token !== run)
          return
        console.warn('Kokoro streaming synthesis failed; using browser speech', error)
        browserFallback(fullText, token, delivery ?? 'neutral')
      }
    }
    void synthesize()

    return { push, finish, cancel: cancelStream }
  }

  function dispose() {
    cancel()
    audio.removeEventListener('playing', onPlaying)
    audio.removeEventListener('pause', onStopped)
    audio.removeEventListener('ended', onEnded)
    audio.removeEventListener('error', onError)
  }
  return { prepare, speak, beginStream, cancel, dispose }
}
