import * as PIXI from 'pixi.js'
import { Live2DFactory, Live2DModel, MotionPriority } from 'pixi-live2d-display/cubism4'
import type { Cubism4InternalModel } from 'pixi-live2d-display/cubism4'
import type { Act } from '../shared/performance-cues.mjs'
import { attachAvatarPerformance } from './avatar-performance'
import type { AvatarDebug } from './avatar-performance'
import type { MotionPort } from './avatar-motion'
import { createAvatarMountScope, loadAvatarResource, releaseAvatarModel, releaseAvatarRendererTextures } from './avatar-mount'
import { parseAvatarProfile, resolveAvatarProfile } from './avatar-profile'
import type { AvatarProfile } from './avatar-profile'
import profileJson from './avatar-profiles/active.json'
import { applyAvatarRenderBudget, attachAvatarRenderLoop, resolveAvatarRenderBudget } from './avatar-rendering'
import type { AvatarRenderProfile } from './avatar-rendering'
import type { Delivery } from './delivery'
import { readDeviceHints } from './speech-mode'
import type { DeviceHints } from './speech-mode'

// The tracked profile is bundled into this lazily loaded chunk: an unhashed
// JSON file would stay stale behind the server's immutable caching.
const parsedProfile = parseAvatarProfile(profileJson)

export interface AvatarParameterReading {
  id: string
  min: number
  max: number
  default: number
  // As rendered this frame, after the performance layer; null until sampled.
  value: number | null
}

// Per-instance wrapper around a library method. The restore only undoes our
// own wrapper, so a later wrapper is never clobbered.
function overrideMethod<K extends string, F extends (...args: never[]) => unknown>(target: Record<K, F>, key: K, wrap: (original: F) => F) {
  const original = target[key]
  const own = Object.hasOwn(target, key)
  const wrapped = wrap(original)
  target[key] = wrapped
  return () => {
    if (target[key] !== wrapped) return
    if (own) target[key] = original
    else Reflect.deleteProperty(target, key)
  }
}

// Problem lists are capped with a closing "and N more problems" entry.
function countProblems(problems: readonly string[]) {
  return problems.reduce((total, problem) => total + (Number(/^and (\d+) more problems$/.exec(problem)?.[1]) || 1), 0)
}

// autoInteract:false is for the OBS stage, which nobody clicks: no pointer
// tracking and no Tap motion that a stray "Interact" click could trigger.
// fixedFPS is also the stage's: a frame rate that profiles never change.
// The name stays mountHiyori in P3; the model itself comes from the profile.
export async function mountHiyori(container: HTMLElement, options: { signal?: AbortSignal, deviceHints?: DeviceHints, renderProfile?: AvatarRenderProfile, autoInteract?: boolean, fixedFPS?: 30 | 60 } = {}) {
  const autoInteract = options.autoInteract ?? true
  const scope = createAvatarMountScope(options.signal)
  try {
    scope.assertActive()
    Object.assign(window, { PIXI })
    const deviceHints = options.deviceHints ?? readDeviceHints()
    let renderBudget = resolveAvatarRenderBudget(deviceHints, window.devicePixelRatio, options.renderProfile, options.fixedFPS)
    const contextAntialias = renderBudget.antialias
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

    const parsed = parsedProfile.profile
    const modelOptions = { autoInteract, autoUpdate: false }
    const model = await loadAvatarResource(scope, () => new Live2DModel(modelOptions),
      model => Live2DFactory.setupLive2DModel(model, `${import.meta.env.BASE_URL}${parsed.model}`, modelOptions),
      model => releaseAvatarModel(model, () => PIXI.Container.prototype.destroy.call(model, { children: false })))
    model.anchor.set(0.5, 1)
    app.stage.addChild(model)
    const naturalWidth = model.width
    const naturalHeight = model.height

    const internal = model.internalModel as Cubism4InternalModel
    const core = internal.coreModel
    const manager = internal.motionManager
    // Read the model's own id list: getParameterIndex would allocate a
    // dummy slot for every unknown id it is asked about.
    const parameterIds = core.getModel().parameters.ids
    const knownIds = new Set(parameterIds)
    const resolved = resolveAvatarProfile(parsed, {
      hasParameter: id => knownIds.has(id),
      motionCount: group => manager.definitions[group]?.length ?? 0,
    })
    const profile: AvatarProfile = resolved.profile
    const problems = [...parsedProfile.problems, ...resolved.problems]
    if (problems.length) console.warn(`Avatar profile "${profile.id}": ${countProblems(problems)} problem(s); defaults used`, problems)

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
      // This crops the camera view; it does not change the model's artwork.
      const portrait = height < 420 && width > height * 1.1
      const framing = profile.layout
      const scale = Math.min(width * framing.fitWidth / naturalWidth,
        height * (portrait ? framing.portraitFitHeight : framing.fitHeight) / naturalHeight)
      model.scale.set(scale)
      model.x = width / 2
      model.y = height * (portrait ? framing.portraitAnchorY : framing.anchorY)
    }
    const observer = new ResizeObserver(layout)
    scope.own(() => observer.disconnect())
    observer.observe(container)
    layout()

    const port: MotionPort = {
      busy: () => manager.state.currentPriority > MotionPriority.IDLE || manager.state.reservePriority > MotionPriority.IDLE,
      play: (group, index, force) => scope.disposed
        ? Promise.resolve(false)
        : manager.startMotion(group, index, force ? MotionPriority.FORCE : MotionPriority.NORMAL),
      failed: (group, index) => manager.motionGroups[group]?.[index] === null,
      current: () => {
        const { currentGroup, currentIndex, currentPriority } = manager.state
        return currentGroup === undefined || currentIndex === undefined ? null : { group: currentGroup, index: currentIndex, priority: currentPriority }
      },
      stop: () => manager.stopAllMotions(),
      count: group => manager.definitions[group]?.length ?? 0,
    }
    // Hair follows the sway and tilt: the pose runs right after breath and
    // before physics. Without the method the pose falls back to post-physics.
    const naturalMovements = internal as unknown as Record<'updateNaturalMovements', (dt: number, now: number) => void>
    const prePhysics = typeof naturalMovements.updateNaturalMovements === 'function'
      ? (listener: () => void) => overrideMethod(naturalMovements, 'updateNaturalMovements', original => function (this: unknown, dt: number, now: number) {
          original.call(this, dt, now)
          listener()
        })
      : undefined

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const actor = attachAvatarPerformance(internal, {
      reducedMotion: () => reducedMotion.matches,
      profile,
      prePhysics,
      motions: port,
    })
    scope.own(actor.destroy)

    // While she thinks or speaks, the library's Idle pick goes through the
    // profile's weights; null (or no override) keeps its uniform pick.
    const randomMotion = manager as unknown as Record<'startRandomMotion', (group: string, priority?: MotionPriority) => Promise<boolean>>
    if (typeof randomMotion.startRandomMotion === 'function') {
      scope.own(overrideMethod(randomMotion, 'startRandomMotion', original => function (this: unknown, group: string, priority?: MotionPriority) {
        const count = manager.definitions[group]?.length ?? 0
        const index = priority === MotionPriority.IDLE && count > 0 ? actor.idleIndex(group, count) : null
        return index === null ? original.call(this, group, priority) : manager.startMotion(group, index, priority)
      }))
    }

    // Load every referenced gesture now, so the first one never waits on a fetch.
    const { motions } = profile
    const triggers = [motions.tap, motions.turnStart, ...Object.values(motions.emotions ?? {}), ...Object.values(motions.acts ?? {})]
    const preload = new Set<string>()
    for (const trigger of triggers) {
      for (const ref of trigger?.motions ?? []) {
        const key = `${ref.group}\u0000${ref.index}`
        if (ref.index === undefined || preload.has(key)) continue
        preload.add(key)
        void manager.loadMotion(ref.group, ref.index).catch(() => {})
      }
    }

    if (autoInteract) {
      model.on('hit', () => {
        if (!scope.disposed) void actor.tap()
      })
    }

    // Debug readout only: sampled after the performance layer, so it shows
    // what is rendered. Installed on first use; the stream never pays for it.
    let sampled: Float32Array | null = null
    let sampling = false
    const sample = () => {
      const values = sampled ?? new Float32Array(parameterIds.length)
      for (let index = 0; index < parameterIds.length; index++) values[index] = core.getParameterValueByIndex(index)
      sampled = values
    }

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
      // A new reply: resets the gesture count and the tone dedupe.
      beginTurn: actor.beginTurn,
      cueTone: (delivery: Delivery) => actor.cueTone(delivery),
      performAct: (act: Act) => actor.performAct(act),
      // Without force: NORMAL, refused under reduced motion or during a gesture.
      // force is the debug panel's (the library still refuses the motion playing).
      playMotion: (group: string, index?: number, mode: { force?: boolean } = {}) =>
        scope.disposed ? Promise.resolve(false) : actor.playMotion(group, index, mode),
      stopMotions() {
        if (!scope.disposed) manager.stopAllMotions()
      },
      motionGroups(): Record<string, number> {
        return Object.fromEntries(Object.entries(manager.definitions).map(([group, list]) => [group, list?.length ?? 0]))
      },
      inspect: actor.inspect,
      setDebug: (debug: AvatarDebug) => actor.setDebug(debug),
      parameters(): AvatarParameterReading[] {
        if (!sampling && !scope.disposed) {
          sampling = true
          internal.on('beforeModelUpdate', sample)
          scope.own(() => internal.off('beforeModelUpdate', sample))
        }
        const table = core.getModel().parameters
        return parameterIds.map((id, index) => ({
          id,
          min: table.minimumValues[index],
          max: table.maximumValues[index],
          default: table.defaultValues[index],
          value: sampled ? sampled[index] : null,
        }))
      },
      profile: { id: profile.id, name: profile.name, problems, problemCount: countProblems(problems) },
      get renderBudget() { return { ...renderBudget } },
      setRenderProfile(profile: AvatarRenderProfile) {
        if (!scope.disposed) {
          const next = resolveAvatarRenderBudget(deviceHints, window.devicePixelRatio, profile, options.fixedFPS)
          applyAvatarRenderBudget(app, next)
          // Keep an honest report of the existing WebGL context's AA policy.
          renderBudget = { ...next, antialias: contextAntialias }
        }
        return { ...renderBudget }
      },
      destroy: scope.dispose,
    }
  }
  catch (error) {
    scope.dispose()
    throw error
  }
}
