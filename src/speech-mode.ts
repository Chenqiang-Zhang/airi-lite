export type SpeechMode = 'auto' | 'local' | 'browser' | 'cloud'
export type SpeechEngine = 'local' | 'browser' | 'cloud'

export const DEFAULT_SPEECH_MODE: SpeechMode = 'auto'
export const SPEECH_MODE_STORAGE_KEY = 'airi-lite:speech-mode:v1'

interface StorageLike {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

export interface DeviceHints {
  memoryGB?: number
  cores?: number
  saveData?: boolean
  hasWebGPU?: boolean
}

function browserStorage(): StorageLike | undefined {
  return typeof window === 'undefined' ? undefined : window.localStorage
}

export function isSpeechMode(value: unknown): value is SpeechMode {
  return value === 'auto' || value === 'local' || value === 'browser' || value === 'cloud'
}

export function loadSpeechMode(storage?: StorageLike | null): SpeechMode {
  try {
    const source = storage === undefined ? browserStorage() : storage
    const saved = source?.getItem(SPEECH_MODE_STORAGE_KEY)
    return isSpeechMode(saved) ? saved : DEFAULT_SPEECH_MODE
  }
  catch {
    return DEFAULT_SPEECH_MODE
  }
}

// Call only for an explicit user choice. Detection/resolution never persists it.
export function saveSpeechMode(value: SpeechMode, storage?: StorageLike | null): SpeechMode {
  if (!isSpeechMode(value))
    throw new TypeError('未知语音模式')
  const source = storage === undefined ? browserStorage() : storage
  if (!source)
    throw new Error('此浏览器暂不能保存语音模式')
  source.setItem(SPEECH_MODE_STORAGE_KEY, value)
  return value
}

function positiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

// These browser-provided hints stay on this device. Each optional property may
// be missing or have a throwing getter; one failure must not discard the rest.
export function readDeviceHints(navigatorLike?: unknown): DeviceHints {
  let source: unknown
  try {
    source = navigatorLike === undefined
      ? typeof navigator === 'undefined' ? undefined : navigator
      : navigatorLike
  }
  catch {
    return {}
  }
  if (source === null || (typeof source !== 'object' && typeof source !== 'function'))
    return {}

  const device = source as Record<string, unknown>
  const hints: DeviceHints = {}
  try {
    const memory = device.deviceMemory
    if (positiveNumber(memory)) hints.memoryGB = memory
  }
  catch { /* Unknown memory must not imply a slow device. */ }
  try {
    const cores = device.hardwareConcurrency
    if (positiveNumber(cores)) hints.cores = cores
  }
  catch { /* Keep other available hints. */ }
  try {
    const connection = device.connection
    if (connection !== null && typeof connection === 'object') {
      const saveData = (connection as Record<string, unknown>).saveData
      if (typeof saveData === 'boolean') hints.saveData = saveData
    }
  }
  catch { /* A connection getter may be restricted by the browser. */ }
  try {
    const gpu = device.gpu
    if (gpu === undefined || gpu === null)
      hints.hasWebGPU = false
    else if (typeof gpu === 'object' || typeof gpu === 'function')
      hints.hasWebGPU = true
  }
  catch { /* A failed support check is unknown, not unsupported. */ }
  return hints
}

const browserNotice = '浏览器语音无需下载 Kokoro，使用系统可用声线；音色因设备而异，情绪自然度无法保证。'

// A conservative heuristic, not a benchmark. Cloud is never an automatic
// fallback: only an explicit cloud choice plus configured availability enables it.
export function resolveSpeechMode(
  mode: SpeechMode,
  hints: DeviceHints = {},
  cloudAvailable = false,
): { engine: SpeechEngine, notice: string } {
  if (mode === 'local') {
    return {
      engine: 'local',
      notice: '已选择本地 Kokoro，保留固定声线；首次使用需下载模型，速度取决于设备。',
    }
  }
  if (mode === 'browser')
    return { engine: 'browser', notice: `已选择轻量浏览器语音。${browserNotice}` }
  if (mode === 'cloud') {
    if (cloudAvailable === true) {
      return {
        engine: 'cloud',
        notice: '已按你的选择使用云端语音；待合成的文字会发送到已配置的云服务。',
      }
    }
    return {
      engine: 'browser',
      notice: `云端语音服务尚未启用，暂用轻量浏览器语音；不会调用云端接口或下载本地大模型。${browserNotice}`,
    }
  }

  const reasons: string[] = []
  if (hints.saveData === true) reasons.push('已开启节省流量')
  if (positiveNumber(hints.memoryGB) && hints.memoryGB <= 4) reasons.push('设备报告内存不超过 4 GB')
  if (positiveNumber(hints.cores) && hints.cores <= 2) reasons.push('设备报告处理器核心数不超过 2')
  if (hints.hasWebGPU === false) reasons.push('浏览器未提供 WebGPU')
  if (reasons.length) {
    return {
      engine: 'browser',
      notice: `${reasons.join('、')}，自动选择轻量浏览器语音。${browserNotice}这是设备信息启发式选择，不是真实测速。`,
    }
  }
  return {
    engine: 'local',
    notice: '按当前可用信息默认使用本地 Kokoro，保留固定声线；首次使用需下载模型，实际速度取决于设备。这是设备信息启发式选择，不是真实测速。',
  }
}
