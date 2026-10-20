import { resolveSpeechMode } from './speech-mode.ts'
import type { DeviceHints, SpeechMode } from './speech-mode.ts'

export type CloudSpeechProvider = 'minimax' | 'elevenlabs' | 'local' | 'unavailable'
export type MinimaxRegion = 'cn' | 'global'
export type CloudSpeechScope = 'minimax:cn' | 'minimax:global' | 'elevenlabs' | 'local'
export const CLOUD_PROVIDER_CONSENT_KEY = 'airi-lite:cloud-provider:v2'
export const LEGACY_CLOUD_PROVIDER_CONSENT_KEY = 'airi-lite:cloud-provider:v1'

interface StorageLike {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

const isSelectedScope = (value: unknown): value is CloudSpeechScope =>
  value === 'minimax:cn' || value === 'minimax:global' || value === 'elevenlabs' || value === 'local'
// Same pattern the server applies to LOCAL_TTS_MODEL; anything else is unknown.
const LOCAL_MODEL = /^[A-Za-z0-9][\w.:/@+-]{0,127}$/
const browserStorage = () => typeof window === 'undefined' ? undefined : window.localStorage

export function loadCloudProviderConsent(storage?: StorageLike | null): CloudSpeechScope | null {
  try {
    const source = storage === undefined ? browserStorage() : storage
    const saved = source?.getItem(CLOUD_PROVIDER_CONSENT_KEY)
    // An explicit v2 clear or corrupt value must not resurrect a legacy grant.
    if (saved !== null && saved !== undefined)
      return isSelectedScope(saved) ? saved : null
    const legacy = source?.getItem(LEGACY_CLOUD_PROVIDER_CONSENT_KEY)
    // Before region selection existed, MiniMax always meant the cn endpoint.
    // Reading this migration never writes consent or authorizes global.
    return legacy === 'minimax' ? 'minimax:cn' : legacy === 'elevenlabs' ? 'elevenlabs' : null
  }
  catch { return null }
}

// Only call when a visitor explicitly saves voice settings. Detection does not
// write consent, and a legacy "cloud" preference is not consent to a new vendor.
export function saveCloudProviderConsent(value: CloudSpeechScope | null, storage?: StorageLike | null) {
  if (value !== null && !isSelectedScope(value)) throw new TypeError('未知云端供应商或地区')
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
  region: MinimaxRegion | null
  scope: CloudSpeechScope | null
}

export function readCloudSpeechService(value: unknown): CloudSpeechService {
  const unavailable: CloudSpeechService = {
    configured: false, provider: 'unavailable', label: '云端语音', model: '', region: null, scope: null,
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unavailable
  const status = value as Record<string, unknown>
  if (status.provider === 'minimax' && typeof status.model === 'string'
    && ['speech-2.8-hd', 'speech-2.8-turbo'].includes(status.model)) {
    // Missing region comes only from the older cn-only health contract.
    const region = status.region === undefined ? 'cn' : status.region
    if (region !== 'cn' && region !== 'global') return unavailable
    return {
      configured: status.configured === true, provider: 'minimax',
      label: region === 'cn' ? 'MiniMax · 国内' : 'MiniMax · 国际', model: status.model,
      region, scope: region === 'cn' ? 'minimax:cn' : 'minimax:global',
    }
  }
  if (status.provider === 'elevenlabs' && status.model === 'eleven_v4')
    return {
      configured: status.configured === true, provider: 'elevenlabs', label: 'ElevenLabs',
      model: status.model, region: null, scope: 'elevenlabs',
    }
  // A self-hosted engine on the streamer's own network; still needs consent.
  if (status.provider === 'local' && typeof status.model === 'string' && LOCAL_MODEL.test(status.model))
    return {
      configured: status.configured === true, provider: 'local', label: '自托管语音',
      model: status.model, region: null, scope: 'local',
    }
  return unavailable
}

export function resolveConsentedSpeechMode(mode: SpeechMode, hints: DeviceHints,
  service: CloudSpeechService, consent: CloudSpeechScope | null) {
  if (mode === 'cloud' && service.configured && service.scope !== consent)
    return { engine: 'browser' as const,
      notice: '云端供应商或地区已变更或尚未确认，暂用轻量语音；请重新选择并保存云端设置，不会自动向新地区发送正文。' }
  return resolveSpeechMode(mode, hints, service.configured && service.scope !== null && service.scope === consent)
}
