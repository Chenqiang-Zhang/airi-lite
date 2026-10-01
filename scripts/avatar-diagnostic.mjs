// Diagnostic-only pitch model, not a substitute for a rendered Cubism model.
// Mirror Cubism 4's parameter writes: clamp the target before weight blending;
// an additive write goes through that same setter with its weighted delta.
export const LOW_MOUTH_OPEN_THRESHOLD = 0.06

export function createPitchShadow(minimum = -30, maximum = 30) {
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum >= maximum)
    throw new TypeError('Invalid diagnostic pitch bounds')
  const clamp = value => Math.max(minimum, Math.min(maximum, value))
  let pitch = clamp(0)

  const coreModel = {
    getParameterValueById(id) { return id === 'ParamAngleY' ? pitch : 0 },
    setParameterValueById(id, value, weight = 1) {
      if (id !== 'ParamAngleY') return
      const target = clamp(value)
      pitch = weight === 1 ? target : pitch * (1 - weight) + target * weight
    },
    addParameterValueById(id, value, weight = 1) {
      if (id === 'ParamAngleY')
        coreModel.setParameterValueById(id, pitch + value * weight)
    },
  }
  return {
    coreModel,
    setBaseline(value) {
      if (!Number.isFinite(value)) throw new TypeError('Invalid diagnostic pitch baseline')
      pitch = clamp(value)
    },
    getPitch() { return pitch },
  }
}
