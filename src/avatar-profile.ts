import { ACTS, EMOTIONS } from '../shared/performance-cues.mjs'
import type { Act, Emotion } from '../shared/performance-cues.mjs'

// One JSON file describes how a model performs: faces per tone, act pulses,
// motion triggers, speaking sway/drift/blink guard, parameter roles and
// framing. This module is pure (no DOM, no Cubism) so Node tests can check
// every profile in src/avatar-profiles/ and the engine that plays them.

export type ParamId = string

export interface Wave {
  readonly amplitude: number
  readonly periodMs: number
  readonly phase?: number // radians
}

export interface Ops {
  readonly add?: Readonly<Record<ParamId, number>>
  readonly scale?: Readonly<Record<ParamId, number>>
  readonly blend?: Readonly<Record<ParamId, readonly [target: number, strength: number]>>
}

export interface AddOnly { readonly add: Readonly<Record<ParamId, number>> }

export interface Expression extends Ops {
  readonly mouthForm?: number
  // Wear another emotion's face: no chains, not itself, no own ops.
  readonly like?: Emotion
}

export interface ActPulse extends Ops {
  readonly mouthForm?: number
  readonly attackMs: number
  readonly holdMs: number
  readonly releaseMs: number
  readonly oscillate?: Readonly<Record<ParamId, Wave>>
  readonly followVoice?: number
}

// index is filled in by resolveAvatarProfile: a ref without one means
// every motion of the group.
export interface MotionRef { readonly group: string, readonly index?: number }

export interface Trigger {
  readonly motions: readonly MotionRef[]
  readonly chance?: number
  readonly cooldownMs?: number
}

export interface IdleMotions {
  readonly group: string
  readonly busyWeights: readonly number[]
  readonly calmOnBusy: boolean
}

export interface AvatarMotions {
  readonly minGapMs: number
  readonly maxPerTurn: number
  readonly tap?: Trigger
  readonly turnStart?: Trigger
  readonly emotions?: Readonly<Partial<Record<Emotion, Trigger>>>
  readonly acts?: Readonly<Partial<Record<Act, Trigger>>>
  readonly idle?: IdleMotions
}

export interface BlinkGuard {
  readonly open: number
  readonly minBeat: number
  readonly minEmphasis: number
  readonly engageAbove: number
  readonly attackMs: number
  readonly releaseMs: number
}

export interface AvatarSpeaking {
  readonly envelope: { readonly attackMs: number, readonly releaseMs: number, readonly fullAt: number }
  readonly sway?: Readonly<Record<ParamId, Wave>>
  readonly drift?: Readonly<Record<ParamId, Wave>>
  readonly blink?: BlinkGuard
}

export interface AvatarLayout {
  readonly fitWidth: number
  readonly fitHeight: number
  readonly anchorY: number
  readonly portraitFitHeight: number
  readonly portraitAnchorY: number
}

export interface AvatarParameters {
  readonly mouthOpen: ParamId
  readonly mouthForm: ParamId
  readonly eyeOpen: readonly ParamId[]
  readonly headPitch: ParamId
  // Head/body/gaze ids, skipped in every layer under reduced motion.
  readonly motion: readonly ParamId[]
  // Written before physics when the host has the hook (a subset of motion).
  readonly prePhysics: readonly ParamId[]
}

export interface AvatarProfile {
  readonly version: 1
  readonly id: string
  readonly name: string
  readonly model: string
  readonly layout: AvatarLayout
  readonly parameters: AvatarParameters
  readonly mouth: { readonly formRange: readonly [number, number] }
  readonly timing: { readonly easeInMs: number, readonly relaxMs: number }
  readonly expressions: Readonly<Record<Emotion, Expression>>
  readonly activities: { readonly attentive: AddOnly, readonly thinking: AddOnly }
  readonly acts: Readonly<Partial<Record<Act, ActPulse>>>
  readonly motions: AvatarMotions
  readonly speaking?: AvatarSpeaking
}

export interface ProfileResult { profile: AvatarProfile, problems: string[] }

export const MAX_PROFILE_PROBLEMS = 20

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

// Today's Hiyori, exactly: four faces (the newer tones borrow the closest),
// no acts, no speaking layer, and only the chat page's click Tap.
export const FALLBACK_AVATAR_PROFILE: AvatarProfile = deepFreeze({
  version: 1,
  id: 'hiyori',
  name: 'Hiyori Momose (built-in)',
  model: 'models/hiyori/hiyori_free_t08.model3.json',
  layout: { fitWidth: 0.9, fitHeight: 0.94, anchorY: 1.04, portraitFitHeight: 1.8, portraitAnchorY: 1.66 },
  parameters: {
    mouthOpen: 'ParamMouthOpenY',
    mouthForm: 'ParamMouthForm',
    eyeOpen: ['ParamEyeLOpen', 'ParamEyeROpen'],
    headPitch: 'ParamAngleY',
    motion: ['ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ', 'ParamEyeBallX', 'ParamEyeBallY', 'ParamBreath'],
    prePhysics: [],
  },
  mouth: { formRange: [-0.6, 0.6] },
  timing: { easeInMs: 300, relaxMs: 1000 },
  expressions: {
    neutral: {},
    happy: { mouthForm: 0.32, add: { ParamCheek: 0.18, ParamEyeLSmile: 0.15, ParamEyeRSmile: 0.15 } },
    // Calms Idle m02's baked-in eye-smile and raised brows, not just our own offset.
    soft: { mouthForm: -0.12, blend: { ParamCheek: [0, 0.9], ParamEyeLSmile: [0, 0.9], ParamEyeRSmile: [0, 0.9], ParamBrowLForm: [-0.16, 0.9], ParamBrowRForm: [-0.16, 0.9] } },
    curious: { mouthForm: 0.18, add: { ParamBrowLForm: 0.16, ParamBrowRForm: 0.16 } },
    surprised: { like: 'curious' },
    sad: { like: 'soft' },
    pout: { like: 'neutral' },
    shy: { like: 'soft' },
  },
  activities: {
    attentive: { add: { ParamAngleY: 1.5, ParamAngleZ: -1.2, ParamEyeBallY: 0.06 } },
    thinking: { add: { ParamAngleX: -3, ParamAngleY: 1.8, ParamAngleZ: 2.2, ParamEyeBallX: -0.12, ParamEyeBallY: 0.1 } },
  },
  acts: {},
  motions: { minGapMs: 8000, maxPerTurn: 2, tap: { motions: [{ group: 'Tap' }] } },
})

// --- validation -----------------------------------------------------------

const PARAM_ID = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/
const MODEL_PATH = /^models\/[\w@.-]+(\/[\w@. -]+)*\.model3\.json$/
const MAX_MAP_ENTRIES = 64

interface Checker {
  fail: (path: string, message: string) => void // invalid: the section falls back
  note: (path: string, message: string) => void // reported only
}

type Fields = Record<string, unknown>

const isRecord = (value: unknown): value is Fields => typeof value === 'object' && value !== null && !Array.isArray(value)
const visibleKeys = (value: Fields) => Object.keys(value).filter(key => !key.startsWith('_'))
const join = (path: string, key: string | number) => typeof key === 'number' ? `${path}[${key}]` : path ? `${path}.${key}` : key

// Keys starting with '_' are notes and are ignored.
function fields(check: Checker, value: unknown, path: string, known: readonly string[]): Fields | undefined {
  if (!isRecord(value)) {
    check.fail(path, value === undefined ? 'is required' : 'must be an object')
    return undefined
  }
  for (const key of visibleKeys(value))
    if (!known.includes(key)) check.note(join(path, key), 'unknown key, ignored')
  return value
}

function number(check: Checker, value: unknown, path: string, min: number, max: number, rule: { integer?: boolean, above?: boolean, label?: string } = {}): number | undefined {
  const label = rule.label ? `${rule.label} ` : ''
  if (value === undefined) {
    check.fail(path, `${label}is required`)
    return undefined
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    check.fail(path, `${label}must be a finite number`)
    return undefined
  }
  if (rule.integer && !Number.isInteger(value)) {
    check.fail(path, `${label}must be an integer`)
    return undefined
  }
  if ((rule.above ? value <= min : value < min) || value > max) {
    check.fail(path, `${label}must be ${rule.above ? `above ${min} and at most ${max}` : `${min}..${max}`}`)
    return undefined
  }
  return value
}

const optional = <T>(value: unknown, read: () => T | undefined) => value === undefined ? undefined : read()

function paramId(check: Checker, value: unknown, path: string): string | undefined {
  if (typeof value === 'string' && PARAM_ID.test(value)) return value
  check.fail(path, value === undefined ? 'is required' : 'must be a parameter id')
  return undefined
}

function paramList(check: Checker, value: unknown, path: string, max: number): string[] {
  if (!Array.isArray(value)) {
    check.fail(path, value === undefined ? 'is required' : 'must be a list of parameter ids')
    return []
  }
  if (value.length > max) check.fail(path, `at most ${max} parameter ids`)
  return value.slice(0, max).map((id, index) => paramId(check, id, join(path, index))).filter(id => id !== undefined)
}

function paramMap<T>(check: Checker, value: unknown, path: string, read: (entry: unknown, path: string) => T | undefined): Record<ParamId, T> {
  const out: Record<ParamId, T> = {}
  if (!isRecord(value)) {
    check.fail(path, 'must be an object of parameter ids')
    return out
  }
  const keys = visibleKeys(value)
  if (keys.length > MAX_MAP_ENTRIES) check.fail(path, `at most ${MAX_MAP_ENTRIES} parameters`)
  for (const key of keys.slice(0, MAX_MAP_ENTRIES)) {
    if (!PARAM_ID.test(key)) {
      check.fail(join(path, key), 'not a parameter id')
      continue
    }
    const entry = read(value[key], join(path, key))
    if (entry !== undefined) out[key] = entry
  }
  return out
}

function ops(check: Checker, source: Fields, path: string): Ops {
  const out: { add?: Record<ParamId, number>, scale?: Record<ParamId, number>, blend?: Record<ParamId, [number, number]> } = {}
  if (source.add !== undefined) out.add = paramMap(check, source.add, join(path, 'add'), (v, p) => number(check, v, p, -30, 30))
  if (source.scale !== undefined) out.scale = paramMap(check, source.scale, join(path, 'scale'), (v, p) => number(check, v, p, 0, 3))
  if (source.blend !== undefined) {
    out.blend = paramMap(check, source.blend, join(path, 'blend'), (v, p) => {
      if (!Array.isArray(v) || v.length !== 2) {
        check.fail(p, 'must be [target, strength]')
        return undefined
      }
      const target = number(check, v[0], join(p, 0), -30, 30, { label: 'target' })
      const strength = number(check, v[1], join(p, 1), 0, 1, { label: 'strength' })
      return target === undefined || strength === undefined ? undefined : [target, strength]
    })
  }
  return out
}

function wave(check: Checker, value: unknown, path: string): Wave | undefined {
  const source = fields(check, value, path, ['amplitude', 'periodMs', 'phase'])
  if (!source) return undefined
  const amplitude = number(check, source.amplitude, join(path, 'amplitude'), -30, 30)
  const periodMs = number(check, source.periodMs, join(path, 'periodMs'), 50, 600_000)
  const phase = optional(source.phase, () => number(check, source.phase, join(path, 'phase'), -100, 100))
  if (amplitude === undefined || periodMs === undefined) return undefined
  return phase === undefined ? { amplitude, periodMs } : { amplitude, periodMs, phase }
}

function expression(check: Checker, value: unknown, path: string): Expression | undefined {
  const source = fields(check, value, path, ['add', 'scale', 'blend', 'mouthForm', 'like'])
  if (!source) return undefined
  if (source.like !== undefined) {
    if (!EMOTIONS.includes(source.like as Emotion)) {
      check.fail(join(path, 'like'), 'must be one of the 8 emotions')
      return undefined
    }
    if (['add', 'scale', 'blend', 'mouthForm'].some(key => source[key] !== undefined))
      check.fail(path, 'like cannot be combined with add, scale, blend or mouthForm')
    return { like: source.like as Emotion }
  }
  const out: Expression = { ...ops(check, source, path) }
  const mouthForm = optional(source.mouthForm, () => number(check, source.mouthForm, join(path, 'mouthForm'), -2, 2))
  return mouthForm === undefined ? out : { ...out, mouthForm }
}

function expressions(check: Checker, value: unknown): Record<Emotion, Expression> | undefined {
  if (!isRecord(value)) {
    check.fail('expressions', value === undefined ? 'is required' : 'must be an object')
    return undefined
  }
  for (const key of visibleKeys(value))
    if (!EMOTIONS.includes(key as Emotion)) check.fail(join('expressions', key), 'not an emotion')
  const out = {} as Record<Emotion, Expression>
  for (const emotion of EMOTIONS) {
    const entry = expression(check, value[emotion], join('expressions', emotion))
    if (entry) out[emotion] = entry
  }
  for (const emotion of EMOTIONS) {
    const like = out[emotion]?.like
    if (like === undefined) continue
    if (like === emotion) check.fail(join(join('expressions', emotion), 'like'), 'cannot wear its own face')
    else if (out[like]?.like !== undefined) check.fail(join(join('expressions', emotion), 'like'), `${like} wears ${out[like].like}; like cannot chain`)
  }
  return out
}

function actPulse(check: Checker, value: unknown, path: string): ActPulse | undefined {
  const source = fields(check, value, path, ['add', 'scale', 'blend', 'mouthForm', 'attackMs', 'holdMs', 'releaseMs', 'oscillate', 'followVoice'])
  if (!source) return undefined
  const attackMs = number(check, source.attackMs, join(path, 'attackMs'), 0, 3000)
  const holdMs = number(check, source.holdMs, join(path, 'holdMs'), 0, 3000)
  const releaseMs = number(check, source.releaseMs, join(path, 'releaseMs'), 0, 3000)
  if (attackMs === undefined || holdMs === undefined || releaseMs === undefined) return undefined
  if (attackMs + holdMs + releaseMs > 4000) check.fail(path, 'attackMs + holdMs + releaseMs must be at most 4000')
  const out: { -readonly [K in keyof ActPulse]: ActPulse[K] } = { ...ops(check, source, path), attackMs, holdMs, releaseMs }
  const mouthForm = optional(source.mouthForm, () => number(check, source.mouthForm, join(path, 'mouthForm'), -2, 2))
  if (mouthForm !== undefined) out.mouthForm = mouthForm
  if (source.oscillate !== undefined) out.oscillate = paramMap(check, source.oscillate, join(path, 'oscillate'), (v, p) => wave(check, v, p))
  const followVoice = optional(source.followVoice, () => number(check, source.followVoice, join(path, 'followVoice'), 0, 1))
  if (followVoice !== undefined) out.followVoice = followVoice
  return out
}

function trigger(check: Checker, value: unknown, path: string): Trigger | undefined {
  const source = fields(check, value, path, ['motions', 'chance', 'cooldownMs'])
  if (!source) return undefined
  if (!Array.isArray(source.motions)) {
    check.fail(join(path, 'motions'), source.motions === undefined ? 'is required' : 'must be a list')
    return undefined
  }
  if (source.motions.length > 8) check.fail(join(path, 'motions'), 'at most 8 motions')
  const motions: MotionRef[] = []
  source.motions.slice(0, 8).forEach((entry, index) => {
    const at = join(join(path, 'motions'), index)
    const ref = fields(check, entry, at, ['group', 'index'])
    if (!ref) return
    if (typeof ref.group !== 'string' || ref.group.length < 1 || ref.group.length > 64) {
      check.fail(join(at, 'group'), 'must be a motion group name (1..64 characters)')
      return
    }
    const motionIndex = optional(ref.index, () => number(check, ref.index, join(at, 'index'), 0, 999, { integer: true }))
    motions.push(motionIndex === undefined ? { group: ref.group } : { group: ref.group, index: motionIndex })
  })
  const out: { -readonly [K in keyof Trigger]: Trigger[K] } = { motions }
  const chance = optional(source.chance, () => number(check, source.chance, join(path, 'chance'), 0, 1))
  if (chance !== undefined) out.chance = chance
  const cooldownMs = optional(source.cooldownMs, () => number(check, source.cooldownMs, join(path, 'cooldownMs'), 0, 600_000))
  if (cooldownMs !== undefined) out.cooldownMs = cooldownMs
  return out
}

function keyedTriggers<K extends string>(check: Checker, value: unknown, path: string, allowed: readonly K[], kind: string): Partial<Record<K, Trigger>> {
  const out: Partial<Record<K, Trigger>> = {}
  if (!isRecord(value)) {
    check.fail(path, 'must be an object')
    return out
  }
  for (const key of visibleKeys(value)) {
    if (!allowed.includes(key as K)) {
      check.fail(join(path, key), `not ${kind}`)
      continue
    }
    const entry = trigger(check, value[key], join(path, key))
    if (entry) out[key as K] = entry
  }
  return out
}

const SECTIONS = {
  layout(check: Checker, value: unknown): AvatarLayout | undefined {
    const keys = ['fitWidth', 'fitHeight', 'anchorY', 'portraitFitHeight', 'portraitAnchorY'] as const
    const source = fields(check, value, 'layout', keys)
    if (!source) return undefined
    const out = {} as Record<(typeof keys)[number], number>
    for (const key of keys) out[key] = number(check, source[key], join('layout', key), 0, 4, { above: true }) ?? 0
    return out
  },
  parameters(check: Checker, value: unknown): AvatarParameters | undefined {
    const source = fields(check, value, 'parameters', ['mouthOpen', 'mouthForm', 'eyeOpen', 'headPitch', 'motion', 'prePhysics'])
    if (!source) return undefined
    const motion = paramList(check, source.motion, 'parameters.motion', MAX_MAP_ENTRIES)
    const prePhysics = paramList(check, source.prePhysics, 'parameters.prePhysics', MAX_MAP_ENTRIES)
    prePhysics.forEach((id, index) => {
      if (!motion.includes(id)) check.fail(join('parameters.prePhysics', index), `${id} must also be in parameters.motion`)
    })
    return {
      mouthOpen: paramId(check, source.mouthOpen, 'parameters.mouthOpen') ?? '',
      mouthForm: paramId(check, source.mouthForm, 'parameters.mouthForm') ?? '',
      eyeOpen: paramList(check, source.eyeOpen, 'parameters.eyeOpen', 4),
      headPitch: paramId(check, source.headPitch, 'parameters.headPitch') ?? '',
      motion,
      prePhysics,
    }
  },
  mouth(check: Checker, value: unknown) {
    const source = fields(check, value, 'mouth', ['formRange'])
    if (!source) return undefined
    const range = source.formRange
    if (!Array.isArray(range) || range.length !== 2) {
      check.fail('mouth.formRange', 'must be [min, max]')
      return undefined
    }
    const min = number(check, range[0], 'mouth.formRange[0]', -3, 0)
    const max = number(check, range[1], 'mouth.formRange[1]', 0, 3)
    if (min === 0) check.fail('mouth.formRange[0]', 'must be below 0')
    if (max === 0) check.fail('mouth.formRange[1]', 'must be above 0')
    return min === undefined || max === undefined ? undefined : { formRange: [min, max] as const }
  },
  timing(check: Checker, value: unknown) {
    const source = fields(check, value, 'timing', ['easeInMs', 'relaxMs'])
    if (!source) return undefined
    return {
      easeInMs: number(check, source.easeInMs, 'timing.easeInMs', 50, 2000) ?? 0,
      relaxMs: number(check, source.relaxMs, 'timing.relaxMs', 50, 5000) ?? 0,
    }
  },
  expressions,
  activities(check: Checker, value: unknown) {
    const source = fields(check, value, 'activities', ['attentive', 'thinking'])
    if (!source) return undefined
    const pose = (key: 'attentive' | 'thinking') => {
      const path = join('activities', key)
      const entry = fields(check, source[key], path, ['add'])
      return { add: entry ? paramMap(check, entry.add, join(path, 'add'), (v, p) => number(check, v, p, -30, 30)) : {} }
    }
    return { attentive: pose('attentive'), thinking: pose('thinking') }
  },
  acts(check: Checker, value: unknown) {
    const out: Partial<Record<Act, ActPulse>> = {}
    if (value === undefined) return out
    if (!isRecord(value)) {
      check.fail('acts', 'must be an object')
      return out
    }
    for (const key of visibleKeys(value)) {
      if (!ACTS.includes(key as Act)) {
        check.fail(join('acts', key), 'not an act')
        continue
      }
      const pulse = actPulse(check, value[key], join('acts', key))
      if (pulse) out[key as Act] = pulse
    }
    return out
  },
  motions(check: Checker, value: unknown): AvatarMotions | undefined {
    const source = fields(check, value, 'motions', ['minGapMs', 'maxPerTurn', 'tap', 'turnStart', 'emotions', 'acts', 'idle'])
    if (!source) return undefined
    const out: { -readonly [K in keyof AvatarMotions]: AvatarMotions[K] } = {
      minGapMs: number(check, source.minGapMs, 'motions.minGapMs', 0, 120_000) ?? 0,
      maxPerTurn: number(check, source.maxPerTurn, 'motions.maxPerTurn', 0, 10, { integer: true }) ?? 0,
    }
    if (source.tap !== undefined) out.tap = trigger(check, source.tap, 'motions.tap')
    if (source.turnStart !== undefined) out.turnStart = trigger(check, source.turnStart, 'motions.turnStart')
    if (source.emotions !== undefined) out.emotions = keyedTriggers(check, source.emotions, 'motions.emotions', EMOTIONS, 'an emotion')
    if (source.acts !== undefined) out.acts = keyedTriggers(check, source.acts, 'motions.acts', ACTS, 'an act')
    if (source.idle !== undefined) {
      const idle = fields(check, source.idle, 'motions.idle', ['group', 'busyWeights', 'calmOnBusy'])
      if (idle) {
        if (typeof idle.group !== 'string' || idle.group.length < 1 || idle.group.length > 64)
          check.fail('motions.idle.group', 'must be a motion group name (1..64 characters)')
        if (!Array.isArray(idle.busyWeights) || idle.busyWeights.length > 64)
          check.fail('motions.idle.busyWeights', 'must be a list of at most 64 weights')
        if (typeof idle.calmOnBusy !== 'boolean') check.fail('motions.idle.calmOnBusy', 'must be true or false')
        const weights = Array.isArray(idle.busyWeights)
          ? idle.busyWeights.slice(0, 64).map((weight, index) => number(check, weight, join('motions.idle.busyWeights', index), 0, 1000) ?? 0)
          : []
        out.idle = { group: String(idle.group), busyWeights: weights, calmOnBusy: idle.calmOnBusy === true }
      }
    }
    return out
  },
  speaking(check: Checker, value: unknown): AvatarSpeaking | undefined {
    if (value === undefined) return undefined
    const source = fields(check, value, 'speaking', ['envelope', 'sway', 'drift', 'blink'])
    if (!source) return undefined
    const envelope = fields(check, source.envelope, 'speaking.envelope', ['attackMs', 'releaseMs', 'fullAt'])
    const out: { -readonly [K in keyof AvatarSpeaking]: AvatarSpeaking[K] } = {
      envelope: {
        attackMs: number(check, envelope?.attackMs, 'speaking.envelope.attackMs', 10, 3000) ?? 0,
        releaseMs: number(check, envelope?.releaseMs, 'speaking.envelope.releaseMs', 10, 3000) ?? 0,
        fullAt: number(check, envelope?.fullAt, 'speaking.envelope.fullAt', 0.05, 1) ?? 0,
      },
    }
    if (source.sway !== undefined) out.sway = paramMap(check, source.sway, 'speaking.sway', (v, p) => wave(check, v, p))
    if (source.drift !== undefined) out.drift = paramMap(check, source.drift, 'speaking.drift', (v, p) => wave(check, v, p))
    if (source.blink !== undefined) {
      const blink = fields(check, source.blink, 'speaking.blink', ['open', 'minBeat', 'minEmphasis', 'engageAbove', 'attackMs', 'releaseMs'])
      if (blink) {
        out.blink = {
          open: number(check, blink.open, 'speaking.blink.open', 0, 2) ?? 0,
          minBeat: number(check, blink.minBeat, 'speaking.blink.minBeat', 0, 1) ?? 0,
          minEmphasis: number(check, blink.minEmphasis, 'speaking.blink.minEmphasis', 0, 1) ?? 0,
          engageAbove: number(check, blink.engageAbove, 'speaking.blink.engageAbove', 0, 2) ?? 0,
          attackMs: number(check, blink.attackMs, 'speaking.blink.attackMs', 10, 1000) ?? 0,
          releaseMs: number(check, blink.releaseMs, 'speaking.blink.releaseMs', 10, 1000) ?? 0,
        }
      }
    }
    return out
  },
} as const

type SectionName = keyof typeof SECTIONS
const SECTION_NAMES = Object.keys(SECTIONS) as SectionName[]
const TOP_LEVEL = ['version', 'id', 'name', 'model', ...SECTION_NAMES]

function capped(problems: string[]): string[] {
  if (problems.length <= MAX_PROFILE_PROBLEMS) return problems
  return [...problems.slice(0, MAX_PROFILE_PROBLEMS - 1), `and ${problems.length - MAX_PROFILE_PROBLEMS + 1} more problems`]
}

function validModelPath(value: unknown): value is string {
  return typeof value === 'string' && MODEL_PATH.test(value) && !value.split('/').includes('..')
}

/**
 * Validate a profile JSON value. An invalid version or model path falls back
 * to the built-in profile; any other invalid value replaces only its section
 * with the built-in one. Problems are path-qualified, at most 20.
 */
export function parseAvatarProfile(input: unknown): ProfileResult {
  if (!isRecord(input))
    return { profile: FALLBACK_AVATAR_PROFILE, problems: ['profile: must be an object; the built-in profile is used'] }
  const problems: string[] = []
  if (input.version !== 1) problems.push('version: must be 1; the built-in profile is used')
  if (!validModelPath(input.model)) problems.push('model: must be a models/<folder>/<file>.model3.json path; the built-in profile is used')
  if (problems.length) return { profile: FALLBACK_AVATAR_PROFILE, problems }

  const note = (path: string, message: string) => {
    problems.push(`${path}: ${message}`)
  }
  for (const key of visibleKeys(input))
    if (!TOP_LEVEL.includes(key)) note(key, 'unknown key, ignored')
  // A bad id or name only loses itself: the sections can still be right.
  const fallback = FALLBACK_AVATAR_PROFILE
  let id = fallback.id
  if (typeof input.id === 'string' && PROFILE_ID.test(input.id)) id = input.id
  else note('id', `must be 1..40 lowercase letters, digits or dashes; using "${fallback.id}"`)
  let name = fallback.name
  if (typeof input.name === 'string' && input.name.length >= 1 && input.name.length <= 60) name = input.name
  else note('name', 'must be 1..60 characters; using the built-in name')

  const profile: Record<string, unknown> = { version: 1, id, name, model: input.model }
  for (const section of SECTION_NAMES) {
    let failed = false
    const check: Checker = {
      fail: (path, message) => {
        failed = true
        note(path, message)
      },
      note,
    }
    const value = (SECTIONS[section] as (check: Checker, value: unknown) => unknown)(check, input[section])
    const chosen = failed ? fallback[section] : value
    if (chosen !== undefined) profile[section] = chosen
  }
  return { profile: deepFreeze(profile as unknown as AvatarProfile), problems: capped(problems) }
}

// --- resolving against the loaded model ------------------------------------

export interface AvatarModelInfo {
  hasParameter: (id: ParamId) => boolean
  motionCount: (group: string) => number
}

/**
 * Drop parameter ids the model does not have (Cubism would otherwise
 * allocate a dummy slot for each) and motion refs it cannot play, and
 * expand a ref without an index to every motion of its group.
 */
export function resolveAvatarProfile(profile: AvatarProfile, model: AvatarModelInfo): ProfileResult {
  const problems: string[] = []
  const has = (id: ParamId, path: string) => {
    if (model.hasParameter(id)) return true
    problems.push(`${path}: ${id} is not in the model, dropped`)
    return false
  }
  const list = (ids: readonly ParamId[], path: string) => ids.filter((id, index) => has(id, join(path, index)))
  const map = <T>(record: Readonly<Record<ParamId, T>> | undefined, path: string) =>
    record && Object.fromEntries(Object.entries(record).filter(([id]) => has(id, join(path, id))))
  const resolveOps = <T extends Ops>(source: T, path: string): T => {
    const records = source as unknown as Record<string, Readonly<Record<ParamId, unknown>> | undefined>
    const out: Record<string, unknown> = { ...records }
    for (const key of ['add', 'scale', 'blend', 'oscillate'])
      if (records[key]) out[key] = map(records[key], join(path, key))
    return out as unknown as T
  }
  const scalar = (id: ParamId, path: string) => {
    if (!model.hasParameter(id)) problems.push(`${path}: ${id} is not in the model`)
    return id
  }
  const resolveTrigger = (source: Trigger | undefined, path: string): Trigger | undefined => source && {
    ...source,
    motions: source.motions.flatMap((ref, index) => {
      const at = join(join(path, 'motions'), index)
      const count = model.motionCount(ref.group)
      if (!(count > 0)) {
        problems.push(`${at}: no motion group ${ref.group}, dropped`)
        return []
      }
      if (ref.index === undefined) return Array.from({ length: count }, (_, motion) => ({ group: ref.group, index: motion }))
      if (ref.index >= count) {
        problems.push(`${at}: ${ref.group} has ${count} motions, index ${ref.index} dropped`)
        return []
      }
      return [ref]
    }),
  }
  const resolveTriggers = <K extends string>(source: Readonly<Partial<Record<K, Trigger>>> | undefined, path: string) =>
    source && Object.fromEntries(Object.entries(source).map(([key, value]) => [key, resolveTrigger(value as Trigger, join(path, key))])) as Partial<Record<K, Trigger>>

  const { parameters, motions, speaking } = profile
  const expressions = Object.fromEntries(EMOTIONS.map(emotion =>
    [emotion, resolveOps(profile.expressions[emotion], join('expressions', emotion))])) as Record<Emotion, Expression>
  const acts = Object.fromEntries(Object.entries(profile.acts).map(([act, pulse]) =>
    [act, resolveOps(pulse as ActPulse, join('acts', act))])) as Partial<Record<Act, ActPulse>>
  let idle = motions.idle
  if (idle) {
    const count = model.motionCount(idle.group)
    if (!(count > 0)) {
      problems.push(`motions.idle.group: no motion group ${idle.group}, Idle weighting dropped`)
      idle = undefined
    }
    else if (idle.busyWeights.length < count) {
      problems.push(`motions.idle.busyWeights: ${idle.group} has ${count} motions; the missing weights count as 0`)
    }
  }
  const resolved: AvatarProfile = {
    ...profile,
    parameters: {
      mouthOpen: scalar(parameters.mouthOpen, 'parameters.mouthOpen'),
      mouthForm: scalar(parameters.mouthForm, 'parameters.mouthForm'),
      eyeOpen: list(parameters.eyeOpen, 'parameters.eyeOpen'),
      headPitch: scalar(parameters.headPitch, 'parameters.headPitch'),
      motion: list(parameters.motion, 'parameters.motion'),
      prePhysics: parameters.prePhysics.filter(id => model.hasParameter(id)),
    },
    expressions,
    activities: {
      attentive: { add: map(profile.activities.attentive.add, 'activities.attentive.add') ?? {} },
      thinking: { add: map(profile.activities.thinking.add, 'activities.thinking.add') ?? {} },
    },
    acts,
    motions: {
      ...motions,
      tap: resolveTrigger(motions.tap, 'motions.tap'),
      turnStart: resolveTrigger(motions.turnStart, 'motions.turnStart'),
      emotions: resolveTriggers(motions.emotions, 'motions.emotions'),
      acts: resolveTriggers(motions.acts, 'motions.acts'),
      idle,
    },
    speaking: speaking && { ...speaking, sway: map(speaking.sway, 'speaking.sway'), drift: map(speaking.drift, 'speaking.drift') },
  }
  // Optional keys stay absent rather than present-but-undefined.
  const strip = (value: Record<string, unknown>) => {
    for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key]
    return value
  }
  strip(resolved.motions as unknown as Record<string, unknown>)
  if (resolved.speaking) strip(resolved.speaking as unknown as Record<string, unknown>)
  strip(resolved as unknown as Record<string, unknown>)
  return { profile: deepFreeze(resolved), problems: capped(problems) }
}

// --- timing helpers shared by the engine and its tests ---------------------

export function smoothstep(x: number): number {
  const t = Math.max(0, Math.min(1, x))
  return t * t * (3 - 2 * t)
}

/** The emotion whose face a tone wears (its `like`, or itself). */
export function faceOf(profile: AvatarProfile, emotion: Emotion): Emotion {
  return profile.expressions[emotion]?.like ?? emotion
}

export interface FaceTrack {
  readonly from: readonly number[] // one weight per EMOTIONS entry
  readonly to: Emotion
  readonly start: number
  readonly duration: number
}

/** Face weights eased by smoothstep from `from` to all of `to`; they sum to 1. */
export function faceWeightsAt(track: FaceTrack, time: number): number[] {
  const progress = track.duration > 0 ? (time - track.start) / track.duration : 1
  if (progress >= 1) return EMOTIONS.map(emotion => Number(emotion === track.to))
  const s = smoothstep(progress)
  return EMOTIONS.map((emotion, index) => track.from[index] + (Number(emotion === track.to) - track.from[index]) * s)
}

/** 0→1 over attack, 1 for hold, 1→0 over release (smoothstep edges); 0 outside. */
export function pulseEnvelope(age: number, pulse: { readonly attackMs: number, readonly holdMs: number, readonly releaseMs: number }): number {
  if (!(age >= 0)) return 0
  if (age < pulse.attackMs) return smoothstep(age / pulse.attackMs)
  const released = age - pulse.attackMs - pulse.holdMs
  if (released < 0) return 1
  if (released < pulse.releaseMs) return smoothstep(1 - released / pulse.releaseMs)
  return 0
}

export function waveAt(wave: Wave, ms: number): number {
  return wave.amplitude * Math.sin(2 * Math.PI * ms / wave.periodMs + (wave.phase ?? 0))
}

/** Exponential follower: frame-rate independent for a held target. */
export function follow(current: number, target: number, deltaMs: number, attackMs: number, releaseMs: number): number {
  const tau = target > current ? attackMs : releaseMs
  return target + (current - target) * Math.exp(-Math.max(0, deltaMs) / tau)
}
