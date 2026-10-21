import type { Delivery } from './delivery'
import { ACTS, EMOTIONS, isAct, normaliseEmotion } from '../shared/performance-cues.mjs'
import type { Act, Emotion } from '../shared/performance-cues.mjs'
import { FALLBACK_AVATAR_PROFILE, faceOf, faceWeightsAt, follow, pulseEnvelope, waveAt } from './avatar-profile.ts'
import type { ActPulse, AvatarProfile, FaceTrack, Ops, ParamId, Wave } from './avatar-profile.ts'
import { createMotionDirector } from './avatar-motion.ts'
import type { MotionPort } from './avatar-motion.ts'

export type AvatarActivity = 'idle' | 'attentive' | 'thinking' | 'speaking'

interface ParameterModel {
  coreModel: {
    getParameterValueById: (id: string) => number
    setParameterValueById: (id: string, value: number, weight?: number) => void
    addParameterValueById: (id: string, value: number, weight?: number) => void
    // Present on a real Cubism core: the pitch clamp then follows the model.
    getParameterIndex?: (id: string) => number
    getParameterMinimumValue?: (index: number) => number
    getParameterMaximumValue?: (index: number) => number
  }
  on: (event: 'beforeModelUpdate', listener: () => void) => unknown
  off: (event: 'beforeModelUpdate', listener: () => void) => unknown
}

type Core = ParameterModel['coreModel']

export interface AvatarPerformanceOptions {
  now?: () => number
  reducedMotion?: () => boolean
  // Defaults to FALLBACK_AVATAR_PROFILE, today's Hiyori.
  profile?: AvatarProfile
  // Registers a listener that runs after breath and before physics each
  // frame, and returns its removal. Without it the pose is written after
  // physics, in beforeModelUpdate.
  prePhysics?: (listener: () => void) => () => void
  // Gestures need a motion port; without one, motion calls do nothing.
  motions?: MotionPort
  random?: () => number
}

export interface AvatarDebug {
  hold?: Delivery | null // wear this face regardless of setDelivery; null releases
  reducedMotion?: boolean | null // simulate; null follows the real setting
  ignoreGates?: boolean // gestures skip turn limit, gap, cooldown and chance
}

// Per parameter: every add, then every scale, then blends in slot order.
interface Layer {
  id: ParamId
  pre: boolean // written before physics
  motion: boolean // skipped under reduced motion
  add: [slot: number, value: number][]
  scale: [slot: number, factor: number][]
  blend: [slot: number, target: number, strength: number][]
}

interface WaveWrite { id: ParamId, wave: Wave, pre: boolean }

function compileLayers(sources: readonly (Ops | undefined)[], pre: ReadonlySet<ParamId>, motion: ReadonlySet<ParamId>): Layer[] {
  const layers = new Map<ParamId, Layer>()
  const layer = (id: ParamId) => {
    let entry = layers.get(id)
    if (!entry) layers.set(id, entry = { id, pre: pre.has(id), motion: motion.has(id), add: [], scale: [], blend: [] })
    return entry
  }
  sources.forEach((ops, slot) => {
    for (const [id, value] of Object.entries(ops?.add ?? {})) layer(id).add.push([slot, value])
    for (const [id, value] of Object.entries(ops?.scale ?? {})) layer(id).scale.push([slot, value])
    for (const [id, [target, strength]] of Object.entries(ops?.blend ?? {})) layer(id).blend.push([slot, target, strength])
  })
  return [...layers.values()]
}

// Weight-0 slots are skipped: the values match writing them, without
// touching parameters no active face uses.
function applyLayers(core: Core, layers: readonly Layer[], weights: ArrayLike<number>, select: (layer: Layer) => boolean) {
  for (const layer of layers) {
    if (!select(layer)) continue
    let sum = 0
    let adding = false
    for (const [slot, value] of layer.add) {
      if (!weights[slot]) continue
      sum += weights[slot] * value
      adding = true
    }
    if (adding) core.addParameterValueById(layer.id, sum)
    let factor = 1
    let scaling = false
    for (const [slot, value] of layer.scale) {
      if (!weights[slot]) continue
      factor *= 1 + (value - 1) * weights[slot]
      scaling = true
    }
    if (scaling) core.setParameterValueById(layer.id, core.getParameterValueById(layer.id) * factor)
    for (const [slot, target, strength] of layer.blend)
      if (weights[slot]) core.setParameterValueById(layer.id, target, strength * weights[slot])
  }
}

const waveWrites = (waves: Readonly<Record<ParamId, Wave>> | undefined, pre: ReadonlySet<ParamId>): WaveWrite[] =>
  Object.entries(waves ?? {}).map(([id, wave]) => ({ id, wave, pre: pre.has(id) }))

const ACTIVITY_WEIGHTS = ['attentive', 'thinking', 'speaking'] as const
// A second cue of the same act this soon is the same act (a replayed cue).
const ACT_RETRIGGER_MS = 700
// With no voice the envelope snaps to 0 here, so sway goes fully still.
const ENVELOPE_FLOOR = 0.01
const BLINK_FLOOR = 0.01

// Apply after Cubism's motion/physics pass, immediately before vertices update.
// A normal PIXI ticker callback runs too early: Idle overwrites its parameters.
// The pose pass (sway, drift, prePhysics ids) may run earlier, before physics.
export function attachAvatarPerformance(model: ParameterModel, options: AvatarPerformanceOptions = {}) {
  const profile = options.profile ?? FALLBACK_AVATAR_PROFILE
  const now = options.now ?? (() => performance.now())
  const roles = profile.parameters
  const motionIds = new Set(roles.motion)
  const preIds = new Set(roles.prePhysics)
  const formRange = profile.mouth.formRange
  const { easeInMs, relaxMs } = profile.timing
  const neutralFace = faceOf(profile, 'neutral')

  // A `like` face has no ops of its own; its slot never gets weight.
  const faceSources = EMOTIONS.map(emotion => profile.expressions[emotion]?.like ? undefined : profile.expressions[emotion])
  const faceLayers = compileLayers(faceSources, preIds, motionIds)
  const faceForms = faceSources.flatMap((source, slot) => source?.mouthForm ? [[slot, source.mouthForm] as const] : [])
  const activityAdds = [...new Set([...Object.keys(profile.activities.attentive.add), ...Object.keys(profile.activities.thinking.add)])]
    .map(id => ({ id, attentive: profile.activities.attentive.add[id], thinking: profile.activities.thinking.add[id] }))
  const actTable = new Map<Act, { pulse: ActPulse, layers: Layer[], waves: WaveWrite[] }>()
  for (const name of ACTS) {
    const pulse = profile.acts[name]
    if (pulse) actTable.set(name, { pulse, layers: compileLayers([pulse], preIds, motionIds), waves: waveWrites(pulse.oscillate, preIds) })
  }
  const speakingLayer = profile.speaking
  const sway = waveWrites(speakingLayer?.sway, preIds)
  const drift = waveWrites(speakingLayer?.drift, preIds)
  const blink = speakingLayer?.blink
  const eyeIds = roles.eyeOpen
  const pitchId = roles.headPitch

  let debugHold: Emotion | null = null
  let debugReduced: boolean | null = null
  const isReduced = () => debugReduced ?? options.reducedMotion?.() ?? false
  const director = options.motions
    ? createMotionDirector({ motions: profile.motions, port: options.motions, now, random: options.random ?? Math.random, reducedMotion: isReduced })
    : null

  let previousTime = now()
  let elapsed = 0
  let activity: AvatarActivity = 'idle'
  let requested: Emotion = 'neutral'
  let face = EMOTIONS.map(emotion => Number(emotion === neutralFace))
  let track: FaceTrack = { from: face, to: neutralFace, start: previousTime, duration: 0 }
  let mouthOpen: number | null = 0
  let mouthForm = 0
  let alignedBeat: number | null = null
  let beatAhead: number | null = null
  let previousAudioOpen = 0
  let emphasisStartedAt: number | null = null
  let emphasisStrength = 0
  let lastEmphasisAt = -Infinity
  // The blink guard's own onset detector: the pitch emphasis above is reset
  // under reduced motion, but the guard is not a head motion and keeps
  // working there (unaligned voices such as the local engine rely on it).
  let guardOnsetAt: number | null = null
  let guardOnsetStrength = 0
  let guardPreviousOpen = 0
  let guardLastOnsetAt = -Infinity
  let previouslyReduced = false
  let reactionStartedAt: number | null = null
  const reactionDuration = 650
  const weights = { attentive: 0, thinking: 0, speaking: 0 }
  let envelope = 0
  let level = 0
  let act: { name: Act, startedAt: number, pulse: ActPulse, layers: Layer[], waves: WaveWrite[] } | null = null
  let actEnvelope = 0
  const lastActAt = new Map<Act, number>()
  let blinkHolding = false
  let blinkHold = 0
  let pitchRange: readonly [number, number] | null = null
  const swayValues: Record<ParamId, number> = {}
  const driftValues: Record<ParamId, number> = {}
  // This frame, as stepped by applyPose.
  let posed = false
  let frameTime = previousTime
  let frameDeltaMs = 0
  let frameReduced = false
  let alignedMotionAllowed = false

  const pitchBounds = (core: Core) => {
    if (pitchRange) return pitchRange
    pitchRange = [-30, 30]
    if (core.getParameterIndex && core.getParameterMinimumValue && core.getParameterMaximumValue) {
      const index = core.getParameterIndex(pitchId)
      const minimum = core.getParameterMinimumValue(index)
      const maximum = core.getParameterMaximumValue(index)
      if (Number.isFinite(minimum) && Number.isFinite(maximum) && minimum < maximum) pitchRange = [minimum, maximum]
    }
    return pitchRange
  }

  // Closing is immediate on pause/cancel, even if an Idle motion opens its mouth.
  const mouthOpenNow = () => activity === 'speaking'
    ? mouthOpen ?? (0.2 + Math.abs(Math.sin(elapsed * 9.6)) * 0.5)
    : 0

  // Clock, activity weights, face track, emphasis, envelope, act pulse: once per frame.
  const step = () => {
    const time = now()
    const gap = time - previousTime
    const deltaMs = Math.max(0, Math.min(100, gap))
    previousTime = time
    elapsed += deltaMs / 1_000
    frameTime = time
    frameDeltaMs = deltaMs
    const blend = 1 - Math.exp(-deltaMs / 1_000 / 0.28)
    for (const key of ACTIVITY_WEIGHTS)
      weights[key] += (Number(activity === key) - weights[key]) * blend
    // Sample-and-hold: only the face asked for at this frame starts an ease.
    // A real release (speech has died down) relaxes slowly; a tone change
    // mid-reply, neutral included, eases in quickly.
    const target = faceOf(profile, debugHold ?? requested)
    if (target !== track.to)
      track = { from: face, to: target, start: time, duration: target === neutralFace && weights.speaking < 0.5 ? relaxMs : easeInMs }
    face = faceWeightsAt(track, time)

    const speaking = activity === 'speaking'
    const reducedMotion = isReduced()
    frameReduced = reducedMotion
    alignedMotionAllowed = !reducedMotion && !previouslyReduced && gap <= 250 && gap >= 0
    const audioOpen = speaking && mouthOpen !== null ? mouthOpen : null
    // Numeric mouth opening comes from the current audio envelope; browser
    // speech has no measured envelope. Do not invent prosodic beats for it.
    if (alignedBeat !== null || audioOpen === null || reducedMotion || previouslyReduced || gap > 250 || gap < 0) {
      emphasisStartedAt = null
      emphasisStrength = 0
      previousAudioOpen = audioOpen ?? 0
      lastEmphasisAt = -Infinity
    }
    else {
      const rise = audioOpen - previousAudioOpen
      previousAudioOpen = audioOpen
      if (audioOpen < 0.06)
        emphasisStartedAt = null
      if (audioOpen >= 0.1 && rise >= 0.06 && time - lastEmphasisAt >= 400) {
        emphasisStartedAt = lastEmphasisAt = time
        emphasisStrength = Math.min(1, (rise - 0.05) / 0.2) * Math.min(1, audioOpen / 0.35)
      }
    }
    previouslyReduced = reducedMotion
    if (alignedBeat !== null || audioOpen === null || gap > 250 || gap < 0) {
      guardOnsetAt = null
      guardPreviousOpen = audioOpen ?? 0
      guardLastOnsetAt = -Infinity
    }
    else {
      const rise = audioOpen - guardPreviousOpen
      guardPreviousOpen = audioOpen
      if (audioOpen < 0.06)
        guardOnsetAt = null
      if (audioOpen >= 0.1 && rise >= 0.06 && time - guardLastOnsetAt >= 400) {
        guardOnsetAt = guardLastOnsetAt = time
        guardOnsetStrength = Math.min(1, (rise - 0.05) / 0.2) * Math.min(1, audioOpen / 0.35)
      }
    }

    if (speakingLayer) {
      const input = audioOpen ?? 0
      envelope = follow(envelope, input, deltaMs, speakingLayer.envelope.attackMs, speakingLayer.envelope.releaseMs)
      if (input === 0 && envelope < ENVELOPE_FLOOR) envelope = 0
      level = Math.min(1, envelope / speakingLayer.envelope.fullAt)
    }
    if (act) {
      const age = time - act.startedAt
      actEnvelope = pulseEnvelope(age, act.pulse)
      if (age >= act.pulse.attackMs + act.pulse.holdMs + act.pulse.releaseMs) {
        act = null
        actEnvelope = 0
      }
    }
  }

  const writeWaves = (core: Core, pre: boolean) => {
    const ms = elapsed * 1_000
    for (const { id, wave, pre: early } of sway) {
      if (early !== pre) continue
      // Body sway follows the voice level; physics inputs move the hair too.
      const amount = level * waveAt(wave, ms)
      swayValues[id] = amount
      if (amount !== 0) core.addParameterValueById(id, amount)
    }
    for (const { id, wave, pre: early } of drift) {
      if (early !== pre) continue
      const amount = weights.speaking * waveAt(wave, ms)
      driftValues[id] = amount
      if (amount !== 0) core.addParameterValueById(id, amount)
    }
  }

  const oscillate = (core: Core, pre: boolean) => {
    if (!act?.waves.length) return
    const share = act.pulse.followVoice ?? 0
    const voice = 1 - share + share * Math.min(1, mouthOpenNow() / 0.5)
    const age = frameTime - act.startedAt
    for (const { id, wave, pre: early } of act.waves) {
      if (early !== pre) continue
      const amount = actEnvelope * voice * waveAt(wave, age)
      if (amount !== 0) core.addParameterValueById(id, amount)
    }
  }

  const applyPose = () => {
    step()
    posed = true
    const core = model.coreModel
    const early = (layer: Layer) => layer.pre && !(frameReduced && layer.motion)
    applyLayers(core, faceLayers, face, early)
    if (act) applyLayers(core, act.layers, [actEnvelope], early)
    if (frameReduced) {
      for (const key of Object.keys(swayValues)) swayValues[key] = 0
      for (const key of Object.keys(driftValues)) driftValues[key] = 0
      return
    }
    oscillate(core, true)
    writeWaves(core, true)
  }

  // Only raises the eyes, and only an eye that is open when a strong
  // syllable comes (or is about to): a motion's half-closed lids stay.
  const guardBlink = (core: Core) => {
    if (!blink || !eyeIds.length) return
    const aligned = alignedBeat !== null || beatAhead !== null
    const strong = activity === 'speaking' && (aligned
      ? Math.max(alignedBeat ?? 0, beatAhead ?? 0) >= blink.minBeat
      : guardOnsetAt !== null && frameTime - guardOnsetAt < 360 && guardOnsetStrength >= blink.minEmphasis)
    if (!strong) blinkHolding = false
    else if (!blinkHolding) blinkHolding = Math.min(...eyeIds.map(id => core.getParameterValueById(id))) >= blink.engageAbove
    blinkHold = follow(blinkHold, blinkHolding ? 1 : 0, frameDeltaMs, blink.attackMs, blink.releaseMs)
    if (!blinkHolding && blinkHold < BLINK_FLOOR) blinkHold = 0
    const floor = blink.open * blinkHold
    if (floor > 0) {
      for (const id of eyeIds)
        if (core.getParameterValueById(id) < floor) core.setParameterValueById(id, floor)
    }
  }

  const applyFace = () => {
    if (!posed) applyPose()
    posed = false
    const time = frameTime
    const core = model.coreModel
    const speaking = activity === 'speaking'
    const reducedMotion = frameReduced
    const audioOpen = speaking && mouthOpen !== null ? mouthOpen : null
    core.setParameterValueById(roles.mouthOpen, mouthOpenNow())
    guardBlink(core)
    let form = speaking ? mouthForm : 0
    for (const [slot, bias] of faceForms) form += face[slot] * bias
    if (act?.pulse.mouthForm) form += actEnvelope * act.pulse.mouthForm
    core.setParameterValueById(roles.mouthForm, Math.max(formRange[0], Math.min(formRange[1], form)))
    const late = (layer: Layer) => !layer.pre && !(reducedMotion && layer.motion)
    applyLayers(core, faceLayers, face, late)
    if (act) {
      applyLayers(core, act.layers, [actEnvelope], late)
      if (!reducedMotion) oscillate(core, false)
    }
    if (!reducedMotion) writeWaves(core, false)

    if (reactionStartedAt !== null && (reducedMotion || time - reactionStartedAt >= reactionDuration))
      reactionStartedAt = null
    if (!reducedMotion) {
      // Small offsets preserve the original blink, breathing and pointer tracking.
      for (const { id, attentive, thinking } of activityAdds) {
        let add = 0
        if (attentive !== undefined) add += weights.attentive * attentive
        if (thinking !== undefined) add += weights.thinking * thinking
        core.addParameterValueById(id, add)
      }
      const [minimum, maximum] = pitchBounds(core)
      if (speaking && alignedBeat !== null && audioOpen !== null && audioOpen >= 0.06 && alignedMotionAllowed) {
        const baseline = core.getParameterValueById(pitchId)
        const pitch = Math.max(minimum, Math.min(maximum, baseline - alignedBeat * 0.9))
        core.addParameterValueById(pitchId, pitch - baseline)
      }
      if (emphasisStartedAt !== null) {
        const age = time - emphasisStartedAt
        if (age >= 360) emphasisStartedAt = null
        else {
          const progress = age <= 80 ? age / 80 : 1 - (age - 80) / 280
          const smooth = progress * progress * (3 - 2 * progress)
          const baseline = core.getParameterValueById(pitchId)
          // A small pitch-only emphasis avoids coupling X/Z into hair physics.
          // Clamp relative to this frame's real Idle baseline, not a fake zero.
          const pitch = Math.max(minimum, Math.min(maximum, baseline - smooth * emphasisStrength * 0.9))
          core.addParameterValueById(pitchId, pitch - baseline)
        }
      }
      if (reactionStartedAt !== null) {
        const progress = Math.max(0, (time - reactionStartedAt) / reactionDuration)
        const reaction = Math.sin(Math.PI * progress) ** 2
        // Ease a little out of Hiyori's extreme Idle pitches before the nod.
        // Y is not a physics input in this model; X/Z and hair stay untouched.
        core.setParameterValueById(pitchId, 0, reaction * 0.18)
        core.addParameterValueById(pitchId, -reaction * 2.4)
      }
    }
  }

  model.on('beforeModelUpdate', applyFace)
  let removePrePhysics = options.prePhysics?.(applyPose) ?? null
  const usesPrePhysics = removePrePhysics !== null
  let destroyed = false

  return {
    acknowledge() { reactionStartedAt = isReduced() ? null : now() },
    // Also ends an act pulse: a new turn or a stop should not keep laughing.
    clearReaction() {
      reactionStartedAt = null
      act = null
      actEnvelope = 0
    },
    setActivity(value: AvatarActivity) {
      if (value !== 'speaking') {
        emphasisStartedAt = null
        emphasisStrength = previousAudioOpen = 0
        lastEmphasisAt = -Infinity
      }
      activity = value
      director?.setActivity(value)
    },
    // Untyped callers may still pass the old 'bright'; unknown is neutral.
    setDelivery(value: Delivery) { requested = normaliseEmotion(value) ?? 'neutral' },
    // beatAhead is the beat ~0.12 s later, so the blink guard can engage
    // before a strong syllable instead of at its peak.
    setMouth(open: number | null, form: number, beat: number | null = null, ahead: number | null = null) {
      alignedBeat = beat === null ? null : Number.isFinite(beat) ? Math.max(0, Math.min(1, beat)) : 0
      beatAhead = ahead === null ? null : Number.isFinite(ahead) ? Math.max(0, Math.min(1, ahead)) : 0
      mouthOpen = open === null ? null : Number.isFinite(open) ? Math.max(0, Math.min(1, open)) : 0
      mouthForm = Number.isFinite(form) ? Math.max(-0.32, Math.min(0.32, form)) : 0
      if (mouthOpen === null || mouthOpen < 0.06) {
        emphasisStartedAt = null
        previousAudioOpen = mouthOpen ?? 0
      }
    },
    // The act's face pulse plus its gesture, if the profile maps one.
    performAct(value: Act) {
      if (!isAct(value)) return
      const time = now()
      if (time - (lastActAt.get(value) ?? -Infinity) < ACT_RETRIGGER_MS) return
      lastActAt.set(value, time)
      const entry = actTable.get(value)
      if (entry) {
        act = { name: value, startedAt: time, ...entry }
        actEnvelope = 0
      }
      void director?.offerAct(value)
    },
    beginTurn() { director?.beginTurn() },
    // Offers the tone's gesture once per tone change: the lead and the
    // onDelivery that follows it are one offer; a tone that comes back later
    // in the reply is offered again (cooldowns and the per-turn cap apply).
    cueTone(value: Delivery) { void director?.offerTone(normaliseEmotion(value) ?? 'neutral') },
    tap(): Promise<boolean> { return director?.tap() ?? Promise.resolve(false) },
    playMotion(group: string, index?: number, mode: { force?: boolean } = {}): Promise<boolean> {
      return director?.play(group, index, mode) ?? Promise.resolve(false)
    },
    // For the Idle override while thinking or speaking; null lets the library pick.
    idleIndex(group: string, count: number): number | null { return director?.idleIndex(group, count) ?? null },
    inspect() {
      return {
        profile: { id: profile.id, name: profile.name },
        requested,
        target: track.to,
        hold: debugHold,
        weights: Object.fromEntries(EMOTIONS.map((emotion, slot) => [emotion, face[slot]])) as Record<Emotion, number>,
        activity,
        activityWeights: { ...weights },
        envelope: { value: envelope, level },
        sway: { ...swayValues },
        drift: { ...driftValues },
        blink: { holding: blinkHolding, hold: blinkHold },
        act: act ? { name: act.name, envelope: actEnvelope, ageMs: frameTime - act.startedAt } : null,
        reducedMotion: isReduced(),
        prePhysics: usesPrePhysics,
        motion: director && options.motions ? { ...director.inspect(), current: options.motions.current() } : null,
      }
    },
    setDebug(debug: AvatarDebug) {
      if (debug.hold !== undefined) debugHold = debug.hold === null ? null : normaliseEmotion(debug.hold) ?? 'neutral'
      if (debug.reducedMotion !== undefined) debugReduced = debug.reducedMotion
      if (debug.ignoreGates !== undefined) director?.setOverrides({ ignoreGates: debug.ignoreGates })
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      model.off('beforeModelUpdate', applyFace)
      removePrePhysics?.()
      removePrePhysics = null
    },
  }
}

export type AvatarPerformance = ReturnType<typeof attachAvatarPerformance>
