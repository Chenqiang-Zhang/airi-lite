import type { KokoroTTS } from '@uzen/kokoro-js'

export type VoiceState = 'idle' | 'loading' | 'ready' | 'fallback'

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.1-zh-ONNX'
const VOICE_ID = 'zf_001'

// The current browser build of the Chinese frontend cannot reliably phonemize
// arbitrary English spans. Keep common demo terms in the same Chinese voice.
function forChineseVoice(text: string): string | null {
  const spoken = text
    .replace(/\bAPI\s*Key\b/gi, '接口密钥')
    .replace(/\bHiyori\b/gi, '日和')
    .replace(/\bDeepSeek\b/gi, '深度求索')
    .replace(/\bLive2D\b/gi, '立绘')
    .replace(/\bKokoro\b/gi, '可可罗')
    .replace(/\bLLM\b/gi, '大语言模型')
    .replace(/\bAI\b/gi, '人工智能')
  return /[A-Za-z]/.test(spoken) ? null : spoken
}

export function createSpeechController(callbacks: {
  onState: (state: VoiceState) => void
  onPlaying: (playing: boolean) => void
  onMouth: (opening: number | null) => void
}) {
  let modelPromise: Promise<KokoroTTS> | null = null
  let unavailable = false
  let context: AudioContext | null = null
  let source: AudioBufferSourceNode | null = null
  let run = 0

  function unlock() {
    if (!context && 'AudioContext' in window)
      context = new AudioContext()
    if (context?.state === 'suspended')
      void context.resume()
  }

  async function prepare() {
    if (unavailable)
      throw new Error('Kokoro is unavailable in this browser')
    if (!('AudioContext' in window)) {
      unavailable = true
      callbacks.onState('fallback')
      throw new Error('Web Audio is unavailable in this browser')
    }
    if (modelPromise)
      return modelPromise

    callbacks.onState('loading')
    modelPromise = (async () => {
      const { KokoroTTS } = await import('@uzen/kokoro-js')
      const voicePath = `${import.meta.env.BASE_URL}kokoro/voices`

      if ('gpu' in navigator) {
        try {
          return await KokoroTTS.from_pretrained(MODEL_ID, {
            device: 'webgpu',
            dtype: 'q4f16',
            voicePath,
          })
        }
        catch (error) {
          console.warn('Kokoro WebGPU load failed; retrying with WASM', error)
        }
      }

      return KokoroTTS.from_pretrained(MODEL_ID, {
        device: 'wasm',
        dtype: 'q8',
        voicePath,
      })
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
    try {
      source?.stop()
    }
    catch { /* The buffer may already have ended. */ }
    source = null
    window.speechSynthesis?.cancel()
    callbacks.onMouth(0)
    callbacks.onPlaying(false)
  }

  async function playAudio(data: Float32Array, sampleRate: number, token: number) {
    if (!context)
      throw new Error('AudioContext is unavailable')
    await context.resume()
    if (token !== run)
      return

    const buffer = context.createBuffer(1, data.length, sampleRate)
    buffer.getChannelData(0).set(data)
    const analyser = context.createAnalyser()
    analyser.fftSize = 1024
    const waveform = new Float32Array(analyser.fftSize)
    const currentSource = context.createBufferSource()
    currentSource.buffer = buffer
    currentSource.connect(analyser)
    analyser.connect(context.destination)
    source = currentSource
    callbacks.onPlaying(true)

    let frame = 0
    let smoothed = 0
    const animate = () => {
      if (token !== run)
        return
      analyser.getFloatTimeDomainData(waveform)
      let energy = 0
      for (const value of waveform)
        energy += value * value
      const opening = Math.min(1, Math.sqrt(energy / waveform.length) * 5)
      smoothed = smoothed * 0.55 + opening * 0.45
      callbacks.onMouth(smoothed)
      frame = requestAnimationFrame(animate)
    }

    await new Promise<void>((resolve) => {
      currentSource.onended = () => {
        cancelAnimationFrame(frame)
        callbacks.onMouth(0)
        if (source === currentSource)
          source = null
        currentSource.disconnect()
        analyser.disconnect()
        resolve()
      }
      currentSource.start()
      animate()
    })
  }

  function browserFallback(text: string, token: number) {
    if (!('speechSynthesis' in window) || token !== run)
      return
    callbacks.onState('fallback')
    callbacks.onMouth(null)
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = 'zh-CN'
    utterance.rate = 0.95
    utterance.onstart = () => callbacks.onPlaying(true)
    utterance.onend = () => callbacks.onPlaying(false)
    utterance.onerror = () => callbacks.onPlaying(false)
    window.speechSynthesis.speak(utterance)
  }

  async function speak(text: string) {
    cancel()
    if (!text.trim())
      return
    const token = run
    const spoken = forChineseVoice(text)
    if (spoken === null) {
      browserFallback(text, token)
      return
    }
    try {
      unlock()
      const model = await prepare()
      if (token !== run)
        return
      for await (const segment of model.stream(spoken, { voice: VOICE_ID, speed: 0.98, maxChunkLength: 130 })) {
        if (token !== run)
          return
        callbacks.onState('ready')
        await playAudio(segment.audio.data as Float32Array, segment.audio.sampling_rate, token)
      }
      if (token === run)
        callbacks.onPlaying(false)
    }
    catch (error) {
      if (token !== run)
        return
      console.warn('Kokoro synthesis failed; using browser speech', error)
      browserFallback(text, token)
    }
  }

  function dispose() {
    cancel()
    void context?.close()
    context = null
  }

  return { unlock, prepare, speak, cancel, dispose }
}
