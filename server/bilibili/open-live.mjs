import { randomUUID as defaultRandomUUID } from 'node:crypto'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { OPEN_LIVE_ORIGIN, signOpenLiveRequest } from './sign.mjs'

export const HEARTBEAT_INTERVAL_MS = 20_000
export const COOLDOWN_RETRY_MS = 10_000
const REQUEST_TIMEOUT_MS = 10_000
const MAX_SESSION_FILE_BYTES = 4_096
const silentLogger = Object.freeze({ info() {}, warn() {}, error() {} })

// Hints only: 4009, 5004, 7001, 7002, 7003 and 7010 come from the M4 research
// notes; the remaining descriptions follow the public error-code table as
// remembered and must be re-checked against the open-platform docs.
export const ERROR_HINTS = Object.freeze({
  4000: '参数错误',
  4001: '应用无效',
  4002: '签名异常，检查 access key 与 secret',
  4003: '请求已过期，检查本机时间（时间戳单位为秒）',
  4004: 'nonce 重复',
  4009: '接口访问频率受限',
  5000: '平台服务异常',
  5004: '未上架的应用只能连接开发者自己的直播间',
  7000: '不在场次中',
  7001: '请求冷却期',
  7002: '房间里已有同一应用的场次',
  7003: '心跳过期或 game_id 无效',
  7007: '身份码无效，请在直播间重新获取',
  7010: '单个直播间连接数已达上限',
  NETWORK: '网络请求失败或超时',
  BAD_RESPONSE: '平台响应格式异常',
  BAD_START_RESPONSE: '开启场次的响应缺少 game_id、auth_body 或 wss_link',
})
// Transient: the same request may succeed later. 7001/7002 are retryable for
// start only (after a cooldown / ending the stale game), not transient.
const TRANSIENT = new Set([4009, 5000, 5001, 5002, 'NETWORK', 'BAD_RESPONSE'])

export class OpenLiveError extends Error {
  constructor(code, { path = '', apiMessage = '' } = {}) {
    const hint = ERROR_HINTS[code]
    // Never include request payloads or headers: they carry the 身份码 and signature.
    super(`B站开放平台 ${path || '请求'} 失败：${code}${hint ? `（${hint}）` : ''}`)
    this.name = 'OpenLiveError'
    this.code = code
    this.path = path
    this.apiMessage = typeof apiMessage === 'string' ? apiMessage.slice(0, 120) : ''
    this.transient = TRANSIENT.has(code)
    this.retryable = this.transient || code === 7001 || code === 7002
  }
}

// One signed POST. HTTP status is always 200 on this platform: success is
// body.code === 0 and the payload is body.data. Always the fixed origin, so an
// injected path or config can never send the signature to another host.
export async function callOpenLive(path, payload, { credentials, fetchImpl = fetch, now = Date.now,
  randomUUID = defaultRandomUUID, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const body = JSON.stringify(payload)
  const headers = signOpenLiveRequest({
    body, accessKeyId: credentials.accessKeyId, accessKeySecret: credentials.accessKeySecret,
    nonce: randomUUID(), now,
  })
  let response
  try {
    response = await fetchImpl(`${OPEN_LIVE_ORIGIN}${path}`, {
      method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    })
  }
  catch {
    throw new OpenLiveError('NETWORK', { path })
  }
  let result
  try {
    result = await response.json()
  }
  catch {
    throw new OpenLiveError('BAD_RESPONSE', { path })
  }
  if (!result || typeof result !== 'object' || !Number.isSafeInteger(result.code))
    throw new OpenLiveError('BAD_RESPONSE', { path })
  if (result.code !== 0)
    throw new OpenLiveError(result.code, { path, apiMessage: result.message })
  return result.data && typeof result.data === 'object' ? result.data : {}
}

export function parseStartData(data) {
  const gameId = data?.game_info?.game_id
  const authBody = data?.websocket_info?.auth_body
  const links = data?.websocket_info?.wss_link
  const wssLinks = Array.isArray(links)
    ? links.filter(link => typeof link === 'string' && /^wss:\/\/[^\s/]+/i.test(link))
    : []
  if (typeof gameId !== 'string' || typeof authBody !== 'string' || !authBody || !wssLinks.length)
    throw new OpenLiveError('BAD_START_RESPONSE', { path: '/v2/app/start' })
  const anchor = data.anchor_info && typeof data.anchor_info === 'object' ? data.anchor_info : {}
  const roomId = Number(anchor.room_id)
  return {
    gameId,
    authBody,
    wssLinks,
    anchor: {
      roomId: Number.isSafeInteger(roomId) && roomId > 0 ? roomId : null,
      name: typeof anchor.uname === 'string' ? anchor.uname : '',
      face: typeof anchor.uface === 'string' ? anchor.uface : '',
      openId: typeof anchor.open_id === 'string' ? anchor.open_id : '',
    },
  }
}

// game_id is persisted so a crashed process can end its stale game on the
// next start. No credentials are stored, only the game id and a timestamp.
export function createSessionStore(path) {
  const file = resolve(path)
  return {
    path: file,
    async read() {
      let handle
      try {
        handle = await open(file, 'r')
      }
      catch (error) {
        if (error?.code === 'ENOENT')
          return null
        throw error
      }
      try {
        if ((await handle.stat()).size > MAX_SESSION_FILE_BYTES)
          return null
        const record = JSON.parse(await handle.readFile('utf8'))
        return record?.version === 1 && typeof record.gameId === 'string' && record.gameId ? record : null
      }
      catch {
        return null
      }
      finally {
        await handle.close()
      }
    },
    async write(record) {
      const directory = dirname(file)
      const temporary = `${file}.${defaultRandomUUID()}.tmp`
      await mkdir(directory, { recursive: true, mode: 0o700 })
      try {
        const handle = await open(temporary, 'wx', 0o600)
        try {
          await handle.writeFile(`${JSON.stringify({ version: 1, ...record })}\n`)
          await handle.sync()
        }
        finally {
          await handle.close()
        }
        await rename(temporary, file)
      }
      finally {
        await unlink(temporary).catch(() => {})
      }
    },
    async remove() {
      await unlink(file).catch((error) => {
        if (error?.code !== 'ENOENT')
          throw error
      })
    },
  }
}

export function sleep(ms, { timers = globalThis, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted)
      return reject(signal.reason)
    const onAbort = () => {
      timers.clearTimeout(id)
      reject(signal.reason)
    }
    const id = timers.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// Game lifecycle: start (ending any stale persisted game first, retrying
// 7001/7002/4009 and transient failures), an HTTP heartbeat every 20 s while a
// game is open, and end. Heartbeat failures that mean the game is gone are
// reported through onGameLost so the owner can start a new game.
export function createOpenLive({
  credentials,
  fetchImpl = fetch,
  now = Date.now,
  randomUUID = defaultRandomUUID,
  timers = globalThis,
  store = null,
  logger = silentLogger,
  onGameLost,
  heartbeatMs = HEARTBEAT_INTERVAL_MS,
  cooldownMs = COOLDOWN_RETRY_MS,
  backoffBaseMs = 2_000,
  backoffMaxMs = 60_000,
  maxStartAttempts = 6,
  maxHeartbeatFailures = 3,
  endRetryDelaysMs = [1_000, 2_000],
} = {}) {
  const appId = Number(credentials.appId)
  let session = null
  let heartbeatTimer = null
  let heartbeatInFlight = false
  let heartbeatFailures = 0

  const call = (path, payload) => callOpenLive(path, payload, { credentials, fetchImpl, now, randomUUID })

  function retryDelay(error, attempt) {
    if (error.code === 7001 || error.code === 7002)
      return cooldownMs
    if (error.transient)
      return Math.min(backoffMaxMs, backoffBaseMs * 2 ** (attempt - 1))
    return null
  }

  // Resolves true when the game is known to be gone (ended now, or a 7xxx
  // game error says it no longer exists); false when the outcome is unknown,
  // e.g. offline or a credential error, so the persisted record is kept.
  async function endGame(gameId) {
    if (!gameId)
      return true
    for (let attempt = 0; ; attempt += 1) {
      try {
        await call('/v2/app/end', { app_id: appId, game_id: gameId })
        return true
      }
      catch (error) {
        if (Number.isSafeInteger(error.code) && error.code >= 7_000 && error.code < 8_000)
          return true
        if (!error.transient || attempt >= endRetryDelaysMs.length) {
          logger.warn(`结束场次失败，下次启动时会再尝试：${error.message}`)
          return false
        }
        // Not abortable: end runs during shutdown and must still be attempted.
        await sleep(endRetryDelaysMs[attempt], { timers })
      }
    }
  }

  async function endStale() {
    if (!store)
      return
    let record
    try {
      record = await store.read()
    }
    catch (error) {
      logger.warn(`读取残留场次记录失败：${error.code ?? error.message}`)
      return
    }
    if (!record || record.gameId === session?.gameId)
      return
    logger.info('发现上次未结束的场次，先结束它')
    if (await endGame(record.gameId))
      await store.remove().catch(() => {})
  }

  async function persist(gameId) {
    if (!store || !gameId)
      return
    try {
      await store.write({ gameId, startedAt: new Date(now()).toISOString() })
    }
    catch (error) {
      logger.warn(`无法保存场次记录（进程崩溃后需等平台超时关闭）：${error.code ?? error.message}`)
    }
  }

  function scheduleHeartbeat() {
    heartbeatTimer = timers.setTimeout(beat, heartbeatMs)
  }

  async function beat() {
    heartbeatTimer = null
    const current = session
    if (!current)
      return
    scheduleHeartbeat() // Fixed cadence, independent of request latency.
    if (heartbeatInFlight)
      return
    heartbeatInFlight = true
    try {
      await call('/v2/app/heartbeat', { game_id: current.gameId })
      heartbeatFailures = 0
    }
    catch (error) {
      if (session !== current)
        return
      heartbeatFailures += 1
      if (error.code === 7003 || error.code === 7000 || heartbeatFailures >= maxHeartbeatFailures) {
        stopHeartbeat()
        logger.warn(`项目心跳失败，场次可能已关闭：${error.message}`)
        onGameLost?.(error)
      }
      else {
        logger.warn(`项目心跳失败（第 ${heartbeatFailures} 次），稍后重试：${error.message}`)
      }
    }
    finally {
      heartbeatInFlight = false
    }
  }

  function stopHeartbeat() {
    if (heartbeatTimer !== null)
      timers.clearTimeout(heartbeatTimer)
    heartbeatTimer = null
    heartbeatFailures = 0
  }

  return {
    get session() {
      return session
    },
    // The start request itself is never aborted: if it succeeded on the
    // platform we must learn the game id to end it. Only waits are abortable.
    async start({ signal } = {}) {
      if (session)
        throw new Error('场次已开启')
      await endStale()
      for (let attempt = 1; ; attempt += 1) {
        signal?.throwIfAborted()
        let data
        try {
          data = await call('/v2/app/start', { code: credentials.code, app_id: appId })
        }
        catch (error) {
          const delay = error instanceof OpenLiveError && attempt < maxStartAttempts ? retryDelay(error, attempt) : null
          if (delay === null)
            throw error
          if (error.code === 7002)
            await endStale()
          logger.warn(`${error.message}，${Math.round(delay / 1_000)} 秒后重试（第 ${attempt} 次）`)
          await sleep(delay, { timers, signal })
          continue
        }
        let started
        try {
          started = parseStartData(data)
        }
        catch (error) {
          await endGame(typeof data?.game_info?.game_id === 'string' ? data.game_info.game_id : '')
          throw error
        }
        if (signal?.aborted) {
          await endGame(started.gameId)
          signal.throwIfAborted()
        }
        session = started
        if (!started.gameId)
          logger.warn('平台未返回 game_id：不发送项目心跳，也无需结束场次')
        await persist(started.gameId)
        if (started.gameId)
          scheduleHeartbeat()
        return started
      }
    },
    // Never throws. Resolves whether a game was open and known to be ended.
    async end() {
      stopHeartbeat()
      const current = session
      session = null
      if (!current?.gameId)
        return { ended: false }
      const gone = await endGame(current.gameId)
      if (gone && store)
        await store.remove().catch(() => {})
      return { ended: gone }
    },
    stopHeartbeat,
  }
}
