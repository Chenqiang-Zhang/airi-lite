import type { KokoroTTS } from '@uzen/kokoro-js'
import type { Delivery } from './delivery'
import type { VoiceId } from './voice'
import type { SpeechEngine } from './speech-mode'
import type { CloudSpeechClip } from './cloud-speech'

import { SpeechApiError } from './cloud-speech.ts'
import { deliverySpeed } from './delivery.ts'
import { mouthFrames } from './mouth.ts'
import type { MouthFrame } from './mouth'
import { deliveryAtTime, replySentenceStream, SpeechSentenceStream } from './speech-sentences.ts'
import type { DeliveryCue, PlaybackCue, SpokenSentence } from './speech-sentences'
import { DEFAULT_VOICE } from './voice.ts'

export type VoiceState = 'idle' | 'loading' | 'ready' | 'fallback' | 'browser' | 'cloud'

interface AudioClip {
  samples: Float32Array
  sampleRate: number
  delivery: Delivery
}

interface PlaybackRun {
  token: number
  queue: AudioClip[]
  chunks: Float32Array[]
  sampleRate: number | null
  total: number
  synthesisFinished: boolean
  playingChunk: boolean
  chunkStarted: boolean
  resumeCloudGeneration: (() => void) | null
  timeline: PlaybackCue[]
}

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.1-zh-ONNX'
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

type SpeechModel = Pick<KokoroTTS, 'stream'>

export function createSpeechController(audio: HTMLAudioElement, callbacks: {
  onState: (state: VoiceState) => void
  onPlaying: (playing: boolean) => void
  onPreparing: (preparing: boolean) => void
  onDelivery: (delivery: Delivery) => void
  onMouth: (opening: number | null, form: number) => void
  onAudioReady: (ready: boolean) => void
  onProblem: (message: string) => void
}, dependencies: {
  loadModel?: () => Promise<SpeechModel>
  synthesizeCloud?: (sentence: SpokenSentence, signal: AbortSignal) => Promise<CloudSpeechClip>
} = {}) {
  let modelPromise: Promise<SpeechModel> | null = null
  let unavailable = false
  let objectUrl: string | null = null
  let envelope: MouthFrame[] = []
  let frame = 0
  let run = 0
  let activeRun: PlaybackRun | null = null
  let activeInput: SpeechSentenceStream | null = null
  let playbackTimeline: PlaybackCue[] = []
  let reportedDelivery: Delivery | null = null
  let releaseUtterance: (() => void) | null = null
  let activeVoiceAbort: AbortController | null = null

  audio.volume = 1
  audio.muted = false
  const currentSource = () => objectUrl !== null && audio.currentSrc === objectUrl
  const animateMouth = () => {
    if (audio.paused)
      return
    const delivery = deliveryAtTime(playbackTimeline, audio.currentTime)
    if (delivery !== reportedDelivery) {
      reportedDelivery = delivery
      callbacks.onDelivery(delivery)
    }
    const mouth = envelope[Math.floor(audio.currentTime * 40)]
    callbacks.onMouth(mouth?.open ?? 0, mouth?.form ?? 0)
    frame = requestAnimationFrame(animateMouth)
  }
  const onPlaying = () => {
    if (!currentSource() || audio.paused || audio.ended)
      return
    if (activeRun?.playingChunk) {
      activeRun.chunkStarted = true
      wakeCloudGeneration(activeRun)
    }
    callbacks.onProblem('')
    callbacks.onPreparing(false)
    callbacks.onPlaying(true)
    cancelAnimationFrame(frame)
    animateMouth()
  }
  const onStopped = () => {
    if (!currentSource() || (!audio.paused && !audio.ended))
      return
    cancelAnimationFrame(frame)
    callbacks.onMouth(0, 0)
    callbacks.onPlaying(false)
  }
  const onEnded = () => {
    if (!currentSource() || !audio.ended)
      return
    onStopped()
    if (!activeRun?.playingChunk)
      return
    activeRun.playingChunk = false
    activeRun.chunkStarted = false
    advance(activeRun)
  }
  const onError = () => {
    if (!currentSource() || !audio.error)
      return
    cancel()
    callbacks.onProblem('音频文件无法播放。请刷新页面重试，或更换浏览器。')
  }
  audio.addEventListener('playing', onPlaying)
  audio.addEventListener('pause', onStopped)
  audio.addEventListener('ended', onEnded)
  audio.addEventListener('error', onError)

  function replaceAudioSource(samples: Float32Array, sampleRate: number, timeline: PlaybackCue[]) {
    if (objectUrl)
      URL.revokeObjectURL(objectUrl)
    objectUrl = URL.createObjectURL(new Blob([encodeWav(samples, sampleRate)], { type: 'audio/wav' }))
    envelope = mouthFrames(samples, sampleRate)
    playbackTimeline = timeline
    reportedDelivery = null
    audio.src = objectUrl
    audio.load()
    callbacks.onAudioReady(true)
  }

  function advance(session: PlaybackRun) {
    if (session !== activeRun || session.token !== run || session.playingChunk)
      return

    const next = session.queue.shift()
    // The queued lookahead is now the current clip, so a cloud producer may
    // consider fetching its next sentence after this clip actually starts.
    wakeCloudGeneration(session)
    if (next) {
      session.playingChunk = true
      session.chunkStarted = false
      replaceAudioSource(next.samples, next.sampleRate, [{ time: 0, delivery: next.delivery }])
      callbacks.onPreparing(false)
      void audio.play().catch((error) => {
        if (session !== activeRun)
          return
        console.warn('Automatic audio playback was blocked', error)
        callbacks.onProblem('语音已生成，但自动播放被浏览器拦截。请点击下方播放器的播放键。')
      })
      return
    }

    if (!session.synthesisFinished || !session.sampleRate) {
      callbacks.onPreparing(true)
      return
    }

    const samples = new Float32Array(session.total)
    let offset = 0
    for (const chunk of session.chunks) {
      samples.set(chunk, offset)
      offset += chunk.length
    }
    activeRun = null
    callbacks.onPreparing(false)
    replaceAudioSource(samples, session.sampleRate, session.timeline)
  }

  function wakeCloudGeneration(session: PlaybackRun) {
    const resume = session.resumeCloudGeneration
    session.resumeCloudGeneration = null
    resume?.()
  }

  function hasCloudCapacity(session: PlaybackRun): boolean {
    // A paid request may produce the initial clip, or one lookahead while a
    // real current clip is playing. A paused/blocked initial player must not
    // keep buying the rest of a reply simply because play() was attempted.
    return !session.queue.length && (!session.playingChunk
      || (session.chunkStarted && currentSource() && !audio.paused && !audio.ended))
  }

  async function waitForCloudCapacity(session: PlaybackRun, signal: AbortSignal): Promise<boolean> {
    while (session === activeRun && session.token === run && !signal.aborted) {
      if (hasCloudCapacity(session))
        return true
      await new Promise<void>((resolve) => { session.resumeCloudGeneration = resolve })
    }
    return false
  }

  async function prepare(token: number = run) {
    const report = (state: VoiceState) => {
      if (token === run) callbacks.onState(state)
    }
    if (unavailable)
      throw new Error('Kokoro is unavailable in this browser')
    if (!modelPromise) {
      report('loading')
      modelPromise = (async () => {
        if (dependencies.loadModel)
          return dependencies.loadModel()
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
    }
    try {
      const model = await modelPromise
      report('ready')
      return model
    }
    catch (error) {
      unavailable = true
      modelPromise = null
      report('fallback')
      throw error
    }
  }

  function cancel() {
    run++
    activeVoiceAbort?.abort()
    activeVoiceAbort = null
    if (activeRun)
      wakeCloudGeneration(activeRun)
    activeInput?.cancel()
    activeInput = null
    releaseUtterance?.()
    releaseUtterance = null
    activeRun = null
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
    if (objectUrl)
      URL.revokeObjectURL(objectUrl)
    objectUrl = null
    envelope = []
    playbackTimeline = []
    reportedDelivery = null
    callbacks.onAudioReady(false)
    callbacks.onMouth(0, 0)
    callbacks.onPlaying(false)
    callbacks.onPreparing(false)
    window.speechSynthesis?.cancel()
  }

  async function browserSpeech(input: AsyncIterable<SpokenSentence>, token: number, fallbackMessage?: string) {
    if (token !== run)
      return
    callbacks.onState(fallbackMessage ? 'fallback' : 'browser')
    if (!('speechSynthesis' in window)) {
      callbacks.onPreparing(false)
      callbacks.onProblem('当前浏览器没有可用的语音播放功能。')
      return
    }
    callbacks.onProblem(fallbackMessage ?? '')
    for await (const sentence of input) {
      if (token !== run)
        return
      callbacks.onPreparing(true)
      const succeeded = await new Promise<boolean>((resolve) => {
        let completed = false
        const complete = (succeeded: boolean) => {
          if (completed) return
          completed = true
          if (releaseUtterance === cancelUtterance)
            releaseUtterance = null
          resolve(succeeded)
        }
        const cancelUtterance = () => complete(false)
        releaseUtterance = cancelUtterance
        const utterance = new SpeechSynthesisUtterance(sentence.text)
        utterance.lang = 'zh-CN'
        utterance.rate = deliverySpeed(sentence.delivery)
        utterance.onstart = () => {
          if (token !== run || releaseUtterance !== cancelUtterance) return
          callbacks.onPreparing(false)
          callbacks.onDelivery(sentence.delivery)
          callbacks.onMouth(null, 0)
          callbacks.onPlaying(true)
        }
        utterance.onend = () => {
          if (token === run && releaseUtterance === cancelUtterance) {
            callbacks.onMouth(0, 0)
            callbacks.onPlaying(false)
          }
          complete(true)
        }
        utterance.onerror = () => {
          if (token === run && releaseUtterance === cancelUtterance) {
            callbacks.onPreparing(false)
            callbacks.onPlaying(false)
            callbacks.onMouth(0, 0)
            callbacks.onProblem('浏览器语音播放失败。请检查网站静音、系统输出设备或改用 Chrome。')
          }
          complete(false)
        }
        try { window.speechSynthesis.speak(utterance) }
        catch { utterance.onerror?.(new Event('error') as SpeechSynthesisErrorEvent) }
      })
      if (token !== run || !succeeded)
        return
    }
    if (token === run)
      callbacks.onPreparing(false)
  }

  async function *synthesizeCloudSentences(input: AsyncIterable<SpokenSentence>, token: number): AsyncGenerator<AudioClip> {
    if (!dependencies.synthesizeCloud)
      throw new Error('Cloud voice is not configured')
    // consumeSegments installs this exact run before pulling the generator.
    // Never use a newer activeRun after an old capacity wait resumes.
    const session = activeRun
    if (!session || session.token !== token || token !== run)
      return
    const controller = new AbortController()
    activeVoiceAbort = controller
    try {
      for await (const sentence of input) {
        while (true) {
          if (!await waitForCloudCapacity(session, controller.signal)
            || session !== activeRun || token !== run || controller.signal.aborted) return
          // Awaiting even an already-resolved capacity promise yields a
          // microtask. A pause in that gap revokes the permit; wait again for
          // this same sentence rather than dropping it or buying it paused.
          if (hasCloudCapacity(session))
            break
        }
        // Preserve real Chinese/English text; Kokoro's browser workaround must
        // never rewrite a cloud provider's input. No retries of paid requests.
        const clip = await dependencies.synthesizeCloud(sentence, controller.signal)
        if (token !== run || controller.signal.aborted) return
        yield { ...clip, delivery: sentence.delivery }
      }
    }
    finally {
      if (activeVoiceAbort === controller) activeVoiceAbort = null
    }
  }

  async function *synthesizeSentences(model: SpeechModel, input: AsyncIterable<SpokenSentence>, voice: VoiceId, token: number): AsyncGenerator<AudioClip> {
    for await (const sentence of input) {
      if (token !== run) return
      for await (const segment of model.stream(forChineseVoice(sentence.text), {
        voice, speed: deliverySpeed(sentence.delivery), maxChunkLength: 130,
      })) {
        if (token !== run) return
        yield {
          samples: new Float32Array(segment.audio.data as Float32Array),
          sampleRate: segment.audio.sampling_rate,
          delivery: sentence.delivery,
        }
      }
    }
  }

  async function *resumeSentences(first: SpokenSentence, rest: AsyncIterator<SpokenSentence>): AsyncGenerator<SpokenSentence> {
    yield first
    while (true) {
      const next = await rest.next()
      if (next.done)
        return
      yield next.value
    }
  }

  async function synthesizeInput(input: SpeechSentenceStream, voice: VoiceId, token: number, engine: SpeechEngine) {
    // Do not load a large voice model for a reply containing only code/markup.
    // Waiting for the first *spoken* sentence also keeps fallback from treating
    // intentional omission as invalid or silent synthesized audio.
    const sentences = input[Symbol.asyncIterator]()
    const first = await sentences.next()
    if (token !== run)
      return
    if (first.done) {
      callbacks.onPreparing(false)
      callbacks.onProblem('这条回复没有可朗读的正文；代码或符号只在消息里展示。')
      return
    }
    callbacks.onPreparing(true)
    callbacks.onProblem('正在生成语音…')
    const resumed = resumeSentences(first.value, sentences)
    if (engine === 'browser') {
      await browserSpeech(resumed, token)
      return
    }
    if (engine === 'cloud') {
      callbacks.onState('cloud')
      await consumeSegments(synthesizeCloudSentences(resumed, token), token, 'cloud')
      return
    }
    const model = await prepare(token)
    if (token !== run)
      return
    await consumeSegments(synthesizeSentences(model, resumed, voice, token), token, 'ready')
  }

  async function consumeSegments(source: AsyncIterable<AudioClip>, token: number, state: 'ready' | 'cloud') {
    const session: PlaybackRun = {
      token,
      queue: [],
      chunks: [],
      sampleRate: null,
      total: 0,
      synthesisFinished: false,
      playingChunk: false,
      chunkStarted: false,
      resumeCloudGeneration: null,
      timeline: [],
    }
    activeRun = session
    try {
      for await (const segment of source) {
        if (token !== run)
          return
        const data = segment.samples
        const sampleRate = segment.sampleRate
        if (session.sampleRate && sampleRate !== session.sampleRate)
          throw new Error('Speech sample rate changed during synthesis')
        if (!Number.isInteger(sampleRate) || sampleRate <= 0)
          throw new Error('Speech returned an invalid sample rate')
        let energy = 0
        let peak = 0
        for (const sample of data) {
          if (!Number.isFinite(sample))
            throw new Error('Speech returned invalid audio samples')
          energy += sample * sample
          peak = Math.max(peak, Math.abs(sample))
        }
        if (!data.length || peak < 0.001 || Math.sqrt(energy / data.length) < 0.0001) {
          // Do not pay for more cloud sentences when the initial result cannot
          // produce a playable current clip. Local chunk filtering is unchanged.
          if (state === 'cloud')
            throw new Error('Cloud speech returned silent audio')
          continue
        }
        session.sampleRate = sampleRate
        session.timeline.push({ time: session.total / sampleRate, delivery: segment.delivery })
        session.chunks.push(data)
        session.total += data.length
        session.queue.push(segment)
        advance(session)
      }
      if (token !== run)
        return
      if (!session.total)
        throw new Error('Speech returned silent audio')
      session.synthesisFinished = true
      callbacks.onState(state)
      advance(session)
    }
    catch (error) {
      if (token !== run)
        return
      if (session.total) {
        console.warn('Speech synthesis stopped after partial audio', error)
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

  function fallbackProblem(engine: SpeechEngine, error: unknown): string {
    return engine === 'cloud'
      ? `${error instanceof SpeechApiError ? error.message : '云端语音生成失败。'}已尝试轻量浏览器语音，不会下载本地大模型。`
      : '本地声线不可用，正在尝试浏览器语音；若仍无声，请检查输出设备。'
  }

  async function speak(text: string, delivery: Delivery = 'neutral', voice: VoiceId = DEFAULT_VOICE, cues: DeliveryCue[] = [], engine: SpeechEngine = 'local') {
    cancel()
    if (!text.trim())
      return
    const token = run
    const input = replySentenceStream(text, delivery, cues)
    activeInput = input
    callbacks.onProblem('')
    try {
      await synthesizeInput(input, voice, token, engine)
    }
    catch (error) {
      if (token !== run)
        return
      console.warn('Speech synthesis failed; using browser speech', error)
      const fallbackInput = replySentenceStream(text, delivery, cues)
      activeInput = fallbackInput
      await browserSpeech(fallbackInput, token, fallbackProblem(engine, error))
    }
    finally {
      if (token === run)
        activeInput = null
    }
  }

  function beginStream(userText: string, preferredDelivery?: Delivery, voice: VoiceId = DEFAULT_VOICE, engine: SpeechEngine = 'local') {
    cancel()
    const token = run
    const input = new SpeechSentenceStream(userText, preferredDelivery)
    const cues: DeliveryCue[] = preferredDelivery ? [{ start: 0, delivery: preferredDelivery }] : []
    activeInput = input
    callbacks.onProblem('')

    const cancelStream = () => {
      input.cancel()
      if (token === run)
        cancel()
    }

    const synthesize = async () => {
      try {
        await synthesizeInput(input, voice, token, engine)
      }
      catch (error) {
        if (token !== run)
          return
        await input.finished
        if (token !== run)
          return
        console.warn('Speech streaming synthesis failed; using browser speech', error)
        const fallbackInput = replySentenceStream(input.text, preferredDelivery, cues, userText)
        activeInput = fallbackInput
        await browserSpeech(fallbackInput, token, fallbackProblem(engine, error))
      }
      finally {
        if (token === run)
          activeInput = null
      }
    }
    void synthesize()

    return {
      push(delta: string) { if (token === run) input.push(delta) },
      setDelivery(delivery: Delivery) {
        if (token !== run) return
        cues.push({ start: input.text.length, delivery })
        input.setDelivery(delivery)
      },
      finish() { input.finish() },
      cancel: cancelStream,
    }
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
