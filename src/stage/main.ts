import './stage.css'

import type { Delivery } from '../delivery'
import type { ObsStatus } from './stage-client'

import { createAvatarContext } from '../avatar-context'
import { loadAvatarModule } from '../avatar-startup'
import { createSpeechController } from '../speech'
import { createStageClient, resolveStageRole, STAGE_EVENT_TYPES } from './stage-client'

type Avatar = Awaited<ReturnType<Awaited<ReturnType<typeof loadAvatarModule>>['mountHiyori']>>

const AVATAR_RETRY_SECONDS = [2, 4, 8, 16, 32, 60]
const base = import.meta.env.BASE_URL
const params = new URLSearchParams(location.search)
const role = resolveStageRole(params.get('role'), 'obsstudio' in window)
const captionsEnabled = params.get('captions') !== '0'

const stageElement = document.querySelector<HTMLElement>('#avatar')!
const captionElement = document.querySelector<HTMLElement>('#caption')!
const brbElement = document.querySelector<HTMLElement>('#brb')!
const connectionElement = document.querySelector<HTMLElement>('#connection')!
const audio = document.querySelector<HTMLAudioElement>('#voice')!
document.body.dataset.role = role

let live2d: Avatar | null = null
let latestMouth: { opening: number | null, form: number, beat: number | null } = { opening: 0, form: 0, beat: null }
let speaking = false
let preparing = false
let composing = false
let spokenDelivery: Delivery = 'neutral'
const avatarContext = createAvatarContext({ onChange: delivery => live2d?.setDelivery(delivery) })

function syncAvatar() {
  live2d?.setActivity(speaking ? 'speaking' : preparing || composing ? 'thinking' : 'idle')
  avatarContext.sync({ speaking, waiting: preparing || composing, spokenDelivery })
  live2d?.setDelivery(avatarContext.current)
}

// Late-bound: the controller and the client each need the other.
let client: ReturnType<typeof createStageClient> | null = null
const speech = createSpeechController(audio, {
  onState: () => {},
  onPlaying: (playing) => { speaking = playing; syncAvatar() },
  onPreparing: (value) => { preparing = value; syncAvatar() },
  onDelivery: (delivery) => { spokenDelivery = delivery; syncAvatar() },
  onMouth: (opening, form, beat) => {
    latestMouth = { opening, form, beat }
    live2d?.setMouth(opening, form, beat)
  },
  onAudioReady: () => {},
  // Includes "autoplay blocked": the host sees it in the console.
  onProblem: message => client?.reportProblem(message),
}, {
  synthesizeCloud: (sentence, signal) => client!.synthesizeCloud(sentence, signal),
  // OBS's browser source may have no audible system voice; skip instead.
  browserFallback: false,
})

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
    speak: (text, delivery, voice, cues, engine, options) => speech.speak(text, delivery, voice, cues, engine, options),
    cancel: () => speech.cancel(),
  },
  view: {
    showCaption(text) {
      if (!captionsEnabled) return
      captionElement.textContent = text
      captionElement.hidden = false
    },
    clearCaption() {
      captionElement.textContent = ''
      captionElement.hidden = true
    },
    setBrb(on) { brbElement.hidden = !on },
    reload() { location.reload() },
    setThinking(on) {
      composing = on
      syncAvatar()
    },
    setConnection(state) {
      document.body.dataset.connection = state
      connectionElement.dataset.state = state
    },
  },
})

async function mountAvatar(attempt = 0) {
  client?.reportAvatar('loading')
  try {
    const { mountHiyori } = await loadAvatarModule()
    live2d = await mountHiyori(stageElement, { autoInteract: false, renderProfile: 'auto' })
    live2d.setMouth(latestMouth.opening, latestMouth.form, latestMouth.beat)
    syncAvatar()
    client?.reportAvatar('ready')
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

client.start()
void mountAvatar()
