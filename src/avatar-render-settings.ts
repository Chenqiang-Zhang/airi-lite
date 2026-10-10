import type { AvatarRenderProfile } from './avatar-rendering'

export const AVATAR_RENDER_STORAGE_KEY = 'airi-lite:avatar-render:v1'

interface StorageLike {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

function browserStorage(): StorageLike | undefined {
  return typeof window === 'undefined' ? undefined : window.localStorage
}

export function isAvatarRenderProfile(value: unknown): value is AvatarRenderProfile {
  return value === 'auto' || value === 'economy'
}

export function loadAvatarRenderProfile(storage?: StorageLike | null): AvatarRenderProfile {
  try {
    const source = storage === undefined ? browserStorage() : storage
    const value = source?.getItem(AVATAR_RENDER_STORAGE_KEY)
    return isAvatarRenderProfile(value) ? value : 'auto'
  }
  catch { return 'auto' }
}

// Only an explicit save writes this preference; it has no voice/cloud effect.
export function saveAvatarRenderProfile(value: AvatarRenderProfile, storage?: StorageLike | null): AvatarRenderProfile {
  if (!isAvatarRenderProfile(value))
    throw new TypeError('未知角色画面模式')
  const source = storage === undefined ? browserStorage() : storage
  if (!source)
    throw new Error('此浏览器暂不能保存角色画面模式')
  source.setItem(AVATAR_RENDER_STORAGE_KEY, value)
  return value
}
