import type { CloudSpeechClip } from '../cloud-speech'
import type { Delivery } from '../delivery'
import type { SpeakOptions, SpeechRunOutcome } from '../speech'
import type { SpeechEngine } from '../speech-mode'
import type { ActCue, DeliveryCue, SpokenSentence } from '../speech-sentences'
import type { VoiceId } from '../voice'

import { decodeCloudSpeechResponse, SpeechApiError } from '../cloud-speech.ts'
import { DEFAULT_VOICE } from '../voice.ts'
import { normaliseEmotion, STAGE_PROTOCOL } from '../../shared/performance-cues.mjs'

// DOM-free stage logic, so Node tests can drive it with fakes. main.ts binds
// it to EventSource, fetch, the real speech controller and the page.
export type StageRole = 'obs' | 'preview'
export type StageConnection = 'connecting' | 'live' | 'standby' | 'preview' | 'offline'
export type AvatarStatus = 'loading' | 'ready' | 'failed'
export interface ObsStatus { active: boolean | null, visible: boolean | null, streaming: boolean | null }

export const STAGE_EVENT_TYPES = ['hello', 'standby', 'say', 'stop', 'mode', 'reload', 'activity'] as const
const RECONNECT_SECONDS = [1, 2, 4, 8, 16, 30]
const CAPTION_LINGER_MS = 1_200
// Progress chatter from the controller, not something the host must see.
const PROGRESS_MESSAGES = new Set(['', '正在生成语音…'])

export interface StageSpeech {
  speak: (text: string, delivery: Delivery, voice: VoiceId, cues: DeliveryCue[], engine: SpeechEngine, options: SpeakOptions) => Promise<void>
  cancel: () => void
}

export interface StageView {
  showCaption: (text: string) => void
  clearCaption: () => void
  setBrb: (on: boolean) => void
  reload: () => void
  setConnection: (state: StageConnection) => void
  // The brain is composing a reply: a thinking pose until speech takes over.
  setThinking?: (on: boolean) => void
}

export interface StageClientOptions {
  role: StageRole
  openEvents: (handlers: { onEvent: (type: string, data: unknown) => void, onDisconnect: () => void }) => { close: () => void }
  post: (path: string, body: unknown, signal?: AbortSignal) => Promise<Response>
  speech: StageSpeech
  view: StageView
  timers?: { setTimeout: (callback: () => void, ms: number) => unknown, clearTimeout: (handle: unknown) => void }
  decode?: (response: Response, signal: AbortSignal) => Promise<CloudSpeechClip>
}

export function resolveStageRole(requested: string | null, insideObs: boolean): StageRole {
  if (requested === 'obs' || requested === 'preview')
    return requested
  return insideObs ? 'obs' : 'preview'
}

export function isStageProblem(message: string): boolean {
  return !PROGRESS_MESSAGES.has(message)
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function createStageClient(options: StageClientOptions) {
  const timers = options.timers ?? {
    setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
    clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  }
  const decode = options.decode ?? ((response: Response, signal: AbortSignal) => decodeCloudSpeechResponse(response, { signal }))
  let leaseId: string | null = null
  let primary = false
  let speakingTurn: string | null = null
  let captionTurn: string | null = null
  let captionTimer: unknown = null
  let reconnectTimer: unknown = null
  let attempts = 0
  let source: { close: () => void } | null = null
  let stopped = false
  let avatar: AvatarStatus | null = null
  let obs: ObsStatus | null = null

  function report(body: Record<string, unknown>) {
    if (!primary || !leaseId)
      return
    void options.post('api/live/stage/report', { leaseId, ...body }).catch((error) => {
      console.warn('Stage report failed', error)
    })
  }

  function clearCaptionTimer() {
    if (captionTimer !== null)
      timers.clearTimeout(captionTimer)
    captionTimer = null
  }

  function clearCaption(turnId?: string) {
    if (turnId !== undefined && captionTurn !== turnId)
      return
    clearCaptionTimer()
    captionTurn = null
    options.view.clearCaption()
  }

  function lingerCaption(turnId: string, ms: number) {
    if (captionTurn !== turnId)
      return
    clearCaptionTimer()
    captionTimer = timers.setTimeout(() => clearCaption(turnId), ms)
  }

  function silence() {
    speakingTurn = null
    options.speech.cancel()
  }

  function onHello(data: Record<string, unknown>) {
    attempts = 0
    // A new lease never continues an earlier lease's turn.
    if (speakingTurn)
      silence()
    leaseId = typeof data.leaseId === 'string' ? data.leaseId : null
    primary = data.primary === true && leaseId !== null
    options.view.setBrb(data.mode === 'brb')
    options.view.setThinking?.(data.activity === 'thinking' && data.mode !== 'brb')
    options.view.setConnection(options.role === 'preview' ? 'preview' : primary ? 'live' : 'standby')
    if (primary) {
      report({ type: 'ready', protocol: STAGE_PROTOCOL })
      if (avatar) report({ type: 'avatar', status: avatar })
      if (obs) report({ type: 'obs', ...obs })
    }
  }

  function onSay(data: Record<string, unknown>) {
    const { turnId, text } = data
    if (typeof turnId !== 'string' || typeof text !== 'string')
      return
    const delivery: Delivery | null = normaliseEmotion(data.delivery)
    if (!delivery) {
      // A newer server's tone this page does not know: say so and end the
      // turn now, rather than leave the server waiting for its watchdog.
      report({ type: 'problem', message: `舞台不认识语气「${String(data.delivery).slice(0, 24)}」，本轮已跳过。请刷新舞台页。` })
      report({ type: 'ended', turnId, outcome: 'failed' })
      return
    }
    // Raw lists: the sentence planner validates both, exactly as the server's
    // allowance does, so the two plans match.
    const cues = Array.isArray(data.cues) ? data.cues as DeliveryCue[] : []
    const acts = Array.isArray(data.acts) ? data.acts as ActCue[] : []
    clearCaptionTimer()
    captionTurn = turnId
    options.view.setThinking?.(false)
    options.view.showCaption(text)
    if (!primary) {
      // Previews never hear an ended report; fade their caption on a budget.
      lingerCaption(turnId, Math.min(90_000, 4_000 + 300 * text.length))
      return
    }
    speakingTurn = turnId
    void options.speech.speak(text, delivery, DEFAULT_VOICE, cues, 'cloud', {
      acts,
      // Join same-tone sentences only when this server planned its clips
      // that way; it refuses any clip it did not plan.
      join: data.join === true,
      onEnded: (outcome: SpeechRunOutcome) => {
        if (speakingTurn === turnId)
          speakingTurn = null
        report({ type: 'ended', turnId, outcome })
        if (outcome === 'played' || outcome === 'partial')
          lingerCaption(turnId, CAPTION_LINGER_MS)
        else
          clearCaption(turnId)
      },
    })
  }

  function onEvent(type: string, data: unknown) {
    if (stopped || !record(data))
      return
    switch (type) {
      case 'hello':
        onHello(data)
        break
      case 'standby':
        leaseId = null
        primary = false
        silence()
        clearCaption()
        options.view.setConnection('standby')
        break
      case 'say':
        onSay(data)
        break
      case 'stop':
        if (typeof data.turnId !== 'string')
          return
        if (speakingTurn === data.turnId)
          silence()
        clearCaption(data.turnId)
        break
      case 'mode':
        if (data.mode === 'brb') {
          silence()
          clearCaption()
          options.view.setThinking?.(false)
        }
        options.view.setBrb(data.mode === 'brb')
        break
      case 'reload':
        options.view.reload()
        break
      case 'activity':
        options.view.setThinking?.(data.state === 'thinking')
        break
    }
  }

  function connect() {
    if (stopped)
      return
    options.view.setConnection('connecting')
    source = options.openEvents({ onEvent, onDisconnect })
  }

  function onDisconnect() {
    source?.close()
    source = null
    // Without the event stream this page holds no lease; never keep speaking.
    leaseId = null
    primary = false
    silence()
    clearCaption()
    // Never keep a pose from a lost stream; the next hello carries the
    // server's current activity.
    options.view.setThinking?.(false)
    options.view.setConnection('offline')
    if (stopped || reconnectTimer !== null)
      return
    const delay = RECONNECT_SECONDS[Math.min(attempts, RECONNECT_SECONDS.length - 1)] * 1_000
    attempts++
    reconnectTimer = timers.setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delay)
  }

  async function synthesizeCloud(sentence: SpokenSentence, signal: AbortSignal): Promise<CloudSpeechClip> {
    const turnId = speakingTurn
    if (!primary || !leaseId || !turnId)
      throw new SpeechApiError('unavailable')
    let response: Response
    try {
      // The server checks [delivery, act, text] against its own plan.
      response = await options.post('api/live/stage/speech', {
        leaseId, turnId, text: sentence.text, delivery: sentence.delivery,
        ...(sentence.act ? { act: sentence.act } : {}),
      }, signal)
    }
    catch (error) {
      if (signal.aborted)
        throw new DOMException('Speech request was cancelled', 'AbortError')
      throw error instanceof SpeechApiError ? error : new SpeechApiError('network')
    }
    // Lost lease or an unplanned sentence: the server refused to spend.
    if (response.status === 403 || response.status === 409) {
      void response.body?.cancel().catch(() => {})
      throw new SpeechApiError('unavailable', response.status)
    }
    return decode(response, signal)
  }

  return {
    start: connect,
    stop() {
      stopped = true
      if (reconnectTimer !== null)
        timers.clearTimeout(reconnectTimer)
      reconnectTimer = null
      source?.close()
      source = null
      silence()
      clearCaption()
      options.view.setThinking?.(false)
    },
    synthesizeCloud,
    reportProblem(message: string) {
      if (isStageProblem(message))
        report({ type: 'problem', message: message.slice(0, 120) })
    },
    reportAvatar(status: AvatarStatus) {
      avatar = status
      report({ type: 'avatar', status })
    },
    reportObs(status: ObsStatus) {
      obs = { ...status }
      report({ type: 'obs', ...obs })
    },
    get state() {
      return { leaseId, primary, speakingTurn, captionTurn }
    },
  }
}
