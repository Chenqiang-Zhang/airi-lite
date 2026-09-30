import * as PIXI from 'pixi.js'
import { Live2DModel } from 'pixi-live2d-display/cubism4'
import type { Delivery } from './delivery'

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

    let speaking = false
    let delivery: Delivery = 'neutral'
    let tick = 0
    let mouthLevel: number | null = null
    let mouthForm = 0
    const animateMouth = () => {
      if (!speaking)
        return
      tick += 0.16
      const core = model.internalModel.coreModel as unknown as {
        setParameterValueById?: (id: string, value: number, weight?: number) => void
      }
      core.setParameterValueById?.('ParamMouthOpenY', mouthLevel ?? (0.3 + Math.abs(Math.sin(tick)) * 0.55))
      let form = mouthForm
      if (delivery === 'bright') {
        form += 0.32
        core.setParameterValueById?.('ParamCheek', 0.3, 0.35)
        core.setParameterValueById?.('ParamEyeLSmile', 0.25, 0.3)
        core.setParameterValueById?.('ParamEyeRSmile', 0.25, 0.3)
      }
      else if (delivery === 'soft') {
        form -= 0.12
        core.setParameterValueById?.('ParamBrowLForm', -0.2, 0.25)
        core.setParameterValueById?.('ParamBrowRForm', -0.2, 0.25)
      }
      else if (delivery === 'curious') {
        form += 0.18
        core.setParameterValueById?.('ParamBrowLForm', 0.2, 0.25)
        core.setParameterValueById?.('ParamBrowRForm', 0.2, 0.25)
      }
      core.setParameterValueById?.('ParamMouthForm', Math.max(-0.6, Math.min(0.6, form)), 0.5)
    }
    app.ticker.add(animateMouth)

    return {
      setSpeaking(value: boolean) {
        speaking = value
        if (!value) {
          mouthLevel = null
          mouthForm = 0
          const core = model.internalModel.coreModel as unknown as {
            setParameterValueById?: (id: string, value: number) => void
          }
          core.setParameterValueById?.('ParamMouthOpenY', 0)
          core.setParameterValueById?.('ParamMouthForm', 0)
        }
      },
      setMouth(value: number | null, form: number) {
        mouthLevel = value === null ? null : Math.min(1, Math.max(0, value))
        mouthForm = value === null ? 0 : Math.max(-0.32, Math.min(0.32, form))
      },
      setDelivery(value: Delivery) {
        delivery = value
      },
      destroy() {
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
