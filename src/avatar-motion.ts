import type { Act, Emotion } from '../shared/performance-cues.mjs'
import type { AvatarMotions, MotionRef, Trigger } from './avatar-profile.ts'

// Which gesture plays when, decided without Cubism: live2d.ts adapts the
// model's motion manager to MotionPort, and tests use a fake one.

// pixi-live2d-display's MotionPriority, which cannot load outside a browser.
export const MOTION_PRIORITY = Object.freeze({ NONE: 0, IDLE: 1, NORMAL: 2, FORCE: 3 })

export interface MotionState { group: string, index: number, priority: number }

export interface MotionPort {
  // A non-Idle motion is playing or reserved.
  busy: () => boolean
  // NORMAL priority, or FORCE when force; resolves false when refused.
  play: (group: string, index: number, force: boolean) => Promise<boolean>
  // The motion failed to load.
  failed: (group: string, index: number) => boolean
  current: () => MotionState | null
  stop: () => void
  // Motions in a group; lets a ref or play() without an index round-robin it.
  count?: (group: string) => number
}

export type MotionDecisionCode =
  | 'unmapped' | 'reduced' | 'turn-limit' | 'gap' | 'cooldown' | 'busy' | 'chance' // gates, in order
  | 'failed' // every motion of the trigger failed to load
  | 'play' | 'refused' // requested; the library refused it (rolled back)
  | 'calm' // a weight-0 Idle stopped as she got busy

export interface MotionDecision {
  at: number
  trigger: string
  code: MotionDecisionCode
  group?: string
  index?: number
}

export interface MotionDirectorOptions {
  motions: AvatarMotions
  port: MotionPort
  now: () => number
  random: () => number
  reducedMotion: () => boolean
}

const DECISION_LOG = 16

/** Weighted Idle pick: never a weight-0, failed or active index; null when nothing is eligible. */
export function pickIdleIndex(options: {
  weights: readonly number[]
  count: number
  random: () => number
  failed?: (index: number) => boolean
  active?: (index: number) => boolean
}): number | null {
  const eligible: number[] = []
  let total = 0
  for (let index = 0; index < options.count; index++) {
    const weight = options.weights[index] ?? 0
    if (!(weight > 0) || options.failed?.(index) || options.active?.(index)) continue
    eligible.push(index)
    total += weight
  }
  if (!eligible.length) return null
  let remaining = options.random() * total
  for (const index of eligible) {
    remaining -= options.weights[index]
    if (remaining < 0) return index
  }
  return eligible[eligible.length - 1]
}

export function createMotionDirector(options: MotionDirectorOptions) {
  const { motions, port, now, random } = options
  let turn = 0
  let startsThisTurn = 0
  let lastTone: Emotion | null = null
  let lastStart = -Infinity
  let ignoreGates = false
  let busyActivity = false
  const cooldowns = new Map<string, number>()
  const cursors = new Map<string, number>()
  const decisions: MotionDecision[] = []

  const log = (trigger: string, code: MotionDecisionCode, ref?: { group: string, index: number }) => {
    decisions.push(ref ? { at: now(), trigger, code, group: ref.group, index: ref.index } : { at: now(), trigger, code })
    if (decisions.length > DECISION_LOG) decisions.shift()
  }

  // An index-less ref (an unresolved profile) stands for its whole group.
  // An index the model does not have is never requested: the library
  // reserves the slot before checking and would then stay busy for good.
  const inRange = (group: string, index: number) => port.count === undefined || index < port.count(group)
  const expand = (refs: readonly MotionRef[]) => refs.flatMap(ref => ref.index !== undefined
    ? (inRange(ref.group, ref.index) ? [{ group: ref.group, index: ref.index }] : [])
    : Array.from({ length: port.count ? port.count(ref.group) : 1 }, (_, index) => ({ group: ref.group, index })))

  // Round-robin per trigger, skipping motions that failed to load.
  const pick = (key: string, refs: readonly { group: string, index: number }[]) => {
    const start = cursors.get(key) ?? 0
    for (let step = 0; step < refs.length; step++) {
      const at = (start + step) % refs.length
      if (port.failed(refs[at].group, refs[at].index)) continue
      cursors.set(key, (at + 1) % refs.length)
      return refs[at]
    }
    return null
  }

  const request = (key: string, ref: { group: string, index: number }, force: boolean) => {
    log(key, 'play', ref)
    return port.play(ref.group, ref.index, force).catch(() => false).then(started => {
      if (!started) log(key, 'refused', ref)
      return started
    })
  }

  function offer(key: string, trigger: Trigger | undefined, rule: { policy: boolean } = { policy: true }): Promise<boolean> {
    const refs = trigger ? expand(trigger.motions) : []
    const time = now()
    const policy = rule.policy && !ignoreGates
    let code: MotionDecisionCode | null = null
    if (!refs.length) code = 'unmapped'
    else if (rule.policy && options.reducedMotion()) code = 'reduced'
    else if (policy && startsThisTurn >= motions.maxPerTurn) code = 'turn-limit'
    else if (policy && time - lastStart < motions.minGapMs) code = 'gap'
    else if (policy && time - (cooldowns.get(key) ?? -Infinity) < (trigger?.cooldownMs ?? 0)) code = 'cooldown'
    else if (port.busy()) code = 'busy'
    // Drawn last, so a seeded random sees the same sequence whatever the gates did.
    else if (policy && random() >= (trigger?.chance ?? 1)) code = 'chance'
    if (code) {
      log(key, code)
      return Promise.resolve(false)
    }
    const ref = pick(key, refs)
    if (!ref) {
      log(key, 'failed')
      return Promise.resolve(false)
    }
    if (!rule.policy) return request(key, ref, false)
    // Recorded at request time so a motion still loading cannot be requested
    // twice; rolled back if the library refuses it.
    const previousStart = lastStart
    const previousCooldown = cooldowns.get(key)
    const requestTurn = turn
    lastStart = time
    cooldowns.set(key, time)
    startsThisTurn++
    return request(key, ref, false).then(started => {
      if (!started) {
        if (lastStart === time) lastStart = previousStart
        if (cooldowns.get(key) === time) {
          if (previousCooldown === undefined) cooldowns.delete(key)
          else cooldowns.set(key, previousCooldown)
        }
        if (turn === requestTurn) startsThisTurn = Math.max(0, startsThisTurn - 1)
      }
      return started
    })
  }

  // Stop a weight-0 Idle (Hiyori's 8.6 s look-away) as she starts thinking
  // or speaking; the library requests the next Idle, through the picker.
  function calm() {
    const idle = motions.idle
    const current = port.current()
    if (!idle?.calmOnBusy || !current || current.group !== idle.group || current.priority > MOTION_PRIORITY.IDLE) return
    if ((idle.busyWeights[current.index] ?? 0) > 0 || port.busy()) return
    log('calm', 'calm', current)
    port.stop()
  }

  return {
    beginTurn() {
      turn++
      startsThisTurn = 0
      lastTone = null
      if (motions.turnStart) void offer('turnStart', motions.turnStart)
    },
    offerTone(emotion: Emotion): Promise<boolean> {
      if (emotion === lastTone) return Promise.resolve(false)
      lastTone = emotion
      return offer(`emotion:${emotion}`, motions.emotions?.[emotion])
    },
    offerAct(act: Act): Promise<boolean> {
      return offer(`act:${act}`, motions.acts?.[act])
    },
    // The chat page's click: no chance, cooldown, gap, turn limit or reduced
    // motion, as before profiles; it still never interrupts a gesture.
    tap(): Promise<boolean> {
      return offer('tap', motions.tap, { policy: false })
    },
    // A direct request (debug panel). Without force it is refused under
    // reduced motion or while busy; force plays at FORCE priority.
    play(group: string, index?: number, mode: { force?: boolean } = {}): Promise<boolean> {
      const key = `play:${group}`
      const valid = index === undefined || (Number.isInteger(index) && index >= 0 && inRange(group, index))
      const refs = !valid ? [] : index !== undefined
        ? [{ group, index }]
        : Array.from({ length: Math.max(0, port.count?.(group) ?? 1) }, (_, motion) => ({ group, index: motion }))
      const code: MotionDecisionCode | null = !refs.length ? 'unmapped'
        : mode.force ? null
          : options.reducedMotion() ? 'reduced'
            : port.busy() ? 'busy' : null
      if (code) {
        log(key, code)
        return Promise.resolve(false)
      }
      const ref = pick(key, refs)
      if (!ref) {
        log(key, 'failed')
        return Promise.resolve(false)
      }
      return request(key, ref, mode.force === true)
    },
    setActivity(activity: string) {
      const busy = activity === 'thinking' || activity === 'speaking'
      const entering = busy && !busyActivity
      busyActivity = busy
      if (entering) calm()
    },
    // The Idle index to start while she is thinking or speaking, or null to
    // let the library pick (other activities, other groups, nothing eligible).
    idleIndex(group: string, count: number): number | null {
      const idle = motions.idle
      if (!idle || group !== idle.group || !busyActivity) return null
      const current = port.current()
      return pickIdleIndex({
        weights: idle.busyWeights,
        count,
        random,
        failed: index => port.failed(group, index),
        active: index => current?.group === group && current.index === index,
      })
    },
    setOverrides(overrides: { ignoreGates?: boolean }) {
      if (overrides.ignoreGates !== undefined) ignoreGates = overrides.ignoreGates
    },
    inspect() {
      return {
        lastTone,
        startsThisTurn,
        lastStart: Number.isFinite(lastStart) ? lastStart : null,
        cooldowns: Object.fromEntries(cooldowns),
        decisions: decisions.map(decision => ({ ...decision })),
        ignoreGates,
        busyActivity,
      }
    },
  }
}

export type MotionDirector = ReturnType<typeof createMotionDirector>
