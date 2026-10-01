import * as PIXI from 'pixi.js'
import { Live2DFactory, Live2DModel } from 'pixi-live2d-display/cubism4'
import type { Cubism4InternalModel } from 'pixi-live2d-display/cubism4'
import { attachAvatarPerformance } from './avatar-performance'
import { createAvatarMountScope, loadAvatarResource, releaseAvatarModel, releaseAvatarRendererTextures } from './avatar-mount'
import { attachAvatarRenderLoop, resolveAvatarRenderBudget } from './avatar-rendering'
import { readDeviceHints } from './speech-mode'
import type { DeviceHints } from './speech-mode'

export async function mountHiyori(container: HTMLElement, options: { signal?: AbortSignal, deviceHints?: DeviceHints } = {}) {
  const scope = createAvatarMountScope(options.signal)
  try {
    scope.assertActive()
    Object.assign(window, { PIXI })
    const renderBudget = resolveAvatarRenderBudget(options.deviceHints ?? readDeviceHints(), window.devicePixelRatio)
    const app = new PIXI.Application({
      width: Math.max(1, container.clientWidth),
      height: Math.max(1, container.clientHeight),
      backgroundAlpha: 0,
      antialias: renderBudget.antialias,
      autoDensity: true,
      resolution: renderBudget.resolution,
      autoStart: false,
      sharedTicker: false,
    })
    // Models are owned separately, including a late model after app destruction.
    scope.own(() => app.destroy(true, { children: false }))
    scope.own(() => {
      if (app.renderer instanceof PIXI.Renderer)
        releaseAvatarRendererTextures(app.renderer.texture)
    })
    const interaction = app.renderer.plugins.interaction
    const interactionWasEnabled = interaction?.useSystemTicker
    if (interaction) interaction.useSystemTicker = false
    container.appendChild(app.view)

    const modelOptions = { autoInteract: true, autoUpdate: false }
    const model = await loadAvatarResource(scope, () => new Live2DModel(modelOptions),
      model => Live2DFactory.setupLive2DModel(model,
        `${import.meta.env.BASE_URL}models/hiyori/hiyori_free_t08.model3.json`, modelOptions),
      model => releaseAvatarModel(model, () => PIXI.Container.prototype.destroy.call(model, { children: false })))
    model.anchor.set(0.5, 1)
    app.stage.addChild(model)
    const naturalWidth = model.width
    const naturalHeight = model.height

    const layout = () => {
      if (scope.disposed) return
      const width = container.clientWidth
      const height = container.clientHeight
      if (width <= 0 || height <= 0) return
      // resizeTo only watches window resize. Composer/stage layout can change
      // without one; keep the actual buffer and hit-test coordinates in sync.
      if (app.screen.width !== width || app.screen.height !== height)
        app.renderer.resize(width, height)
      // Short phone stages frame the upper body instead of making her face tiny.
      // This crops the camera view; it does not change Hiyori's artwork.
      const portrait = height < 420 && width > height * 1.1
      const scale = Math.min(width * 0.9 / naturalWidth, height * (portrait ? 1.8 : 0.94) / naturalHeight)
      model.scale.set(scale)
      model.x = width / 2
      model.y = height * (portrait ? 1.66 : 1.04)
    }
    const observer = new ResizeObserver(layout)
    scope.own(() => observer.disconnect())
    observer.observe(container)
    layout()

    model.on('hit', () => {
      if (!scope.disposed) void model.motion('Tap')
    })

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const actor = attachAvatarPerformance(model.internalModel as Cubism4InternalModel, {
      reducedMotion: () => reducedMotion.matches,
    })
    scope.own(actor.destroy)
    if (interaction && interactionWasEnabled !== undefined)
      interaction.useSystemTicker = interactionWasEnabled
    const renderLoop = attachAvatarRenderLoop(app, model, {
      visibility: document,
      budget: renderBudget,
      updatePriority: PIXI.UPDATE_PRIORITY.NORMAL,
    })
    scope.own(renderLoop.destroy)

    return {
      acknowledge: actor.acknowledge,
      clearReaction: actor.clearReaction,
      setActivity: actor.setActivity,
      setMouth: actor.setMouth,
      setDelivery: actor.setDelivery,
      renderBudget,
      destroy: scope.dispose,
    }
  }
  catch (error) {
    scope.dispose()
    throw error
  }
}
