import type { Delivery } from './delivery'

export type AvatarActivity = 'idle' | 'attentive' | 'thinking' | 'speaking'

interface ParameterModel {
  coreModel: {
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
  let reactionStartedAt: number | null = null
  const reactionDuration = 650
  const weights = { attentive: 0, thinking: 0, speaking: 0, bright: 0, soft: 0, curious: 0 }

  const apply = () => {
    const time = now()
    const delta = Math.max(0, Math.min(100, time - previousTime)) / 1_000
    previousTime = time
    elapsed += delta
    const blend = 1 - Math.exp(-delta / 0.28)
    for (const key of ['attentive', 'thinking', 'speaking'] as const)
      weights[key] += (Number(activity === key) - weights[key]) * blend
    for (const key of ['bright', 'soft', 'curious'] as const)
      weights[key] += (Number(delivery === key) - weights[key]) * blend

    const core = model.coreModel
    const speaking = activity === 'speaking'
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
    const brow = weights.curious * 0.16 - weights.soft * 0.16
    core.addParameterValueById('ParamBrowLForm', brow)
    core.addParameterValueById('ParamBrowRForm', brow)

    const reducedMotion = options.reducedMotion?.() ?? false
    if (reactionStartedAt !== null && (reducedMotion || time - reactionStartedAt >= reactionDuration))
      reactionStartedAt = null
    if (!reducedMotion) {
      // Small offsets preserve the original blink, breathing and pointer tracking.
      core.addParameterValueById('ParamAngleX', -weights.thinking * 3 + weights.speaking * Math.sin(elapsed * 1.7) * 0.7)
      core.addParameterValueById('ParamAngleY', weights.attentive * 1.5 + weights.thinking * 1.8 + weights.speaking * Math.sin(elapsed * 2.3) * 0.6)
      core.addParameterValueById('ParamAngleZ', -weights.attentive * 1.2 + weights.thinking * 2.2)
      core.addParameterValueById('ParamEyeBallX', -weights.thinking * 0.12)
      core.addParameterValueById('ParamEyeBallY', weights.attentive * 0.06 + weights.thinking * 0.1)
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
    setActivity(value: AvatarActivity) { activity = value },
    setDelivery(value: Delivery) { delivery = value },
    setMouth(open: number | null, form: number) {
      mouthOpen = open === null ? null : Math.max(0, Math.min(1, open))
      mouthForm = Math.max(-0.32, Math.min(0.32, form))
    },
    destroy() { model.off('beforeModelUpdate', apply) },
  }
}
