import './stage.css'

import type { CloudSpeechClip } from '../cloud-speech'
import type { Delivery } from '../delivery'
import type { VisemeWeights } from '../mouth'
import type { SpokenSentence } from '../speech-sentences'
import type { ObsStatus } from './stage-client'

import { createAvatarContext, SPOKEN_FACE_HOLD_MS } from '../avatar-context'
import { resolveStageFrameRate } from '../avatar-rendering'
import { loadAvatarModule } from '../avatar-startup'
import { createSpeechController } from '../speech'
import { DEFAULT_VOICE } from '../voice'
import { createStageClient, resolveStageRole, shouldShowPerformanceDebug, STAGE_EVENT_TYPES } from './stage-client'

type Avatar = Awaited<ReturnType<Awaited<ReturnType<typeof loadAvatarModule>>['mountHiyori']>>

const AVATAR_RETRY_SECONDS = [2, 4, 8, 16, 32, 60]
const base = import.meta.env.BASE_URL
const params = new URLSearchParams(location.search)
const role = resolveStageRole(params.get('role'), 'obsstudio' in window)
const captionsEnabled = params.get('captions') !== '0'
// Matches OBS's 1080p30 output by default; ?fps=60 for a 60 fps canvas.
const frameRate = resolveStageFrameRate(params.get('fps'))
document.body.dataset.fps = String(frameRate)

const stageElement = document.querySelector<HTMLElement>('#avatar')!
const captionElement = document.querySelector<HTMLElement>('#caption')!
const brbElement = document.querySelector<HTMLElement>('#brb')!
const connectionElement = document.querySelector<HTMLElement>('#connection')!
const audio = document.querySelector<HTMLAudioElement>('#voice')!
document.body.dataset.role = role

let live2d: Avatar | null = null
let latestMouth: { opening: number | null, form: number, beat: number | null, beatAhead: number | null, vowel: VisemeWeights | null } = { opening: 0, form: 0, beat: null, beatAhead: null, vowel: null }
let speaking = false
let preparing = false
let composing = false
let spokenDelivery: Delivery = 'neutral'
// The next tone, announced just before its audio: the face eases in early.
let leadDelivery: Delivery | null = null
// Set only by the DEV debug panel, which logs speech events on one clock.
let speechObserver: ((event: string, value: string | null) => void) | null = null
const faceDelivery = () => leadDelivery ?? avatarContext.current
const avatarContext = createAvatarContext({ onChange: () => live2d?.setDelivery(faceDelivery()), holdMs: SPOKEN_FACE_HOLD_MS })

function syncAvatar() {
  live2d?.setActivity(speaking ? 'speaking' : preparing || composing ? 'thinking' : 'idle')
  avatarContext.sync({ speaking, waiting: preparing || composing, spokenDelivery })
  live2d?.setDelivery(faceDelivery())
}

function showCaption(text: string) {
  if (!captionsEnabled) return
  captionElement.textContent = text
  captionElement.hidden = false
}

function clearCaption() {
  captionElement.textContent = ''
  captionElement.hidden = true
}

// Late-bound: the controller and the client each need the other.
let client: ReturnType<typeof createStageClient> | null = null
// Late-bound too, so the debug panel can swap in its offline mock voice.
let synthesize = (sentence: SpokenSentence, signal: AbortSignal): Promise<CloudSpeechClip> => client!.synthesizeCloud(sentence, signal)
const speech = createSpeechController(audio, {
  onState: () => {},
  onPlaying: (playing) => {
    speaking = playing
    syncAvatar()
    speechObserver?.(playing ? 'playing' : 'stopped', null)
  },
  onPreparing: (value) => { preparing = value; syncAvatar() },
  onDelivery: (delivery) => {
    spokenDelivery = delivery
    syncAvatar()
    live2d?.cueTone(delivery)
    speechObserver?.('delivery', delivery)
  },
  onLead: (delivery) => {
    leadDelivery = delivery
    if (delivery) live2d?.cueTone(delivery)
    live2d?.setDelivery(faceDelivery())
    speechObserver?.('lead', delivery)
  },
  onMouth: (opening, form, beat, beatAhead = null, vowel = null) => {
    // A stop passes three arguments: the defaults clear the vowel as well.
    latestMouth = { opening, form, beat, beatAhead, vowel }
    live2d?.setMouth(opening, form, beat, beatAhead, vowel)
  },
  onAudioReady: () => {},
  // Includes "autoplay blocked": the host sees it in the console.
  onProblem: (message) => {
    client?.reportProblem(message)
    speechObserver?.('problem', message)
  },
  // A laugh/sigh/pause is being performed: its face pulse and gesture. The
  // sound (or silence) is already in the audio.
  onAct: (act) => {
    live2d?.performAct(act)
    speechObserver?.('act', act)
  },
}, {
  synthesizeCloud: (sentence, signal) => synthesize(sentence, signal),
  // OBS's browser source may have no audible system voice; skip instead.
  browserFallback: false,
})

// Problems in the avatar profile reach the console as a stage problem. A
// report sent before this page is primary is dropped, so live re-sends it.
function reportProfileProblems() {
  const profile = live2d?.profile
  if (!profile?.problems.length) return
  const first = profile.problems[0].split(': ')[0]
  client?.reportProblem(`头像配置有 ${profile.problemCount} 处问题，已用默认值代替：${first}`)
}

client = createStageClient({
  role,
  openEvents(handlers) {
    const source = new EventSource(`${base}api/live/stage/events?role=${role}`)
    for (const type of STAGE_EVENT_TYPES) {
      source.addEventListener(type, (event) => {
        let data: unknown
        try { data = JSON.parse((event as MessageEvent<string>).data) }
        catch { return }
        handlers.onEvent(type, data)
      })
    }
    // Reconnect ourselves with backoff, so each connection gets a new hello.
    source.onerror = () => handlers.onDisconnect()
    return { close: () => source.close() }
  },
  post: (path, body, signal) => fetch(`${base}${path}`, {
    method: 'POST',
    mode: 'same-origin',
    credentials: 'same-origin',
    redirect: 'error',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-Airi-Live': '1' },
    body: JSON.stringify(body),
    signal,
  }),
  speech: {
    // Every primary say is a new reply: a fresh gesture budget and tone dedupe.
    speak: (text, delivery, voice, cues, engine, options) => {
      live2d?.beginTurn()
      return speech.speak(text, delivery, voice, cues, engine, options)
    },
    cancel: () => speech.cancel(),
  },
  view: {
    showCaption,
    clearCaption,
    setBrb(on) { brbElement.hidden = !on },
    reload() { location.reload() },
    setThinking(on) {
      composing = on
      syncAvatar()
    },
    setConnection(state) {
      document.body.dataset.connection = state
      connectionElement.dataset.state = state
      // After the hello's ready report, which the caller sends next.
      if (state === 'live') queueMicrotask(reportProfileProblems)
    },
  },
})

async function mountAvatar(attempt = 0) {
  client?.reportAvatar('loading')
  try {
    const { mountHiyori } = await loadAvatarModule()
    live2d = await mountHiyori(stageElement, { autoInteract: false, renderProfile: 'auto', fixedFPS: frameRate })
    live2d.setMouth(latestMouth.opening, latestMouth.form, latestMouth.beat, latestMouth.beatAhead, latestMouth.vowel)
    syncAvatar()
    document.body.dataset.avatarProfile = live2d.profile.id
    document.body.dataset.avatarProblems = String(live2d.profile.problemCount)
    // OBS's CEF may honour the host's Reduce Motion: the stream then loses
    // its head and body layers. Make that visible instead of silent.
    const reducedMotion = live2d.inspect().reducedMotion
    document.body.dataset.reducedMotion = String(reducedMotion)
    if (reducedMotion) console.info('Reduced motion is on: the avatar keeps its mouth and face but no head or body motion.')
    client?.reportAvatar('ready')
    reportProfileProblems()
  }
  catch (error) {
    console.error('Live2D load failed', error)
    client?.reportAvatar('failed')
    const delay = AVATAR_RETRY_SECONDS[Math.min(attempt, AVATAR_RETRY_SECONDS.length - 1)] * 1_000
    setTimeout(() => void mountAvatar(attempt + 1), delay)
  }
}

// OBS dispatches these on window inside its browser source (CEF).
if ('obsstudio' in window) {
  const obs: ObsStatus = { active: null, visible: null, streaming: null }
  const update = (patch: Partial<ObsStatus>) => {
    Object.assign(obs, patch)
    client?.reportObs(obs)
  }
  const detail = (event: Event) => (event as CustomEvent<Record<string, unknown>>).detail ?? {}
  window.addEventListener('obsSourceActiveChanged', event => update({ active: detail(event).active === true }))
  window.addEventListener('obsSourceVisibleChanged', event => update({ visible: detail(event).visible === true }))
  window.addEventListener('obsStreamingStarted', () => update({ streaming: true }))
  window.addEventListener('obsStreamingStopped', () => update({ streaming: false }))
}

// The performance panel exists only in dev builds (the production build drops
// this branch and its chunk) and only on a preview page outside OBS. It never
// connects: no event stream, lease, report or paid voice, and no reconnect
// loop cancelling its mock speech.
if (import.meta.env.DEV && shouldShowPerformanceDebug(params.get('debug'), role, 'obsstudio' in window)) {
  document.body.dataset.debug = 'performance'
  document.body.dataset.connection = 'debug'
  connectionElement.dataset.state = 'debug'
  void import('./performance-debug').then(panel => panel.mountPerformanceDebug({
    speakTurn(text, delivery, cues, acts, onEnded) {
      live2d?.beginTurn()
      showCaption(text)
      return speech.speak(text, delivery, DEFAULT_VOICE, cues, 'cloud', { acts, join: true, onEnded })
    },
    cancel() {
      speech.cancel()
      clearCaption()
    },
    avatar: () => live2d,
    setThinking(on) {
      composing = on
      syncAvatar()
    },
    useSynthesizer(next) { synthesize = next },
    observe(listener) { speechObserver = listener },
    clearCaption,
  })).catch(error => console.error('Performance debug panel failed to load', error))
}
else {
  client.start()
}
void mountAvatar()
