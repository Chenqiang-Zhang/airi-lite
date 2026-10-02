import type { Delivery } from './delivery'

export type AvatarActivity = 'idle' | 'attentive' | 'thinking' | 'speaking'

interface ParameterModel {
  coreModel: {
    getParameterValueById: (id: string) => number
    setParameterValueById: (id: string, value: number, weight?: number) => void
    addParameterValueById: (id: string, value: number, weight?: number) => void
  }
  on: (event: 'beforeModelUpdate', listener: () => void) => unknown
  off: (event: 'beforeModelUpdate', listener: () => void) => unknown
}

// Apply after Cubism's motion/physics pass, immediately before vertices update.
// A normal PIXI ticker callback runs too early: Idle overwrites its parameters.
export function attachAvatarPerformance(model: ParameterModel, options: {
  now?: () => number
  reducedMotion?: () => boolean
} = {}) {
  const now = options.now ?? (() => performance.now())
  let previousTime = now()
  let elapsed = 0
  let activity: AvatarActivity = 'idle'
  let delivery: Delivery = 'neutral'
  let mouthOpen: number | null = 0
  let mouthForm = 0
  let previousAudioOpen = 0
  let emphasisStartedAt: number | null = null
  let emphasisStrength = 0
  let lastEmphasisAt = -Infinity
  let previouslyReduced = false
  let reactionStartedAt: number | null = null
  const reactionDuration = 650
  const weights = { attentive: 0, thinking: 0, speaking: 0, bright: 0, soft: 0, curious: 0 }

  const apply = () => {
    const time = now()
    const gap = time - previousTime
    const delta = Math.max(0, Math.min(100, gap)) / 1_000
    previousTime = time
    elapsed += delta
    const blend = 1 - Math.exp(-delta / 0.28)
    for (const key of ['attentive', 'thinking', 'speaking'] as const)
      weights[key] += (Number(activity === key) - weights[key]) * blend
    for (const key of ['bright', 'soft', 'curious'] as const)
      weights[key] += (Number(delivery === key) - weights[key]) * blend

    const core = model.coreModel
    const speaking = activity === 'speaking'
    const reducedMotion = options.reducedMotion?.() ?? false
    const audioOpen = speaking && mouthOpen !== null ? mouthOpen : null
    // Numeric mouth opening comes from the current audio envelope; browser
    // speech has no measured envelope. Do not invent prosodic beats for it.
    if (audioOpen === null || reducedMotion || previouslyReduced || gap > 250 || gap < 0) {
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
    // Closing is immediate on pause/cancel, even if an Idle motion opens its mouth.
    core.setParameterValueById('ParamMouthOpenY', speaking
      ? mouthOpen ?? (0.2 + Math.abs(Math.sin(elapsed * 9.6)) * 0.5)
      : 0)
    const form = (speaking ? mouthForm : 0)
      + weights.bright * 0.32 - weights.soft * 0.12 + weights.curious * 0.18
    core.setParameterValueById('ParamMouthForm', Math.max(-0.6, Math.min(0.6, form)))
    core.addParameterValueById('ParamCheek', weights.bright * 0.18)
    core.addParameterValueById('ParamEyeLSmile', weights.bright * 0.15)
    core.addParameterValueById('ParamEyeRSmile', weights.bright * 0.15)
    // Hiyori's Idle can already contain strong blush/smiling eyes. A soft reply
    // should calm that baseline too, not merely omit our bright offset.
    for (const id of ['ParamCheek', 'ParamEyeLSmile', 'ParamEyeRSmile'])
      core.setParameterValueById(id, 0, weights.soft * 0.9)
    for (const id of ['ParamBrowLForm', 'ParamBrowRForm']) {
      core.addParameterValueById(id, weights.curious * 0.16)
      // The real m02 Idle can raise these above 0.6. A small negative
      // offset still leaves a cheerful brow; blend its baseline instead.
      core.setParameterValueById(id, -0.16, weights.soft * 0.9)
    }

    if (reactionStartedAt !== null && (reducedMotion || time - reactionStartedAt >= reactionDuration))
      reactionStartedAt = null
    if (!reducedMotion) {
      // Small offsets preserve the original blink, breathing and pointer tracking.
      core.addParameterValueById('ParamAngleX', -weights.thinking * 3)
      core.addParameterValueById('ParamAngleY', weights.attentive * 1.5 + weights.thinking * 1.8)
      core.addParameterValueById('ParamAngleZ', -weights.attentive * 1.2 + weights.thinking * 2.2)
      core.addParameterValueById('ParamEyeBallX', -weights.thinking * 0.12)
      core.addParameterValueById('ParamEyeBallY', weights.attentive * 0.06 + weights.thinking * 0.1)
      if (emphasisStartedAt !== null) {
        const age = time - emphasisStartedAt
        if (age >= 360) emphasisStartedAt = null
        else {
          const progress = age <= 80 ? age / 80 : 1 - (age - 80) / 280
          const smooth = progress * progress * (3 - 2 * progress)
          const baseline = core.getParameterValueById('ParamAngleY')
          // A small pitch-only emphasis avoids coupling X/Z into hair physics.
          // Clamp relative to this frame's real Idle baseline, not a fake zero.
          const pitch = Math.max(-30, Math.min(30, baseline - smooth * emphasisStrength * 0.9))
          core.addParameterValueById('ParamAngleY', pitch - baseline)
        }
      }
      if (reactionStartedAt !== null) {
        const progress = Math.max(0, (time - reactionStartedAt) / reactionDuration)
        const reaction = Math.sin(Math.PI * progress) ** 2
        // Ease a little out of Hiyori's extreme Idle pitches before the nod.
        // Y is not a physics input in this model; X/Z and hair stay untouched.
        core.setParameterValueById('ParamAngleY', 0, reaction * 0.18)
        core.addParameterValueById('ParamAngleY', -reaction * 2.4)
      }
    }
  }

  model.on('beforeModelUpdate', apply)
  return {
    acknowledge() { reactionStartedAt = options.reducedMotion?.() ? null : now() },
    clearReaction() { reactionStartedAt = null },
    setActivity(value: AvatarActivity) {
      if (value !== 'speaking') {
        emphasisStartedAt = null
        emphasisStrength = previousAudioOpen = 0
        lastEmphasisAt = -Infinity
      }
      activity = value
    },
    setDelivery(value: Delivery) { delivery = value },
    setMouth(open: number | null, form: number) {
      mouthOpen = open === null ? null : Number.isFinite(open) ? Math.max(0, Math.min(1, open)) : 0
      mouthForm = Number.isFinite(form) ? Math.max(-0.32, Math.min(0.32, form)) : 0
      if (mouthOpen === null || mouthOpen < 0.06) {
        emphasisStartedAt = null
        previousAudioOpen = mouthOpen ?? 0
      }
    },
    destroy() { model.off('beforeModelUpdate', apply) },
  }
}
