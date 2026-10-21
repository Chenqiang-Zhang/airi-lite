import './performance-debug.css'

import type { CloudSpeechClip } from '../cloud-speech'
import type { Delivery } from '../delivery'
import type { SpeechRunOutcome } from '../speech'
import type { ActCue, DeliveryCue, SpokenSentence } from '../speech-sentences'
import type { Act, Emotion } from '../../shared/performance-cues.mjs'

import { ACTS, EMOTIONS } from '../../shared/performance-cues.mjs'
import { createMockSynthesizer } from './mock-speech'

// The DEV-only ?debug=performance panel. main.ts loads this chunk only in a
// dev build, on a preview page outside OBS, and never connects that page to
// the server: every voice here is the offline mock, so nothing is spent.

type Avatar = Awaited<ReturnType<typeof import('../live2d')['mountHiyori']>>
type Synthesizer = (sentence: SpokenSentence, signal: AbortSignal) => Promise<CloudSpeechClip>

export interface PerformanceDebugHost {
  // beginTurn, caption, then the stream's own speak path (join, acts, leads).
  speakTurn: (text: string, delivery: Delivery, cues: DeliveryCue[], acts: ActCue[], onEnded?: (outcome: SpeechRunOutcome) => void) => Promise<void>
  cancel: () => void
  avatar: () => Avatar | null
  setThinking: (on: boolean) => void
  useSynthesizer: (synthesize: Synthesizer) => void
  // Speech callbacks as they happen: lead, playing, stopped, delivery, act, problem.
  observe: (listener: (event: string, value: string | null) => void) => void
  clearCaption: () => void
}

type TourName = 'faces' | 'acts' | 'motions'
type Background = 'transparent' | 'dark' | 'green' | 'checker'

const LINES: Record<Emotion, string> = {
  neutral: '好的，我们来看下一个问题。',
  happy: '太好了，我超开心的！',
  soft: '没关系，慢慢来就好。',
  curious: '咦，这是怎么做到的？',
  surprised: '哇，真的假的？！',
  sad: '唉，有点可惜呢。',
  pout: '哼，才不要告诉你呢。',
  shy: '诶嘿，被你夸得有点不好意思。',
}
const ACT_LINES: Record<Act, { delivery: Emotion, text: string }> = {
  laugh: { delivery: 'happy', text: '哈哈，这也太好笑了吧！' },
  sigh: { delivery: 'sad', text: '唉，今天又没抽到。' },
  pause: { delivery: 'curious', text: '嗯，让我想想看。' },
}
// Leads at every boundary, a laugh on clip 2, and three tone gestures
// against the two-per-turn cap.
const SEQUENCE: readonly Emotion[] = ['happy', 'curious', 'sad', 'shy']
const DECISION_REASONS: Record<string, string> = {
  'unmapped': 'nothing mapped',
  'reduced': 'reduced motion',
  'turn-limit': 'per-turn cap',
  'gap': 'min gap',
  'cooldown': 'cooldown',
  'busy': 'gesture playing',
  'chance': 'chance roll',
  'failed': 'load failed',
  'play': 'requested',
  'refused': 'library refused',
  'calm': 'calmed Idle',
}
const FACE_STEP_MS = 2_500
const SETTLE_MS = 1_000
const MOTION_STEP_MS = 3_000
const CAPTION_LINGER_MS = 1_200
const EVENT_LOG = 40

interface LoggedEvent { at: number, type: string, detail: string }

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  Object.assign(element, props)
  element.append(...children)
  return element
}

const short = (id: string) => id.replace(/^Param/, '')
const fixed = (value: number | null | undefined, digits = 2) => value === null || value === undefined || !Number.isFinite(value) ? '–' : value.toFixed(digits)

export function mountPerformanceDebug(host: PerformanceDebugHost) {
  const body = document.body
  const options = { aligned: true, latencyMs: 0, ignoreGates: false, reducedMotion: false, background: 'transparent' as Background }
  let lead: Delivery | null = null
  let leadAt: number | null = null
  let clock = performance.now() // events are shown relative to the last turn
  let turn = 0
  let tourToken = 0
  let activeTour: TourName | null = null
  let appliedTo: Avatar | null = null
  let blinkHolding = false
  let decisionKeys = new Set<string>()
  const events: LoggedEvent[] = []

  const log = (type: string, detail = '', at = performance.now()) => {
    events.push({ at, type, detail })
    if (events.length > EVENT_LOG) events.shift()
  }

  const applySynthesizer = () => host.useSynthesizer(createMockSynthesizer({ latencyMs: options.latencyMs, aligned: options.aligned }))
  applySynthesizer()
  body.dataset.debugBackground = options.background

  host.observe((event, value) => {
    const at = performance.now()
    if (event === 'lead') {
      lead = value as Delivery | null
      if (value) leadAt = at
      log('lead', value ?? 'none', at)
      return
    }
    if (event === 'playing' || event === 'delivery') {
      // How early the face started easing toward this tone.
      const ahead = leadAt !== null && (event === 'playing' || value === lead || lead === null) ? ` · lead +${Math.round(at - leadAt)} ms` : ''
      log(event, `${value ?? ''}${ahead}`, at)
      if (event === 'delivery') leadAt = null
      return
    }
    // '' clears a problem; only real ones (autoplay blocked, a failed clip) are news.
    if (event === 'problem' && !value) return
    log(event, value ?? '', at)
  })

  // --- actions -------------------------------------------------------------

  function say(delivery: Delivery = 'neutral', text = LINES[delivery] ?? LINES.neutral, extra: { act?: Act, cues?: DeliveryCue[] } = {}): Promise<SpeechRunOutcome> {
    const id = ++turn
    clock = performance.now()
    leadAt = null
    log('say', `${delivery}${extra.act ? ` + ${extra.act}` : ''}`, clock)
    return new Promise((resolve) => {
      void host.speakTurn(text, delivery, extra.cues ?? [], extra.act ? [{ start: 0, act: extra.act }] : [], (outcome) => {
        log('ended', outcome)
        if (outcome === 'played' || outcome === 'partial')
          setTimeout(() => { if (turn === id) host.clearCaption() }, CAPTION_LINGER_MS)
        else if (turn === id)
          host.clearCaption()
        resolve(outcome)
      })
    })
  }

  function sequence() {
    let text = ''
    const cues: DeliveryCue[] = []
    let laughAt = 0
    SEQUENCE.forEach((delivery, index) => {
      if (index > 0) cues.push({ start: text.length, delivery })
      if (index === 1) laughAt = text.length
      text += LINES[delivery]
    })
    const id = ++turn
    clock = performance.now()
    leadAt = null
    log('say', `sequence ${SEQUENCE.join(' → ')}`, clock)
    void host.speakTurn(text, SEQUENCE[0], cues, [{ start: laughAt, act: 'laugh' }], (outcome) => {
      log('ended', outcome)
      setTimeout(() => { if (turn === id) host.clearCaption() }, CAPTION_LINGER_MS)
    })
  }

  function act(name: Act, mode: { speak?: boolean } = {}) {
    if (mode.speak) return say(ACT_LINES[name].delivery, ACT_LINES[name].text, { act: name })
    clock = performance.now()
    log('act', `${name} (no audio)`, clock)
    host.avatar()?.performAct(name)
    return Promise.resolve(null)
  }

  function hold(delivery: Delivery | null) {
    host.avatar()?.setDebug({ hold: delivery })
    log('hold', delivery ?? 'released')
  }

  function motion(group?: string, index?: number) {
    const avatar = host.avatar()
    if (!avatar) return Promise.resolve(false)
    if (group === undefined) {
      avatar.stopMotions()
      log('motion', 'stop')
      return Promise.resolve(true)
    }
    clock = performance.now()
    log('motion', `force ${group}[${index ?? 'next'}]`, clock)
    return avatar.playMotion(group, index, { force: true })
  }

  function cancel() {
    tourToken++
    activeTour = null
    clearStep()
    host.cancel()
    log('cancel')
  }

  // --- tours: one step per face/act/motion, marked for scripted screenshots

  const wait = (ms: number, token: number) => new Promise<boolean>(resolve => setTimeout(() => resolve(token === tourToken), ms))
  function setStep(step: string, phase: string) {
    body.dataset.debugStep = step
    body.dataset.debugPhase = phase
  }
  function clearStep() {
    delete body.dataset.debugStep
    delete body.dataset.debugPhase
  }

  async function tour(name: TourName): Promise<boolean> {
    const token = ++tourToken
    const avatar = host.avatar()
    if (!avatar) return false
    activeTour = name
    clock = performance.now()
    log('tour', name, clock)
    let completed = true
    if (name === 'faces') {
      for (const emotion of EMOTIONS) {
        avatar.setDebug({ hold: emotion })
        setStep(`face:${emotion}`, 'easing')
        if (!await wait(SETTLE_MS, token)) { completed = false; break }
        setStep(`face:${emotion}`, 'settled')
        if (!await wait(FACE_STEP_MS - SETTLE_MS, token)) { completed = false; break }
      }
      // Unless a newer faces tour now owns the hold.
      if (token === tourToken || activeTour !== 'faces') avatar.setDebug({ hold: null })
    }
    else if (name === 'acts') {
      for (const actName of ACTS) {
        avatar.performAct(actName)
        setStep(`act:${actName}`, 'rising')
        // Settled once the pulse reaches its hold, or after a second.
        const started = performance.now()
        while (performance.now() - started < SETTLE_MS) {
          if ((avatar.inspect().act?.envelope ?? 0) >= 0.99) break
          if (!await wait(16, token)) break
        }
        if (token !== tourToken) { completed = false; break }
        setStep(`act:${actName}`, 'settled')
        if (!await wait(Math.max(0, FACE_STEP_MS - (performance.now() - started)), token)) { completed = false; break }
      }
    }
    else {
      for (const [group, count] of Object.entries(avatar.motionGroups())) {
        for (let index = 0; index < count && completed; index++) {
          void avatar.playMotion(group, index, { force: true })
          setStep(`motion:${group}:${index}`, 'playing')
          if (!await wait(SETTLE_MS, token)) { completed = false; break }
          setStep(`motion:${group}:${index}`, 'settled')
          if (!await wait(MOTION_STEP_MS - SETTLE_MS, token)) completed = false
        }
        if (!completed) break
      }
      if (completed) avatar.stopMotions()
    }
    if (token === tourToken) {
      activeTour = null
      clearStep()
    }
    log('tour', `${name} ${completed ? 'done' : 'stopped'}`)
    return completed
  }

  function snapshot() {
    const avatar = host.avatar()
    return {
      at: performance.now(),
      options: { ...options },
      lead,
      step: body.dataset.debugStep ?? null,
      phase: body.dataset.debugPhase ?? null,
      inspect: avatar?.inspect() ?? null,
      parameters: avatar?.parameters() ?? [],
      events: events.map(event => ({ ...event, ms: Math.round(event.at - clock) })),
    }
  }

  // --- panel -----------------------------------------------------------------

  const button = (label: string, onclick: () => unknown, title = '') =>
    h('button', { type: 'button', textContent: label, title, onclick: () => void onclick() })
  const row = (title: string, ...children: Node[]) =>
    h('section', { className: 'pd-row' }, h('h3', { textContent: title }), h('div', { className: 'pd-buttons' }, ...children))

  const motionButtons = h('div', { className: 'pd-buttons' }, h('span', { className: 'pd-muted', textContent: 'waiting for the model…' }))
  const select = <T extends string>(label: string, values: readonly T[], current: T, change: (value: T) => void) => {
    const element = h('select', {}, ...values.map(value => h('option', { value, textContent: value, selected: value === current })))
    element.onchange = () => change(element.value as T)
    return h('label', {}, `${label} `, element)
  }
  const checkbox = (label: string, change: (on: boolean) => void) => {
    const element = h('input', { type: 'checkbox' })
    element.onchange = () => change(element.checked)
    return h('label', {}, element, ` ${label}`)
  }

  const readout = {
    profile: h('div', { className: 'pd-block' }),
    face: h('div', { className: 'pd-block' }),
    body: h('div', { className: 'pd-block' }),
    motion: h('div', { className: 'pd-block' }),
    decisions: h('div', { className: 'pd-list' }),
    parameters: h('table', { className: 'pd-table' }),
    events: h('div', { className: 'pd-list' }),
  }

  const panel = h('aside', { id: 'performance-debug' },
    h('header', {}, h('strong', { textContent: 'Performance debug' }), h('span', { className: 'pd-muted', textContent: ' · H hides · Esc cancels · mock voice' })),
    row('Speak', ...EMOTIONS.map(emotion => button(emotion, () => say(emotion), LINES[emotion]))),
    row('Acts', ...ACTS.map(name => button(name, () => act(name, { speak: true }), `${ACT_LINES[name].delivery}: ${ACT_LINES[name].text}`))),
    row('Sequence', button(SEQUENCE.join(' → '), sequence, 'laugh on clip 2; leads, gesture gates, the per-turn cap')),
    row('Face hold', ...EMOTIONS.map(emotion => button(emotion, () => hold(emotion))), button('release', () => hold(null))),
    row('Act only', ...ACTS.map(name => button(name, () => act(name)))),
    h('section', { className: 'pd-row' }, h('h3', { textContent: 'Motions (force)' }), motionButtons),
    row('Activity',
      button('idle', () => { host.setThinking(false); log('activity', 'idle') }),
      button('thinking', () => { host.setThinking(true); log('activity', 'thinking') })),
    row('Options',
      select('beats', ['aligned', 'unaligned'] as const, 'aligned', (value) => { options.aligned = value === 'aligned'; applySynthesizer() }),
      select('latency', ['0', '400', '1500'] as const, '0', (value) => { options.latencyMs = Number(value); applySynthesizer() }),
      checkbox('ignore gates', (on) => { options.ignoreGates = on; host.avatar()?.setDebug({ ignoreGates: on }) }),
      checkbox('reduced motion', (on) => { options.reducedMotion = on; host.avatar()?.setDebug({ reducedMotion: on ? true : null }) }),
      select('background', ['transparent', 'dark', 'green', 'checker'] as const, options.background, (value) => {
        options.background = value
        body.dataset.debugBackground = value
      })),
    row('Tours', ...(['faces', 'acts', 'motions'] as const).map(name => button(name, () => tour(name))), button('stop', cancel)),
    h('section', { className: 'pd-row' }, h('h3', { textContent: 'Profile' }), readout.profile),
    h('section', { className: 'pd-row' }, h('h3', { textContent: 'Face' }), readout.face),
    h('section', { className: 'pd-row' }, h('h3', { textContent: 'Voice, sway, blink, act' }), readout.body),
    h('section', { className: 'pd-row' }, h('h3', { textContent: 'Motion' }), readout.motion, readout.decisions),
    h('section', { className: 'pd-row' }, h('h3', { textContent: 'Events (ms since the last turn)' }), readout.events),
    h('section', { className: 'pd-row' }, h('h3', { textContent: 'Parameters (rendered)' }), readout.parameters),
  )
  body.append(panel)

  const lines = (target: HTMLElement, items: readonly string[]) => target.replaceChildren(...items.map(text => h('div', { textContent: text })))

  // Per frame: catch gesture decisions and guard changes on the event clock.
  function poll() {
    const avatar = host.avatar()
    if (avatar) {
      const state = avatar.inspect()
      if (state.blink.holding !== blinkHolding) {
        blinkHolding = state.blink.holding
        log('guard', blinkHolding ? 'engaged' : 'released')
      }
      const keys = new Set<string>()
      for (const decision of state.motion?.decisions ?? []) {
        const key = `${decision.at}|${decision.trigger}|${decision.code}|${decision.group}|${decision.index}`
        keys.add(key)
        if (!decisionKeys.has(key))
          log('gesture', `${decision.trigger} → ${decision.code}${decision.group ? ` ${decision.group}[${decision.index}]` : ''}`, decision.at)
      }
      decisionKeys = keys
    }
    requestAnimationFrame(poll)
  }

  function applyAvatarOptions(avatar: Avatar) {
    appliedTo = avatar
    avatar.setDebug({ ignoreGates: options.ignoreGates, reducedMotion: options.reducedMotion ? true : null })
    const groups = Object.entries(avatar.motionGroups())
    motionButtons.replaceChildren(
      ...groups.flatMap(([group, count]) => Array.from({ length: count }, (_, index) => button(`${group} ${index}`, () => motion(group, index)))),
      button('stop', () => motion()),
    )
  }

  function render() {
    const avatar = host.avatar()
    if (!avatar) {
      lines(readout.profile, ['model loading…'])
      return
    }
    if (avatar !== appliedTo) applyAvatarOptions(avatar)
    const state = avatar.inspect()
    const profile = avatar.profile
    lines(readout.profile, [`${profile.id} · ${profile.name}`, `${profile.problemCount} problem(s)${state.prePhysics ? ' · pose before physics' : ' · pose after physics'}`, ...profile.problems.map(problem => `· ${problem}`)])

    readout.face.replaceChildren(
      h('div', { textContent: `requested ${state.requested} · target ${state.target} · lead ${lead ?? '–'}${state.hold ? ` · hold ${state.hold}` : ''}` }),
      ...EMOTIONS.map((emotion) => {
        const fill = h('i')
        fill.style.width = `${Math.round(state.weights[emotion] * 100)}%`
        return h('div', { className: 'pd-bar' }, h('span', { textContent: emotion }), h('span', { className: 'pd-track' }, fill), h('b', { textContent: fixed(state.weights[emotion]) }))
      }),
    )

    const waves = (values: Record<string, number>) => Object.entries(values).map(([id, value]) => `${short(id)} ${fixed(value)}`).join(' · ') || '–'
    const weights = state.activityWeights
    lines(readout.body, [
      `activity ${state.activity} · att ${fixed(weights.attentive)} · think ${fixed(weights.thinking)} · speak ${fixed(weights.speaking)}`,
      `envelope ${fixed(state.envelope.value)} · level ${fixed(state.envelope.level)}${state.reducedMotion ? ' · REDUCED MOTION' : ''}`,
      `sway ${waves(state.sway)}`,
      `drift ${waves(state.drift)}`,
      `blink guard ${state.blink.holding ? 'holding' : 'off'} · hold ${fixed(state.blink.hold)}`,
      state.act ? `act ${state.act.name} · envelope ${fixed(state.act.envelope)} · ${Math.round(state.act.ageMs)} ms` : 'act –',
    ])

    const director = state.motion
    const current = director?.current
    lines(readout.motion, director
      ? [
          `current ${current ? `${current.group}[${current.index}] p${current.priority}` : '–'} · busy-activity ${director.busyActivity ? 'yes' : 'no'}`,
          `turn starts ${director.startsThisTurn} · last tone ${director.lastTone ?? '–'}${director.ignoreGates ? ' · gates ignored' : ''}`,
        ]
      : ['no motion port'])
    lines(readout.decisions, (director?.decisions ?? []).slice().reverse().map(decision =>
      `${Math.round(decision.at - clock)} ${decision.trigger} → ${decision.code} (${DECISION_REASONS[decision.code] ?? decision.code})${decision.group ? ` ${decision.group}[${decision.index}]` : ''}`))

    lines(readout.events, events.slice().reverse().map(event => `${Math.round(event.at - clock)} ${event.type} ${event.detail}`))

    readout.parameters.replaceChildren(...avatar.parameters().map(parameter => h('tr', {},
      h('td', { textContent: short(parameter.id) }),
      h('td', { textContent: `${fixed(parameter.min, 1)}..${fixed(parameter.max, 1)}` }),
      h('td', { textContent: fixed(parameter.value) }))))
  }

  window.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.target instanceof HTMLSelectElement) return
    if (event.key === 'h' || event.key === 'H') {
      body.dataset.debugPanel = body.dataset.debugPanel === 'hidden' ? 'shown' : 'hidden'
    }
    else if (event.key === 'Escape') {
      cancel()
    }
  })

  setInterval(render, 200)
  render()
  requestAnimationFrame(poll)

  // For scripted screenshots; exists only on this debug page.
  Object.assign(window, { airiPerformanceDebug: { say, act, hold, motion, tour, snapshot, sequence, cancel } })
}
