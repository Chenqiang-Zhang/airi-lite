import type { KokoroTTS } from '@uzen/kokoro-js'
import type { Delivery } from './delivery'
import type { VoiceId } from './voice'
import type { SpeechEngine } from './speech-mode'
import type { CloudSpeechClip, SpeechWord, SpeechCharacter } from './cloud-speech'
import { speechBeats, speechBeatAtTime } from './speech-beats.ts'
import type { SpeechBeatSegment } from './speech-beats'

import { SpeechApiError } from './cloud-speech.ts'
import { createPcm16Blob, createWavBlob, createWavHeader } from './audio-wav.ts'
import { deliverySpeed } from './delivery.ts'
import { mouthAtTime, mouthFrames } from './mouth.ts'
import { createPlaybackClockGuard } from './playback-clock.ts'
import type { MouthSegment } from './mouth'
import { deliveryAtTime, replySentenceStream, SpeechSentenceStream } from './speech-sentences.ts'
import type { DeliveryCue, PlaybackCue, SpokenSentence } from './speech-sentences'
import { DEFAULT_VOICE } from './voice.ts'

export type VoiceState = 'idle' | 'loading' | 'ready' | 'fallback' | 'browser' | 'cloud'

// How one speak() run ended, reported once. `played` means every sentence was
// synthesized and the last clip drained; `partial` means some audio played
// before synthesis failed. The live stage reports this back to the server.
export type SpeechRunOutcome = 'played' | 'partial' | 'failed' | 'cancelled' | 'empty'

export interface SpeakOptions {
  onEnded?: (outcome: SpeechRunOutcome) => void
}

// Policy deadline for an unconfirmed native start, not a browser guarantee or
// maximum speaking duration. A real start retires it, including during pause.
export const BROWSER_SPEECH_START_DEADLINE_MS = 15_000

interface AudioClip {
  samples: Float32Array
  sampleRate: number
  delivery: Delivery
  words?: readonly SpeechWord[]
  wordAlignmentAvailable?: true
  characters?: readonly SpeechCharacter[]
}

interface PreparedAudioClip {
  pcm: Blob
  sampleCount: number
  sampleRate: number
  delivery: Delivery
  mouth: MouthSegment
  beats: SpeechBeatSegment
}

interface PlaybackRun {
  token: number
  queue: PreparedAudioClip[]
  pcmParts: Blob[]
  sampleRate: number | null
  total: number
  synthesisFinished: boolean
  synthesisSucceeded: boolean
  playingChunk: boolean
  chunkStarted: boolean
  resumeCloudGeneration: (() => void) | null
  resumeLocalGeneration: (() => void) | null
  timeline: PlaybackCue[]
  mouthTimeline: MouthSegment[]
  beatTimeline: SpeechBeatSegment[]
  lastBeatPeak: number
}

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.1-zh-ONNX'
const MAX_READY_PLAYBACK_CLIPS = 3
const MAX_READY_PLAYBACK_SECONDS = 12
const MAX_LOCAL_LOOKAHEAD_CLIPS = 3
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

type SpeechModel = Pick<KokoroTTS, 'stream'>

export function createSpeechController(audio: HTMLAudioElement, callbacks: {
  onState: (state: VoiceState) => void
  onPlaying: (playing: boolean) => void
  onPreparing: (preparing: boolean) => void
  onDelivery: (delivery: Delivery) => void
  onMouth: (opening: number | null, form: number, beat: number | null) => void
  onAudioReady: (ready: boolean) => void
  onProblem: (message: string) => void
}, dependencies: {
  loadModel?: () => Promise<SpeechModel>
  synthesizeCloud?: (sentence: SpokenSentence, signal: AbortSignal) => Promise<CloudSpeechClip>
  scheduleBrowserStartDeadline?: (expired: () => void, milliseconds: number) => () => void
  // false: a failed local/cloud run is skipped instead of retried with the
  // system voice (OBS browser sources may have no audible speechSynthesis).
  browserFallback?: boolean
} = {}) {
  const browserFallback = dependencies.browserFallback ?? true
  const scheduleBrowserStartDeadline = dependencies.scheduleBrowserStartDeadline ?? ((expired, milliseconds) => {
    const timeout = setTimeout(expired, milliseconds)
    return () => clearTimeout(timeout)
  })
  let modelPromise: Promise<SpeechModel> | null = null
  let unavailable = false
  let objectUrl: string | null = null
  let completedAudio: { blob: Blob, token: number, source: string } | null = null
  let playbackMouth: readonly MouthSegment[] = []
  let playbackBeats: readonly SpeechBeatSegment[] = []
  let frame = 0
  let run = 0
  let activeRun: PlaybackRun | null = null
  let activeInput: SpeechSentenceStream | null = null
  let playbackTimeline: PlaybackCue[] = []
  let reportedDelivery: Delivery | null = null
  let releaseUtterance: (() => void) | null = null
  let activeVoiceAbort: AbortController | null = null
  let playbackStarted = false
  let seekingSource: string | null = null
  const playbackClock = createPlaybackClockGuard()
  let playbackClockStalled = false
  let mouthFrameRevision = 0
  let pendingEnd: { token: number, fire: (outcome: SpeechRunOutcome) => void } | null = null
  // Fires at most once per speak() token. Deferred so a callback that starts
  // another run can never reenter cancel() or advance() mid-transition.
  const settle = (token: number, outcome: SpeechRunOutcome) => {
    const pending = pendingEnd
    if (!pending || pending.token !== token)
      return
    pendingEnd = null
    pending.fire(outcome)
  }

  audio.volume = 1
  audio.muted = false
  const currentSource = () => objectUrl !== null && audio.currentSrc === objectUrl
  const playableCurrentSource = () => currentSource() && !audio.paused && !audio.ended
    && !audio.seeking && audio.readyState >= 3 && !audio.error
  const retireMouthFrame = () => {
    mouthFrameRevision++
    cancelAnimationFrame(frame)
  }
  const resetPlaybackClock = () => {
    playbackClock.reset()
    playbackClockStalled = false
  }
  const scheduleMouthFrame = () => {
    const revision = ++mouthFrameRevision
    const token = run
    const source = objectUrl
    frame = requestAnimationFrame((timestamp) => {
      // cancelAnimationFrame cannot revoke a callback already being delivered.
      // A full-cache replacement changes source without changing the run.
      if (revision !== mouthFrameRevision || token !== run || source !== objectUrl)
        return
      animateMouth(timestamp)
    })
  }
  const suspendPlayback = (preparing: boolean) => {
    playbackStarted = false
    retireMouthFrame()
    resetPlaybackClock()
    const token = run
    const source = objectUrl
    const revision = mouthFrameRevision
    const owns = () => token === run && source === objectUrl && revision === mouthFrameRevision
    callbacks.onMouth(0, 0, null)
    if (!owns()) return
    callbacks.onPlaying(false)
    if (!owns()) return
    callbacks.onPreparing(preparing)
  }
  const animateMouth = (timestamp: number = performance.now()) => {
    if (!playbackStarted)
      return
    const token = run
    const source = objectUrl
    const revision = mouthFrameRevision
    const owns = () => playbackStarted && token === run && source === objectUrl && revision === mouthFrameRevision
    // A media seek/wait can leave paused=false while no sound is advancing.
    // Read current state too, before a queued media event has been delivered.
    if (!playableCurrentSource()) {
      if (currentSource() && audio.seeking)
        seekingSource = objectUrl
      suspendPlayback(currentSource() && !audio.paused && !audio.ended && !audio.error)
      return
    }
    const clockState = playbackClock.observe(audio.currentTime, timestamp)
    if (clockState === 'stalled' && !playbackClockStalled) {
      // Keep observing this source, but don't animate a stationary waveform
      // or give a producer permission to compute/buy more unplayed speech.
      playbackClockStalled = true
      callbacks.onMouth(0, 0, null)
      if (!owns()) return
      callbacks.onPlaying(false)
      if (!owns()) return
      callbacks.onPreparing(true)
      if (!owns()) return
    }
    else if (clockState === 'advancing' && playbackClockStalled) {
      playbackClockStalled = false
      callbacks.onPreparing(false)
      if (!owns()) return
      callbacks.onPlaying(true)
      if (!owns()) return
      if (activeRun?.playingChunk)
        wakeGeneration(activeRun)
    }
    if (playbackClockStalled) {
      // A long background RAF gap is only a fresh baseline, not recovery.
      if (owns()) scheduleMouthFrame()
      return
    }
    const delivery = deliveryAtTime(playbackTimeline, audio.currentTime)
    if (delivery !== reportedDelivery) {
      reportedDelivery = delivery
      callbacks.onDelivery(delivery)
      if (!owns()) return
    }
    const mouth = mouthAtTime(playbackMouth, audio.currentTime)
    callbacks.onMouth(mouth.open, mouth.form, speechBeatAtTime(playbackBeats, audio.currentTime))
    if (owns()) scheduleMouthFrame()
  }
  const onPlaying = () => {
    if (!playableCurrentSource())
      return
    retireMouthFrame()
    playbackStarted = true
    const token = run
    const source = objectUrl
    const revision = mouthFrameRevision
    const owns = () => playbackStarted && token === run && source === objectUrl && revision === mouthFrameRevision
    if (!playbackClockStalled) {
      if (activeRun?.playingChunk) {
        activeRun.chunkStarted = true
        wakeGeneration(activeRun)
      }
      callbacks.onProblem('')
      if (!owns()) return
      callbacks.onPreparing(false)
      if (!owns()) return
      callbacks.onPlaying(true)
      if (!owns()) return
    }
    // A duplicate native playing event alone cannot reopen a clock-stalled
    // source. The observer below must see actual forward media progress.
    animateMouth()
  }
  const onStopped = () => {
    if (!currentSource() || (!audio.paused && !audio.ended))
      return
    suspendPlayback(false)
  }
  const onWaiting = () => {
    // Ignore an old queued event if the current source has already recovered.
    if (!currentSource() || audio.paused || audio.ended || audio.error
      || (!audio.seeking && audio.readyState >= 3))
      return
    suspendPlayback(true)
  }
  const onSeeking = () => {
    if (!currentSource() || !audio.seeking)
      return
    seekingSource = objectUrl
    suspendPlayback(!audio.paused && !audio.ended && !audio.error)
  }
  const onSeeked = () => {
    if (!currentSource() || seekingSource !== objectUrl || audio.seeking)
      return
    seekingSource = null
    // A buffered seek need not emit another playing event. Resume only after
    // the same source's seek completes with future data and playback intent.
    onPlaying()
  }
  const onEnded = () => {
    if (!currentSource() || !audio.ended)
      return
    const session = activeRun
    const token = run
    const source = objectUrl
    onStopped()
    if (token !== run || source !== objectUrl || session !== activeRun || !session?.playingChunk
      || !audio.ended)
      return
    session.playingChunk = false
    session.chunkStarted = false
    advance(session)
  }
  const onError = () => {
    if (!currentSource() || !audio.error)
      return
    settle(run, 'failed')
    cancel()
    callbacks.onProblem('音频文件无法播放。请刷新页面重试，或更换浏览器。')
  }
  audio.addEventListener('playing', onPlaying)
  audio.addEventListener('pause', onStopped)
  audio.addEventListener('ended', onEnded)
  audio.addEventListener('error', onError)
  audio.addEventListener('waiting', onWaiting)
  audio.addEventListener('seeking', onSeeking)
  audio.addEventListener('seeked', onSeeked)

  function replaceAudioSource(parts: readonly Blob[], sampleRate: number, timeline: PlaybackCue[], mouthTimeline: readonly MouthSegment[], beatTimeline: readonly SpeechBeatSegment[], token: number, completed = false): boolean {
    if (token !== run) return false
    const previousSource = objectUrl
    const source = createWavBlob(parts, sampleRate)
    completedAudio = null
    // Loading the full reply is preparation, not a request to replay it.
    // Explicitly leave the previous source paused before any replacement;
    // advance() alone requests playback for a new current clip.
    audio.pause()
    // A native pause callback may cancel or begin another run. Never install
    // an old source (or expose its snapshot) after that reentrant transition.
    if (token !== run || objectUrl !== previousSource) return false
    playbackStarted = false
    seekingSource = null
    retireMouthFrame()
    resetPlaybackClock()
    if (objectUrl)
      URL.revokeObjectURL(objectUrl)
    objectUrl = URL.createObjectURL(source)
    // Keep each clip's own calibrated track. Re-analyzing the concatenated
    // reply would let a loud later sentence change a quiet earlier mouth.
    playbackMouth = mouthTimeline
    playbackBeats = beatTimeline
    playbackTimeline = timeline
    reportedDelivery = null
    audio.src = objectUrl
    const installedSource = objectUrl
    audio.load()
    if (token !== run || objectUrl !== installedSource) return false
    // The exact immutable Blob backing this source, not another PCM copy.
    // Only advance's drained, successfully synthesized full-replay path sets it.
    if (completed) completedAudio = { blob: source, token, source: installedSource }
    callbacks.onAudioReady(true)
    return token === run && objectUrl === installedSource
  }

  function advance(session: PlaybackRun) {
    if (session !== activeRun || session.token !== run || session.playingChunk)
      return

    const next = session.queue.shift()
    // The queued lookahead is now the current clip, so a cloud producer may
    // consider fetching its next sentence after this clip actually starts.
    wakeGeneration(session)
    if (next) {
      // Reuse only already-ready, same-tone PCM. Never wait to fill a batch,
      // trim a real pause, or generate more cloud audio to join it. A tone
      // change remains a separate source; original per-clip calibration stays.
      const ready = [next]
      let total = next.sampleCount
      while (ready.length < MAX_READY_PLAYBACK_CLIPS) {
        const candidate = session.queue[0]
        if (!candidate || candidate.delivery !== next.delivery
          || (total + candidate.sampleCount) / next.sampleRate > MAX_READY_PLAYBACK_SECONDS)
          break
        ready.push(session.queue.shift()!)
        total += candidate.sampleCount
      }
      const mouth: MouthSegment[] = []
      const beats: SpeechBeatSegment[] = []
      let offset = 0
      for (const clip of ready) {
        mouth.push({ ...clip.mouth, time: offset / next.sampleRate })
        beats.push({ ...clip.beats, time: offset / next.sampleRate })
        offset += clip.sampleCount
      }
      session.playingChunk = true
      session.chunkStarted = false
      if (!replaceAudioSource(ready.map(clip => clip.pcm), next.sampleRate, [{ time: 0, delivery: next.delivery }], mouth, beats, session.token)) return
      const source = objectUrl
      callbacks.onPreparing(false)
      if (session !== activeRun || session.token !== run || source !== objectUrl) return
      void audio.play().catch((error) => {
        if (session !== activeRun || session.token !== run || source !== objectUrl)
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

    activeRun = null
    const source = objectUrl
    callbacks.onPreparing(false)
    if (session.token !== run || activeRun !== null || source !== objectUrl) return
    replaceAudioSource(session.pcmParts, session.sampleRate, session.timeline, session.mouthTimeline, session.beatTimeline, session.token, session.synthesisSucceeded)
    settle(session.token, session.synthesisSucceeded ? 'played' : 'partial')
  }

  function wakeGeneration(session: PlaybackRun) {
    const resume = session.resumeCloudGeneration
    session.resumeCloudGeneration = null
    resume?.()
    const local = session.resumeLocalGeneration
    session.resumeLocalGeneration = null
    local?.()
  }

  function hasLocalCapacity(session: PlaybackRun): boolean {
    if (!session.playingChunk)
      return !session.queue.length
    // Bound unplayed lookahead, including within one model.stream() input.
    // A paused/blocked player must not compute the rest of a long reply.
    // One already in-flight result may finish; played audio remains cached
    // for full replay, so this is a clip-count limit, not a total byte cap.
    return session.queue.length < MAX_LOCAL_LOOKAHEAD_CLIPS
      && session.chunkStarted && playbackStarted && !playbackClockStalled && playableCurrentSource()
  }

  async function waitForLocalCapacity(session: PlaybackRun): Promise<boolean> {
    while (session === activeRun && session.token === run) {
      if (hasLocalCapacity(session))
        return true
      await new Promise<void>((resolve) => { session.resumeLocalGeneration = resolve })
    }
    return false
  }

  function hasCloudCapacity(session: PlaybackRun): boolean {
    // A paid request may produce the initial clip, or one lookahead while a
    // real current clip is playing. A paused/blocked initial player must not
    // keep buying the rest of a reply simply because play() was attempted.
    return !session.queue.length && (!session.playingChunk
      || (session.chunkStarted && playbackStarted && !playbackClockStalled && playableCurrentSource()))
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
    settle(run, 'cancelled')
    run++
    completedAudio = null
    playbackStarted = false
    seekingSource = null
    retireMouthFrame()
    resetPlaybackClock()
    activeVoiceAbort?.abort()
    activeVoiceAbort = null
    if (activeRun)
      wakeGeneration(activeRun)
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
    playbackMouth = []
    playbackBeats = []
    playbackTimeline = []
    reportedDelivery = null
    callbacks.onAudioReady(false)
    callbacks.onMouth(0, 0, null)
    callbacks.onPlaying(false)
    callbacks.onPreparing(false)
    window.speechSynthesis?.cancel()
  }

  // Resolves true only when every sentence confirmed start and ended.
  async function browserSpeech(input: AsyncIterable<SpokenSentence>, token: number, fallbackMessage?: string): Promise<boolean> {
    if (token !== run)
      return false
    callbacks.onState(fallbackMessage ? 'fallback' : 'browser')
    if (!('speechSynthesis' in window)) {
      callbacks.onPreparing(false)
      callbacks.onProblem('当前浏览器没有可用的语音播放功能。')
      return false
    }
    callbacks.onProblem(fallbackMessage ?? '')
    for await (const sentence of input) {
      if (token !== run)
        return false
      callbacks.onPreparing(true)
      const succeeded = await new Promise<boolean>((resolve) => {
        let completed = false
        let started = false
        let clearStartDeadline: (() => void) | null = null
        const retireStartDeadline = () => {
          const clear = clearStartDeadline
          clearStartDeadline = null
          clear?.()
        }
        const complete = (succeeded: boolean) => {
          if (completed) return
          completed = true
          retireStartDeadline()
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
          started = true
          retireStartDeadline()
          callbacks.onPreparing(false)
          callbacks.onDelivery(sentence.delivery)
          callbacks.onMouth(null, 0, null)
          callbacks.onPlaying(true)
        }
        utterance.onpause = () => {
          if (!started || completed || token !== run || releaseUtterance !== cancelUtterance) return
          callbacks.onMouth(0, 0, null)
          callbacks.onPlaying(false)
          callbacks.onPreparing(false)
        }
        utterance.onresume = () => {
          if (!started || completed || token !== run || releaseUtterance !== cancelUtterance) return
          callbacks.onPreparing(false)
          callbacks.onDelivery(sentence.delivery)
          callbacks.onMouth(null, 0, null)
          callbacks.onPlaying(true)
        }
        utterance.onend = () => {
          if (token === run && releaseUtterance === cancelUtterance) {
            callbacks.onMouth(0, 0, null)
            callbacks.onPlaying(false)
            if (!started) {
              // Some native engines finish without ever confirming playback.
              // An end notification alone must not silently advance the reply.
              callbacks.onPreparing(false)
              callbacks.onProblem('系统语音未确认开始播放，请更换语音模式或检查浏览器与系统声线。')
            }
          }
          complete(started)
        }
        utterance.onerror = () => {
          if (token === run && releaseUtterance === cancelUtterance) {
            callbacks.onPreparing(false)
            callbacks.onPlaying(false)
            callbacks.onMouth(0, 0, null)
            callbacks.onProblem('浏览器语音播放失败。请检查网站静音、系统输出设备或改用 Chrome。')
          }
          complete(false)
        }
        const startExpired = () => {
          if (started || completed || token !== run || releaseUtterance !== cancelUtterance)
            return
          // Revoke ownership before native cancel: it can dispatch old events
          // synchronously. Never cancel after a UI callback starts a new turn.
          complete(false)
          if (token !== run) return
          try { window.speechSynthesis.cancel() }
          catch { /* A failed native cancel must not retain a preparing run. */ }
          // A native listener or any UI callback may synchronously replace us.
          if (token === run) callbacks.onPreparing(false)
          if (token === run) callbacks.onPlaying(false)
          if (token === run) callbacks.onMouth(0, 0, null)
          if (token === run)
            callbacks.onProblem('系统语音迟迟未确认开始，已停止等待本次朗读。请检查系统声线或更换语音模式。')
        }
        try {
          const clear = scheduleBrowserStartDeadline(startExpired, BROWSER_SPEECH_START_DEADLINE_MS)
          if (completed || started) clear()
          else clearStartDeadline = clear
          if (!completed) window.speechSynthesis.speak(utterance)
        }
        catch { utterance.onerror?.(new Event('error') as SpeechSynthesisErrorEvent) }
      })
      if (token !== run || !succeeded)
        return false
    }
    if (token === run)
      callbacks.onPreparing(false)
    return token === run
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
    const session = activeRun
    if (!session || session.token !== token || token !== run)
      return
    for await (const sentence of input) {
      if (token !== run) return
      let segments: ReturnType<SpeechModel['stream']> | null = null
      try {
        while (true) {
          if (!await waitForLocalCapacity(session)) return
          if (token !== run || session !== activeRun) return
          // Await yields even for an immediate permit. A pause in that gap
          // revokes it; retain this exact input instead of computing/skipping it.
          if (!hasLocalCapacity(session)) continue
          segments ??= model.stream(forChineseVoice(sentence.text), {
            voice, speed: deliverySpeed(sentence.delivery), maxChunkLength: 130,
          })
          const next = await segments.next()
          if (token !== run || session !== activeRun) return
          if (next.done) break
          yield {
            samples: new Float32Array(next.value.audio.data as Float32Array),
            sampleRate: next.value.audio.sampling_rate,
            delivery: sentence.delivery,
          }
        }
      }
      finally { await segments?.return(undefined) }
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
      settle(token, 'empty')
      return
    }
    callbacks.onPreparing(true)
    callbacks.onProblem('正在生成语音…')
    const resumed = resumeSentences(first.value, sentences)
    if (engine === 'browser') {
      settle(token, await browserSpeech(resumed, token) ? 'played' : 'failed')
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
      pcmParts: [],
      sampleRate: null,
      total: 0,
      synthesisFinished: false,
      synthesisSucceeded: false,
      playingChunk: false,
      chunkStarted: false,
      resumeCloudGeneration: null,
      resumeLocalGeneration: null,
      timeline: [],
      mouthTimeline: [],
      beatTimeline: [],
      lastBeatPeak: -Infinity,
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
        const duration = data.length / sampleRate
        // Check aggregate RIFF dimensions before accepting another part, not
        // later in an ended callback while installing the completed replay.
        createWavHeader(sampleRate, session.total + data.length)
        const frames = mouthFrames(data, sampleRate)
        const start = session.total / sampleRate
        const events = speechBeats(segment, frames, duration, session.lastBeatPeak - start)
        if (events?.length) session.lastBeatPeak = start + events.at(-1)!.peak
        const pcm = createPcm16Blob(data)
        session.sampleRate = sampleRate
        session.timeline.push({ time: start, delivery: segment.delivery })
        session.mouthTimeline.push({ time: start, duration, frames })
        session.beatTimeline.push({ time: start, duration, events })
        session.pcmParts.push(pcm)
        session.total += data.length
        // Construct explicitly: spreading segment would retain historical
        // Float32 PCM even though both playback paths need only encoded parts.
        session.queue.push({ pcm, sampleCount: data.length, sampleRate, delivery: segment.delivery,
          mouth: { time: 0, duration, frames }, beats: { time: 0, duration, events } })
        advance(session)
      }
      if (token !== run)
        return
      if (!session.total)
        throw new Error('Speech returned silent audio')
      session.synthesisFinished = true
      session.synthesisSucceeded = true
      callbacks.onState(state)
      advance(session)
    }
    catch (error) {
      if (token !== run)
        return
      session.synthesisSucceeded = false
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

  function skipWithoutFallback(engine: SpeechEngine, error: unknown) {
    console.warn('Speech synthesis failed; browser fallback is disabled', error)
    callbacks.onPreparing(false)
    callbacks.onProblem(engine === 'cloud' ? '云端语音失败，本句已跳过。' : '语音生成失败，本句已跳过。')
  }

  async function speak(text: string, delivery: Delivery = 'neutral', voice: VoiceId = DEFAULT_VOICE, cues: DeliveryCue[] = [], engine: SpeechEngine = 'local', options: SpeakOptions = {}) {
    cancel()
    const token = run
    const onEnded = options.onEnded
    if (onEnded)
      pendingEnd = { token, fire: outcome => queueMicrotask(() => onEnded(outcome)) }
    if (!text.trim()) {
      settle(token, 'empty')
      return
    }
    const input = replySentenceStream(text, delivery, cues)
    activeInput = input
    callbacks.onProblem('')
    try {
      await synthesizeInput(input, voice, token, engine)
    }
    catch (error) {
      if (token !== run)
        return
      if (!browserFallback) {
        skipWithoutFallback(engine, error)
        settle(token, 'failed')
        return
      }
      console.warn('Speech synthesis failed; using browser speech', error)
      const fallbackInput = replySentenceStream(text, delivery, cues)
      activeInput = fallbackInput
      settle(token, await browserSpeech(fallbackInput, token, fallbackProblem(engine, error)) ? 'played' : 'failed')
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
        if (!browserFallback) {
          skipWithoutFallback(engine, error)
          return
        }
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
    audio.removeEventListener('waiting', onWaiting)
    audio.removeEventListener('seeking', onSeeking)
    audio.removeEventListener('seeked', onSeeked)
  }
  function getCompletedAudioBlob(): Blob | null {
    return completedAudio?.token === run && completedAudio.source === objectUrl && audio.src === completedAudio.source
      ? completedAudio.blob : null
  }
  return { prepare, speak, beginStream, cancel, dispose, getCompletedAudioBlob }
}
