export const CUBISM_RUNTIME_URL = 'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js'
export const CUBISM_RUNTIME_TIMEOUT_MS = 15_000

type RuntimeErrorCode = 'CUBISM_LOAD_FAILED' | 'CUBISM_LOAD_TIMEOUT' | 'CUBISM_INVALID_CORE'

export class CubismRuntimeError extends Error {
  readonly code: RuntimeErrorCode

  constructor(code: RuntimeErrorCode, message: string) {
    super(message)
    this.name = 'CubismRuntimeError'
    this.code = code
  }
}

const REQUIRED_CORE_METHODS: Record<string, readonly string[]> = {
  Version: ['csmGetVersion'],
  Logging: ['csmGetLogFunction', 'csmSetLogFunction'],
  Moc: ['fromArrayBuffer'],
  Model: ['fromMoc'],
  Utils: [
    'hasBlendAdditiveBit', 'hasBlendMultiplicativeBit', 'hasIsDoubleSidedBit',
    'hasIsInvertedMaskBit', 'hasIsVisibleBit', 'hasOpacityDidChangeBit',
    'hasRenderOrderDidChangeBit', 'hasVertexPositionsDidChangeBit',
    'hasVisibilityDidChangeBit',
  ],
}

// A truthy global or a script load event is not enough. These are the Core
// methods actually consumed by our installed pixi-live2d-display/cubism4.
// Checking their shape does not start the framework or call native/WASM code.
export function isCubismRuntimeReady(core: unknown): boolean {
  try {
    if (!core || (typeof core !== 'object' && typeof core !== 'function')) return false
    for (const [namespace, methods] of Object.entries(REQUIRED_CORE_METHODS)) {
      const group = (core as Record<string, unknown>)[namespace]
      if (!group || (typeof group !== 'object' && typeof group !== 'function')) return false
      if (methods.some(method => typeof (group as Record<string, unknown>)[method] !== 'function')) return false
    }
    return true
  }
  catch { return false }
}

function canceled(): DOMException {
  return new DOMException('Live2D startup canceled', 'AbortError')
}

// Only the consumer's wait is cancelable. A dynamic import, or a shared Core
// script that has already started, cannot be canceled by this helper. Observe
// its late fulfillment/rejection without exposing a result to a canceled view.
// Resource-producing callers still own disposal of any late resource.
export function waitForAvatarWork<T>(start: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(canceled())
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      try { signal?.removeEventListener('abort', onAbort) }
      catch { /* Listener cleanup must not replace the operation's result. */ }
    }
    const finish = (succeeded: boolean, value: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      if (succeeded) resolve(value as T)
      else reject(value)
    }
    const onAbort = () => finish(false, canceled())
    signal?.addEventListener('abort', onAbort, { once: true })
    if (settled || signal?.aborted) {
      onAbort()
      return
    }
    try {
      Promise.resolve(start()).then(
        value => signal?.aborted ? onAbort() : finish(true, value),
        error => signal?.aborted ? onAbort() : finish(false, error),
      )
    }
    catch (error) { finish(false, error) }
  })
}

interface RuntimeScript {
  src: string
  async: boolean
  addEventListener: (event: 'load' | 'error', callback: () => void) => void
  removeEventListener: (event: 'load' | 'error', callback: () => void) => void
  remove: () => void
}

interface RuntimeLoaderDependencies<Script extends RuntimeScript> {
  createScript: () => Script
  appendScript: (script: Script) => void
  readCore: () => unknown
  // Return a timer disposer; an opaque timer ID never crosses this boundary.
  scheduleTimeout: (callback: () => void, milliseconds: number) => () => void
}

export interface CubismRuntimeLoadOptions {
  signal?: AbortSignal
}

export function createCubismRuntimeLoader<Script extends RuntimeScript>(dependencies: RuntimeLoaderDependencies<Script>) {
  let pending: Promise<void> | null = null
  const ready = () => {
    try { return isCubismRuntimeReady(dependencies.readCore()) }
    catch { return false }
  }
  const startSharedLoad = (): Promise<void> => {
    if (pending) return pending
    if (ready()) return Promise.resolve()

    let resolve!: () => void
    let reject!: (error: unknown) => void
    const task = new Promise<void>((yes, no) => { resolve = yes; reject = no })
    pending = task
    // Register both branches before touching the DOM: even synchronous DOM
    // failures or an abandoned shared request have an observed rejection.
    const reset = () => { if (pending === task) pending = null }
    void task.then(reset, reset)

    let script: Script | null = null
    let cancelDeadline: (() => void) | null = null
    let settled = false
    const attempt = (cleanup: () => void) => {
      try { cleanup() }
      catch { /* Continue releasing the other independently owned resources. */ }
    }
    const finish = (error?: CubismRuntimeError) => {
      if (settled) return
      settled = true
      if (script) {
        const ownedScript = script
        attempt(() => ownedScript.removeEventListener('load', onLoad))
        attempt(() => ownedScript.removeEventListener('error', onError))
        // Removing a failed tag is cleanup, not a guarantee that a fetched
        // classic script can never execute later. Core readiness is rechecked
        // on every retry, and late callbacks cannot settle a newer attempt.
        if (error) attempt(() => ownedScript.remove())
      }
      if (cancelDeadline) attempt(cancelDeadline)
      cancelDeadline = null
      if (error) reject(error)
      else resolve()
    }
    const onLoad = () => {
      if (settled) return
      finish(ready() ? undefined
        : new CubismRuntimeError('CUBISM_INVALID_CORE', 'Live2D Core loaded without the required runtime methods'))
    }
    const onError = () => finish(new CubismRuntimeError('CUBISM_LOAD_FAILED', 'Live2D Core could not be loaded'))

    try {
      script = dependencies.createScript()
      script.src = CUBISM_RUNTIME_URL
      script.async = true
      script.addEventListener('load', onLoad)
      script.addEventListener('error', onError)
      const disposeTimer = dependencies.scheduleTimeout(() => finish(
        new CubismRuntimeError('CUBISM_LOAD_TIMEOUT', 'Live2D Core loading timed out'),
      ), CUBISM_RUNTIME_TIMEOUT_MS)
      // Controlled test schedulers may fire synchronously. Do not retain a
      // timer or append a tag after that attempt has already timed out.
      if (settled) attempt(disposeTimer)
      else {
        cancelDeadline = disposeTimer
        dependencies.appendScript(script)
      }
    }
    catch { onError() }
    return task
  }
  return (options: CubismRuntimeLoadOptions = {}): Promise<void> => waitForAvatarWork(startSharedLoad, options.signal)
}

let browserLoader: ReturnType<typeof createCubismRuntimeLoader> | null = null

// Importing this module in Node does not read window/document, create a script,
// or start a timer. Even an already-aborted call avoids browser initialization.
export function loadCubismRuntime(options: CubismRuntimeLoadOptions = {}): Promise<void> {
  if (options.signal?.aborted) return Promise.reject(canceled())
  if (!browserLoader) {
    browserLoader = createCubismRuntimeLoader({
      createScript: () => document.createElement('script'),
      appendScript: script => { document.head.appendChild(script) },
      readCore: () => (window as Window & { Live2DCubismCore?: unknown }).Live2DCubismCore,
      scheduleTimeout: (callback, milliseconds) => {
        const timer = window.setTimeout(callback, milliseconds)
        return () => window.clearTimeout(timer)
      },
    })
  }
  return browserLoader(options)
}
