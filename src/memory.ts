export const USER_MEMORY_STORAGE_KEY = 'airi-lite:user-memory:v1'
export const USER_MEMORY_LIMIT = 1200

interface StorageLike {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

function browserStorage(): StorageLike {
  return window.localStorage
}

export function loadUserMemory(storage: StorageLike = browserStorage()): string {
  try {
    return (storage.getItem(USER_MEMORY_STORAGE_KEY) ?? '').trim().slice(0, USER_MEMORY_LIMIT)
  }
  catch {
    return ''
  }
}

export function saveUserMemory(value: string, storage: StorageLike = browserStorage()): string {
  const memory = value.trim().slice(0, USER_MEMORY_LIMIT)
  if (memory)
    storage.setItem(USER_MEMORY_STORAGE_KEY, memory)
  else
    storage.removeItem(USER_MEMORY_STORAGE_KEY)
  return memory
}

export function clearUserMemory(storage: StorageLike = browserStorage()): void {
  storage.removeItem(USER_MEMORY_STORAGE_KEY)
}
