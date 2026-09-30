import * as PIXI from 'pixi.js'
import { Live2DModel } from 'pixi-live2d-display/cubism4'
import type { Cubism4InternalModel } from 'pixi-live2d-display/cubism4'
import { attachAvatarPerformance } from './avatar-performance'

export async function mountHiyori(container: HTMLElement) {
  // pixi-live2d-display uses the shared PIXI ticker through the browser global.
  Object.assign(window, { PIXI })

  const app = new PIXI.Application({
    resizeTo: container,
    backgroundAlpha: 0,
    antialias: true,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
  })
  container.appendChild(app.view)

  try {
    const model = await Live2DModel.from(`${import.meta.env.BASE_URL}models/hiyori/hiyori_free_t08.model3.json`, {
      autoInteract: true,
    })
    model.anchor.set(0.5, 1)
    app.stage.addChild(model)
    const naturalWidth = model.width
    const naturalHeight = model.height

    const layout = () => {
      const width = container.clientWidth
      const height = container.clientHeight
      const scale = Math.min(width * 0.9 / naturalWidth, height * 0.94 / naturalHeight)
      model.scale.set(scale)
      model.x = width / 2
      model.y = height * 1.04
    }
    const observer = new ResizeObserver(layout)
    observer.observe(container)
    layout()

    model.on('hit', () => model.motion('Tap'))

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const actor = attachAvatarPerformance(model.internalModel as Cubism4InternalModel, {
      reducedMotion: () => reducedMotion.matches,
    })

    return {
      setActivity: actor.setActivity,
      setMouth: actor.setMouth,
      setDelivery: actor.setDelivery,
      destroy() {
        actor.destroy()
        observer.disconnect()
        app.destroy(true, { children: true, texture: true, baseTexture: true })
      },
    }
  }
  catch (error) {
    app.destroy(true)
    throw error
  }
}
