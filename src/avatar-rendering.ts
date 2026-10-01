import type { DeviceHints } from './speech-mode'

export interface AvatarRenderBudget {
  maxFPS: 30 | 60
  resolution: number
  antialias: boolean
}

function positiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

// Device hints are an opt-in saving heuristic, not a GPU benchmark. Missing
// WebGPU says nothing about the WebGL renderer used by Live2D.
export function resolveAvatarRenderBudget(hints: DeviceHints = {}, dpr = 1): AvatarRenderBudget {
  const candidate: unknown = hints
  const read = (key: keyof DeviceHints): unknown => {
    try {
      return candidate !== null && (typeof candidate === 'object' || typeof candidate === 'function')
        ? (candidate as DeviceHints)[key]
        : undefined
    }
    catch { return undefined }
  }
  const memory = read('memoryGB')
  const cores = read('cores')
  const saving = read('saveData') === true
    || (positiveFinite(memory) && memory <= 4)
    || (positiveFinite(cores) && cores <= 2)
  const ratio = positiveFinite(dpr) ? dpr : 1
  return {
    maxFPS: saving ? 30 : 60,
    resolution: Math.min(ratio, saving ? 1.25 : 2),
    antialias: !saving,
  }
}

interface AvatarTicker {
  deltaMS: number
  minFPS: number
  maxFPS: number
  add: (callback: () => void, context?: unknown, priority?: number) => unknown
  remove: (callback: () => void, context?: unknown) => unknown
}

export interface AvatarRenderApp {
  ticker: AvatarTicker
  start: () => void
  stop: () => void
  renderer?: {
    plugins?: {
      interaction?: { useSystemTicker: boolean }
    }
  }
}

export interface AvatarRenderLoopOptions {
  visibility: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>
  // PIXI's Application render listener is LOW (-25). NORMAL (0), or a higher
  // update priority, accumulates this frame's model delta before rendering it.
  updatePriority?: number
  budget?: AvatarRenderBudget
}

// The caller must load the Live2DModel with autoUpdate:false and use an
// Application with its own ticker. This helper never touches a global ticker.
// Destroying the loop stops scheduling but does not dispose the app/model.
export function attachAvatarRenderLoop(
  app: AvatarRenderApp,
  model: { update: (milliseconds: number) => void },
  options: AvatarRenderLoopOptions,
) {
  const { visibility } = options
  const interaction = app.renderer?.plugins?.interaction
  const originalInteractionTicker = interaction?.useSystemTicker
  const maxFPS = options.budget?.maxFPS === 30 ? 30 : 60
  const priority = typeof options.updatePriority === 'number'
    && Number.isFinite(options.updatePriority) && options.updatePriority >= 0
    ? options.updatePriority : 0
  let destroyed = false
  let running: boolean | null = null

  // An app may already be running when attached. Stop it before changing its
  // timing contract or installing the model update callback.
  app.stop()
  app.ticker.maxFPS = maxFPS
  // PIXI6's minFPS setter uses Math.min(maxFPS, fps); setting it while
  // maxFPS is still its unlimited sentinel (0) would accidentally disable
  // the delta cap. Install the finite frame ceiling first.
  app.ticker.minFPS = 10

  const updateModel = () => {
    if (destroyed || !running || visibility.hidden)
      return
    const delta = app.ticker.deltaMS
    if (positiveFinite(delta))
      model.update(Math.min(delta, 100))
  }
  const setInteractionTicker = (enabled: boolean | undefined) => {
    if (interaction && enabled !== undefined && interaction.useSystemTicker !== enabled)
      interaction.useSystemTicker = enabled
  }
  const synchronizeVisibility = () => {
    if (destroyed)
      return
    const visible = !visibility.hidden
    if (running === visible)
      return
    running = visible
    if (visible) {
      setInteractionTicker(originalInteractionTicker)
      // PIXI Ticker.start resets its first RAF timestamp. Do not add the time
      // spent hidden to the model, audio timeline, or physics simulation.
      app.start()
    }
    else {
      app.stop()
      setInteractionTicker(false)
    }
  }

  app.ticker.add(updateModel, app, priority)
  visibility.addEventListener('visibilitychange', synchronizeVisibility)
  synchronizeVisibility()

  return {
    destroy() {
      if (destroyed)
        return
      destroyed = true
      running = false
      visibility.removeEventListener('visibilitychange', synchronizeVisibility)
      app.ticker.remove(updateModel, app)
      app.stop()
      // Restore only this instance's original policy before the owner disposes
      // its renderer; never force an originally manual interaction loop on.
      setInteractionTicker(originalInteractionTicker)
    },
  }
}
