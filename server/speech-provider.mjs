import { readMinimaxConfig, synthesiseMinimax } from './minimax.mjs'
import { estimateElevenLabsReservation, readElevenLabsConfig, synthesiseElevenLabs } from './elevenlabs.mjs'

const MINIMAX_MODELS = new Set(['speech-2.8-hd', 'speech-2.8-turbo'])
const unavailable = Object.freeze({
  configured: false, provider: 'unavailable', model: '', ledgerFilename: 'tts-budget-unavailable.json',
})

export function readSpeechConfig(env = process.env) {
  // An absent selection preserves the existing MiniMax deployment. A typo must
  // fail closed, never silently activate a different configured paid provider.
  const provider = env.TTS_PROVIDER?.trim() || 'minimax'
  if (provider === 'minimax')
    return Object.freeze({ ...readMinimaxConfig(env), provider })
  if (provider === 'elevenlabs')
    return readElevenLabsConfig(env)
  return Object.freeze({ configured: false, provider: 'unavailable', model: '', dailyLimit: 0 })
}

export function resolveSpeechProvider(config) {
  // Configs injected by existing MiniMax tests/tools predate provider selection.
  const provider = config?.provider ?? 'minimax'
  if (provider === 'minimax' && MINIMAX_MODELS.has(config?.model)) {
    return {
      configured: config.configured === true, provider, model: config.model,
      ledgerFilename: 'tts-budget.json',
      estimateReservation: (_config, request) => 2 * request.text.length,
      synthesise: synthesiseMinimax,
    }
  }
  if (provider === 'elevenlabs' && config?.model === 'eleven_v4') {
    return {
      configured: config.configured === true, provider, model: config.model,
      ledgerFilename: 'tts-budget-elevenlabs.json',
      estimateReservation: estimateElevenLabsReservation,
      synthesise: synthesiseElevenLabs,
    }
  }
  return unavailable
}
