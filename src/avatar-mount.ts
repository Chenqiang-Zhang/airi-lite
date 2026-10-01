// Own resources across an async model load. The dependency's loader is not
// abortable: cancellation releases the canvas immediately and adopts/disposes
// a model that arrives later instead of letting it revive an unmounted view.
export function createAvatarMountScope(
  signal?: AbortSignal,
  onCleanupError: (error: unknown) => void = error => console.warn('Live2D cleanup failed', error),
) {
  let disposed = false
  const cleanups: Array<() => void> = []
  const release = (cleanup: () => void) => {
    try { cleanup() }
    catch (error) {
      // One broken resource must not prevent the remaining resources releasing,
      // and cleanup must not replace the original loading error.
      try { onCleanupError(error) }
      catch { /* A diagnostic callback cannot interrupt disposal. */ }
    }
  }
  function dispose() {
    if (disposed) return
    disposed = true
    signal?.removeEventListener('abort', dispose)
    for (const cleanup of cleanups.splice(0).reverse()) release(cleanup)
  }
  signal?.addEventListener('abort', dispose, { once: true })
  if (signal?.aborted) dispose()
  return {
    get disposed() { return disposed },
    own(cleanup: () => void) {
      if (disposed) release(cleanup)
      else cleanups.push(cleanup)
    },
    assertActive() {
      if (signal?.aborted) dispose()
      if (disposed) throw new DOMException('Live2D mount canceled', 'AbortError')
    },
    dispose,
  }
}

export async function loadAvatarResource<T>(
  scope: ReturnType<typeof createAvatarMountScope>,
  create: () => T,
  initialize: (resource: T) => Promise<unknown>,
  release: (resource: T) => void,
): Promise<T> {
  scope.assertActive()
  const resource = create()
  let settled = false, released = false
  const cleanup = () => {
    // Destroying an object while its loader still writes into it is unsafe.
    // Retain its handle, including partially initialized rejection cases.
    if (!settled || released) return
    released = true
    release(resource)
  }
  scope.own(cleanup)
  try {
    await initialize(resource)
    settled = true
    if (scope.disposed) scope.own(cleanup)
    scope.assertActive()
    return resource
  }
  catch (error) {
    settled = true
    if (scope.disposed) scope.own(cleanup)
    scope.dispose()
    throw error
  }
}

interface AvatarModelResource {
  internalModel?: unknown
  autoUpdate: boolean
  emit: (event: string) => unknown
  unregisterInteraction: () => void
  destroy: () => void
}

export function releaseAvatarModel(model: AvatarModelResource, destroyContainer: () => void) {
  if (model.internalModel) {
    // PIXI's URL cache owns these shared CPU textures. A canceled old model
    // must not destroy texture/baseTexture used by a new mount of the same URL.
    model.destroy()
  }
  else {
    // pixi-live2d-display 0.4's destroy unconditionally dereferences
    // internalModel; JSON/moc failure can precede its assignment.
    model.emit('destroy')
    model.autoUpdate = false
    model.unregisterInteraction()
    destroyContainer()
  }
}

export function releaseAvatarRendererTextures<T>(system: {
  managedTextures: readonly T[]
  destroyTexture: (texture: T) => void
}) {
  const errors: unknown[] = []
  // PIXI6 renderer.destroy alone leaves cached base textures' context entries
  // and dispose listeners. destroyTexture clears only THIS renderer's GPU copy,
  // not the shared BaseTexture. Iterate a copy: the system mutates its list.
  for (const texture of [...system.managedTextures]) {
    try { system.destroyTexture(texture) }
    catch (error) { errors.push(error) }
  }
  if (errors.length) throw new AggregateError(errors, 'Live2D GPU cleanup failed')
}
