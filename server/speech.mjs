import { join } from 'node:path'

import { SpeechProviderError } from './speech-error.mjs'
import { readSpeechConfig, resolveSpeechProvider } from './speech-provider.mjs'
import { createTtsBudget, TtsBudgetError } from './tts-budget.mjs'

const DELIVERIES = new Set(['neutral', 'soft', 'bright', 'curious'])
const MAX_REQUEST_BYTES = 4_096
const MESSAGES = {
  TTS_NOT_CONFIGURED: '云端语音未启用或配置不完整。',
  TTS_INVALID_REQUEST: '语音请求格式无效，文字需为 1–360 个 UTF-16 字符。',
  TTS_UNAUTHORIZED: '体验码不正确，请重新输入。',
  TTS_RATE_LIMIT: '语音请求太频繁，请稍后再试。',
  TTS_BUSY: '当前语音请求较多，请稍后再试。',
  TTS_DAILY_LIMIT: '今日云端语音预留额度已用尽。',
  TTS_BUDGET_UNAVAILABLE: '语音额度记录不可用，云端合成已停止。',
  TTS_TIMEOUT: '云端语音合成超时，请稍后再试。',
  TTS_PROVIDER_CHANGED: '云端供应商或地区已变更，请刷新并重新确认语音设置。',
  TTS_UPSTREAM_FAILED: '云端语音服务请求失败。',
  TTS_UPSTREAM_INVALID: '云端语音响应不完整或格式无效。',
}

export function normaliseSpeechRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['text', 'delivery', 'expectedProvider', 'expectedRegion'].includes(key))
    || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 360
    || !value.text.isWellFormed() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.text)
    || !DELIVERIES.has(value.delivery)
    || (Object.hasOwn(value, 'expectedProvider') && !['minimax', 'elevenlabs', 'local'].includes(value.expectedProvider))
    || (Object.hasOwn(value, 'expectedRegion') && (!['cn', 'global'].includes(value.expectedRegion)
      || ['elevenlabs', 'local'].includes(value.expectedProvider))))
    throw new SpeechProviderError('TTS_INVALID_REQUEST')
  return { text: value.text, delivery: value.delivery,
    ...(Object.hasOwn(value, 'expectedProvider') ? { expectedProvider: value.expectedProvider } : {}),
    ...(Object.hasOwn(value, 'expectedRegion') ? { expectedRegion: value.expectedRegion } : {}) }
}

export function createSpeechRateLimiter({ now = Date.now } = {}) {
  const windows = new Map()
  return (ip) => {
    const time = now()
    if (!windows.has(ip) && windows.size >= 2_000) {
      for (const [key, times] of windows) {
        if (time - times.at(-1) >= 10 * 60_000)
          windows.delete(key)
      }
      if (windows.size >= 2_000)
        return false
    }
    const recent = (windows.get(ip) ?? []).filter(value => time - value < 10 * 60_000)
    if (recent.length >= 180 || recent.filter(value => time - value < 60_000).length >= 30)
      return false
    recent.push(time)
    windows.set(ip, recent)
    return true
  }
}

export function createSpeechHandler({
  rootDirectory,
  config = readSpeechConfig(),
  isValidCode = () => true,
  getClientIp = request => request.socket.remoteAddress ?? 'unknown',
  budget,
  fetchImpl = fetch,
  now = Date.now,
  timeoutMs = 30_000,
} = {}) {
  const provider = resolveSpeechProvider(config)
  const selectedBudget = budget ?? createTtsBudget({
    path: join(rootDirectory, '.data', provider.ledgerFilename), dailyLimit: config.dailyLimit,
  })
  const acceptRate = createSpeechRateLimiter({ now })
  let active = 0

  // Provider-specific local estimates are NOT the actual account balance.
  // Eleven's estimate includes the trusted delivery prefix it will send.
  // Keep separate durable ledgers; switching providers never resets one.
  async function reserveAndSynthesise(speechRequest, signal) {
    await selectedBudget.reserve(provider.estimateReservation(config, speechRequest), signal)
    signal.throwIfAborted()
    const result = await provider.synthesise(config, speechRequest, { fetchImpl, signal })
    signal.throwIfAborted()
    return result
  }

  return {
    health: () => ({ configured: provider.configured, provider: provider.provider, model: provider.model,
      ...(provider.provider === 'minimax' ? { region: provider.region } : {}) }),
    // false once the character ledger failed closed (it then refuses until
    // restart); the go-live checklist reports it.
    ledgerHealthy: () => selectedBudget.healthy?.() !== false,
    // Trusted in-process callers (the live stage route) that have already done
    // their own authorisation. Shares the concurrency cap and the same ledger.
    async synthesise({ text, delivery }, { signal } = {}) {
      if (!provider.configured)
        throw new SpeechProviderError('TTS_NOT_CONFIGURED')
      if (active >= 4)
        throw new SpeechProviderError('TTS_BUSY')
      const speechRequest = normaliseSpeechRequest({ text, delivery })
      active++
      const timeout = new AbortController()
      const timer = setTimeout(() => timeout.abort(), timeoutMs)
      timer.unref?.()
      try {
        return await reserveAndSynthesise(speechRequest,
          signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal)
      }
      catch (error) {
        if (timeout.signal.aborted && !signal?.aborted)
          throw new SpeechProviderError('TTS_TIMEOUT')
        throw error
      }
      finally {
        clearTimeout(timer)
        active--
      }
    },
    async handle(request, response) {
      if (!acceptRate(getClientIp(request)))
        return sendError(response, 429, 'TTS_RATE_LIMIT')
      // Reuses the server's timingSafeEqual check; never accept a client token
      // for any speech provider. Only this backend sets provider credentials.
      if (!isValidCode(request.headers['x-demo-access-code']))
        return sendError(response, 401, 'TTS_UNAUTHORIZED')
      if (!provider.configured)
        return sendError(response, 503, 'TTS_NOT_CONFIGURED')
      if (active >= 4)
        return sendError(response, 503, 'TTS_BUSY')

      active++
      const cancelled = new AbortController()
      const timeout = new AbortController()
      const signal = AbortSignal.any([cancelled.signal, timeout.signal])
      const close = () => cancelled.abort()
      const timer = setTimeout(() => timeout.abort(), timeoutMs)
      timer.unref?.()
      response.once('close', close)
      request.once('aborted', close)
      try {
        const speechRequest = normaliseSpeechRequest(await readBoundedJson(request, signal))
        // Legacy clients mean MiniMax, not "whichever paid provider is current".
        // This only compares identity; it cannot select or override the server.
        if ((speechRequest.expectedProvider ?? 'minimax') !== provider.provider)
          throw new SpeechProviderError('TTS_PROVIDER_CHANGED')
        // Legacy MiniMax consent covers the original mainland region only. A
        // new region needs new client confirmation, never a guessed endpoint.
        if (provider.provider === 'minimax' && (speechRequest.expectedRegion ?? 'cn') !== provider.region)
          throw new SpeechProviderError('TTS_PROVIDER_CHANGED')
        sendJson(response, 200, await reserveAndSynthesise(speechRequest, signal))
      }
      catch (error) {
        if (cancelled.signal.aborted || response.destroyed || response.writableEnded)
          return
        const { status, code } = speechErrorResponse(error, { timedOut: timeout.signal.aborted })
        sendError(response, status, code)
      }
      finally {
        clearTimeout(timer)
        response.removeListener('close', close)
        request.removeListener('aborted', close)
        active--
      }
    },
  }
}

// Provider/OS errors may contain credentials or submitted text. Never relay
// error.message, upstream error JSON, trace IDs, or console logs.
export function speechErrorResponse(error, { timedOut = false } = {}) {
  const known = error instanceof SpeechProviderError || error instanceof TtsBudgetError
  const code = timedOut ? 'TTS_TIMEOUT' : known && Object.hasOwn(MESSAGES, error.code)
    ? error.code : 'TTS_UPSTREAM_FAILED'
  const status = code === 'TTS_INVALID_REQUEST' ? 400
    : code === 'TTS_PROVIDER_CHANGED' ? 409
    : code === 'TTS_DAILY_LIMIT' ? 429
      : code === 'TTS_BUDGET_UNAVAILABLE' ? 503
        : code === 'TTS_TIMEOUT' ? 504 : 502
  return { status, code, message: MESSAGES[code] }
}

function readBoundedJson(request, signal) {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json'))
    return Promise.reject(new SpeechProviderError('TTS_INVALID_REQUEST'))
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    const cleanup = () => {
      request.removeListener('data', data)
      request.removeListener('end', end)
      request.removeListener('error', invalid)
      signal.removeEventListener('abort', abort)
    }
    const fail = (error) => {
      cleanup()
      chunks.length = 0
      request.resume() // Drain without retaining any remaining oversized input.
      reject(error)
    }
    const invalid = () => fail(new SpeechProviderError('TTS_INVALID_REQUEST'))
    const abort = () => fail(signal.reason)
    const data = (chunk) => {
      size += Buffer.byteLength(chunk)
      if (size > MAX_REQUEST_BYTES)
        return invalid()
      chunks.push(Buffer.from(chunk))
    }
    const end = () => {
      cleanup()
      try {
        resolve(JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(chunks))))
      }
      catch {
        reject(new SpeechProviderError('TTS_INVALID_REQUEST'))
      }
    }
    request.on('data', data)
    request.once('end', end)
    request.once('error', invalid)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted)
      abort()
  })
}

function sendError(response, status, code) {
  sendJson(response, status, { code, message: MESSAGES[code] })
}

function sendJson(response, status, payload) {
  if (response.destroyed || response.writableEnded)
    return
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(JSON.stringify(payload))
}
