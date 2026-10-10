// Development-only real Cubism diagnostic. Never imported by the app: no
// mutable model internals or debug hooks are added to the production mount.
import * as PIXI from 'pixi.js'
import { Live2DFactory, Live2DModel } from 'pixi-live2d-display/cubism4'
import { attachAvatarPerformance } from '../src/avatar-performance.ts'
import { createAvatarMountScope, loadAvatarResource, releaseAvatarModel, releaseAvatarRendererTextures } from '../src/avatar-mount.ts'
import { applyAvatarRenderBudget, attachAvatarRenderLoop, resolveAvatarRenderBudget } from '../src/avatar-rendering.ts'
import { readDeviceHints } from '../src/speech-mode.ts'
import { createPitchShadow, LOW_MOUTH_OPEN_THRESHOLD } from './avatar-diagnostic.mjs'

export async function mountSpeechBeatDiagnostic(container, { signal } = {}) {
  const scope = createAvatarMountScope(signal)
  try {
    scope.assertActive()
    Object.assign(window, { PIXI })
    const hints = readDeviceHints()
    let budget = resolveAvatarRenderBudget(hints, window.devicePixelRatio)
    const antialias = budget.antialias
    const app = new PIXI.Application({ width: Math.max(1, container.clientWidth), height: Math.max(1, container.clientHeight),
      backgroundAlpha: 0, antialias, autoDensity: true, resolution: budget.resolution,
      autoStart: false, sharedTicker: false })
    scope.own(() => app.destroy(true, { children: false }))
    scope.own(() => releaseAvatarRendererTextures(app.renderer.texture))
    const interaction = app.renderer.plugins.interaction
    const interactionWasEnabled = interaction?.useSystemTicker
    if (interaction) interaction.useSystemTicker = false
    container.appendChild(app.view)
    const modelOptions = { autoInteract: true, autoUpdate: false }
    const model = await loadAvatarResource(scope, () => new Live2DModel(modelOptions),
      model => Live2DFactory.setupLive2DModel(model,
        `${import.meta.env.BASE_URL}models/hiyori/hiyori_free_t08.model3.json`, modelOptions),
      model => releaseAvatarModel(model, () => PIXI.Container.prototype.destroy.call(model, { children: false })))
    model.anchor.set(.5, 1)
    app.stage.addChild(model)
    const naturalWidth = model.width, naturalHeight = model.height
    const layout = () => {
      if (scope.disposed || container.clientWidth <= 0 || container.clientHeight <= 0) return
      const width = container.clientWidth, height = container.clientHeight
      if (app.screen.width !== width || app.screen.height !== height) app.renderer.resize(width, height)
      model.scale.set(Math.min(width * .9 / naturalWidth, height * .94 / naturalHeight))
      model.position.set(width / 2, height * 1.04)
    }
    const observer = new ResizeObserver(layout)
    scope.own(() => observer.disconnect())
    observer.observe(container)
    layout()
    const internal = model.internalModel, core = internal.coreModel
    const pitchIndex = core.getParameterIndex('ParamAngleY')
    const minimum = core.getParameterMinimumValue(pitchIndex), maximum = core.getParameterMaximumValue(pitchIndex)
    const baseline = createPitchShadow(minimum, maximum), fallback = createPitchShadow(minimum, maximum)
    const preference = matchMedia('(prefers-reduced-motion: reduce)')
    let fixtureReduced = false, frameTime = performance.now(), beforePitch = 0, activity = 'idle', open = 0, beat = null
    const reducedMotion = () => fixtureReduced || preference.matches
    let baselineApply = null, fallbackApply = null
    const before = () => {
      frameTime = performance.now()
      beforePitch = core.getParameterValueById('ParamAngleY')
      baseline.setBaseline(beforePitch); fallback.setBaseline(beforePitch)
      baselineApply?.(); fallbackApply?.()
    }
    internal.on('beforeModelUpdate', before)
    scope.own(() => internal.off('beforeModelUpdate', before))
    const actual = attachAvatarPerformance(internal, { now: () => frameTime, reducedMotion })
    const shadow = (pitch, setApply) => attachAvatarPerformance({ coreModel: pitch.coreModel,
      on(_event, listener) { setApply(listener) }, off() { setApply(null) },
    }, { now: () => frameTime, reducedMotion })
    const baselineActor = shadow(baseline, listener => { baselineApply = listener })
    const fallbackActor = shadow(fallback, listener => { fallbackApply = listener })
    baselineActor.setMouth(0, 0, 0)
    scope.own(actual.destroy); scope.own(baselineActor.destroy); scope.own(fallbackActor.destroy)
    const metrics = { frames: 0, alignedFrames: 0, silentFrames: 0, reducedFrames: 0,
      boundsErrors: 0, silentErrors: 0, reducedErrors: 0, mouthErrors: 0,
      beforePitch: 0, currentPitch: 0, zeroInputPitch: 0, fallbackPitch: 0,
      currentOffset: 0, fallbackOffset: 0, maxCurrentOffset: 0, maxFallbackOffset: 0 }
    const after = () => {
      const currentPitch = core.getParameterValueById('ParamAngleY')
      const renderedOpen = core.getParameterValueById('ParamMouthOpenY')
      const currentOffset = Math.abs(currentPitch - baseline.getPitch())
      const fallbackOffset = Math.abs(fallback.getPitch() - baseline.getPitch())
      const silent = activity !== 'speaking' || open === null || open < LOW_MOUTH_OPEN_THRESHOLD
      const reduced = reducedMotion()
      metrics.frames++
      if (beat !== null && activity === 'speaking') metrics.alignedFrames++
      if (silent) { metrics.silentFrames++; if (currentOffset > 1e-6) metrics.silentErrors++ }
      if (reduced) { metrics.reducedFrames++; if (currentOffset > 1e-6) metrics.reducedErrors++ }
      if (currentOffset > .900001 || currentPitch < minimum - 1e-6 || currentPitch > maximum + 1e-6) metrics.boundsErrors++
      if (activity !== 'speaking' && renderedOpen > 1e-6) metrics.mouthErrors++
      Object.assign(metrics, { beforePitch, currentPitch, zeroInputPitch: baseline.getPitch(), fallbackPitch: fallback.getPitch(),
        currentOffset, fallbackOffset, maxCurrentOffset: Math.max(metrics.maxCurrentOffset, currentOffset),
        maxFallbackOffset: Math.max(metrics.maxFallbackOffset, fallbackOffset) })
    }
    internal.on('beforeModelUpdate', after)
    scope.own(() => internal.off('beforeModelUpdate', after))
    if (interaction && interactionWasEnabled !== undefined) interaction.useSystemTicker = interactionWasEnabled
    const renderLoop = attachAvatarRenderLoop(app, model, { visibility: document, budget, updatePriority: PIXI.UPDATE_PRIORITY.NORMAL })
    scope.own(renderLoop.destroy)
    return {
      setActivity(value) { activity = value; actual.setActivity(value); baselineActor.setActivity(value); fallbackActor.setActivity(value) },
      setDelivery(value) { actual.setDelivery(value); baselineActor.setDelivery(value); fallbackActor.setDelivery(value) },
      setMouth(value, form, intensity = null) { open = value; beat = intensity; actual.setMouth(value, form, intensity); fallbackActor.setMouth(value, form) },
      setReducedMotion(value) { fixtureReduced = Boolean(value) },
      diagnostics() { return { ...metrics, reduced: reducedMotion(), systemReduced: preference.matches, fixtureReduced } },
      get renderBudget() { return { ...budget } },
      setRenderProfile(profile) {
        if (!scope.disposed) {
          const next = resolveAvatarRenderBudget(hints, window.devicePixelRatio, profile)
          applyAvatarRenderBudget(app, next)
          budget = { ...next, antialias }
        }
        return { ...budget }
      },
      destroy: scope.dispose,
    }
  }
  catch (error) { scope.dispose(); throw error }
}
