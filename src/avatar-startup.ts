import { loadCubismRuntime, waitForAvatarWork } from './cubism-runtime.ts'

// This type-only reference must not pull Pixi/Cubism into the chat entry chunk.
type AvatarModule = Pick<typeof import('./live2d'), 'mountHiyori'>
interface AvatarStartupDependencies {
  loadCore?: (options: { signal?: AbortSignal }) => Promise<void>
  importAvatar?: () => Promise<AvatarModule>
}

export function createAvatarModuleLoader(dependencies: AvatarStartupDependencies = {}) {
  const loadCore = dependencies.loadCore ?? loadCubismRuntime
  const importAvatar = dependencies.importAvatar ?? (() => import('./live2d'))
  return async (options: { signal?: AbortSignal } = {}): Promise<AvatarModule> => {
    // The plugin checks Core during module evaluation, before mountHiyori runs.
    // Never start import in parallel with Core. Cancel waiting promptly, but
    // still observe any non-abortable script/import work that settles later.
    await waitForAvatarWork(() => loadCore(options), options.signal)
    return waitForAvatarWork(importAvatar, options.signal)
  }
}

export const loadAvatarModule = createAvatarModuleLoader()
