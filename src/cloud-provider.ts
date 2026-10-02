import { resolveSpeechMode } from './speech-mode.ts'
import type { DeviceHints, SpeechMode } from './speech-mode.ts'

export type CloudSpeechProvider = 'minimax' | 'elevenlabs' | 'unavailable'
type SelectedCloudProvider = Exclude<CloudSpeechProvider, 'unavailable'>
export const CLOUD_PROVIDER_CONSENT_KEY = 'airi-lite:cloud-provider:v1'

interface StorageLike {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

const isSelectedProvider = (value: unknown): value is SelectedCloudProvider => value === 'minimax' || value === 'elevenlabs'
const browserStorage = () => typeof window === 'undefined' ? undefined : window.localStorage

export function loadCloudProviderConsent(storage?: StorageLike | null): SelectedCloudProvider | null {
  try {
    const source = storage === undefined ? browserStorage() : storage
    const saved = source?.getItem(CLOUD_PROVIDER_CONSENT_KEY)
    return isSelectedProvider(saved) ? saved : null
  }
  catch { return null }
}

// Only call when a visitor explicitly saves voice settings. Detection does not
// write consent, and a legacy "cloud" preference is not consent to a new vendor.
export function saveCloudProviderConsent(value: SelectedCloudProvider | null, storage?: StorageLike | null) {
  if (value !== null && !isSelectedProvider(value)) throw new TypeError('未知云端供应商')
  const source = storage === undefined ? browserStorage() : storage
  if (!source) throw new Error('此浏览器暂不能保存云端语音确认')
  source.setItem(CLOUD_PROVIDER_CONSENT_KEY, value ?? '')
  return value
}

export interface CloudSpeechService {
  configured: boolean
  provider: CloudSpeechProvider
  label: string
  model: string
}

export function readCloudSpeechService(value: unknown): CloudSpeechService {
  const unavailable: CloudSpeechService = { configured: false, provider: 'unavailable', label: '云端语音', model: '' }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unavailable
  const status = value as Record<string, unknown>
  if (status.provider === 'minimax' && typeof status.model === 'string'
    && ['speech-2.8-hd', 'speech-2.8-turbo'].includes(status.model))
    return { configured: status.configured === true, provider: 'minimax', label: 'MiniMax', model: status.model }
  if (status.provider === 'elevenlabs' && status.model === 'eleven_v4')
    return { configured: status.configured === true, provider: 'elevenlabs', label: 'ElevenLabs', model: status.model }
  return unavailable
}

export function resolveConsentedSpeechMode(mode: SpeechMode, hints: DeviceHints,
  service: CloudSpeechService, consent: SelectedCloudProvider | null) {
  if (mode === 'cloud' && service.configured && service.provider !== consent)
    return { engine: 'browser' as const,
      notice: '云端供应商已变更或尚未确认，暂用轻量语音；请重新选择并保存云端设置，不会自动调用新供应商。' }
  return resolveSpeechMode(mode, hints, service.configured && service.provider === consent)
}
