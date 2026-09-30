export const VOICE_STORAGE_KEY = 'airi-lite:voice:v1'

export const VOICE_OPTIONS = [
  { id: 'zf_001', label: '声线 A', description: '原来的默认声线' },
  { id: 'zf_002', label: '声线 B', description: '免费中文女声预设' },
  { id: 'zf_003', label: '声线 C', description: '免费中文女声预设' },
] as const

export type VoiceId = typeof VOICE_OPTIONS[number]['id']
export const DEFAULT_VOICE: VoiceId = 'zf_001'

interface StorageLike {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

function browserStorage(): StorageLike {
  return window.localStorage
}

export function isVoiceId(value: unknown): value is VoiceId {
  return VOICE_OPTIONS.some(option => option.id === value)
}

export function loadVoice(storage: StorageLike = browserStorage()): VoiceId {
  try {
    const saved = storage.getItem(VOICE_STORAGE_KEY)
    return isVoiceId(saved) ? saved : DEFAULT_VOICE
  }
  catch {
    return DEFAULT_VOICE
  }
}

export function saveVoice(value: VoiceId, storage: StorageLike = browserStorage()): VoiceId {
  if (!isVoiceId(value))
    throw new TypeError('未知声线')
  storage.setItem(VOICE_STORAGE_KEY, value)
  return value
}
