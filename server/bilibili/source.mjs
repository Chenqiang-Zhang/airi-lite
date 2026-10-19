import { fileURLToPath } from 'node:url'

import { createEventNormalizer } from './events.mjs'
import { createOpenLive, createSessionStore } from './open-live.mjs'
import { createRedactingLogger } from './redact.mjs'
import { createOpenLiveSocket } from './ws-client.mjs'

export const BILIBILI_ENV_NAMES = Object.freeze({
  accessKeyId: 'BILIBILI_OPEN_ACCESS_KEY_ID',
  accessKeySecret: 'BILIBILI_OPEN_ACCESS_KEY_SECRET',
  appId: 'BILIBILI_OPEN_APP_ID',
  code: 'BILIBILI_OPEN_CODE',
})
export const DEFAULT_SESSION_PATH = fileURLToPath(new URL('../../.data/live/bilibili-session.json', import.meta.url))
const RESTART_BACKOFF_BASE_MS = 30_000
const RESTART_BACKOFF_MAX_MS = 300_000
// Printable ASCII without spaces: these go into headers or JSON verbatim.
// Hidden whitespace is rejected rather than trimmed so a bad paste is visible.
const TOKEN = /^[\x21-\x7e]{1,512}$/
const FORMAT_HINTS = Object.freeze({
  appId: '应为纯数字的项目 ID',
  accessKeyId: '不能含空格或中文',
  accessKeySecret: '不能含空格或中文',
  code: '不能含空格或中文',
})

export class BilibiliConfigError extends Error {
  constructor(config) {
    super(describeConfigProblem(config))
    this.name = 'BilibiliConfigError'
    this.code = 'NOT_CONFIGURED'
    this.missing = config.missing
    this.invalid = config.invalid
  }
}

export function readBilibiliConfig(env = process.env) {
  const missing = []
  const invalid = []
  const values = {}
  for (const [key, name] of Object.entries(BILIBILI_ENV_NAMES)) {
    const value = env?.[name]
    if (typeof value !== 'string' || value === '') {
      missing.push(name)
      continue
    }
    const valid = key === 'appId'
      ? /^\d{1,16}$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0
      : TOKEN.test(value)
    if (!valid)
      invalid.push(name)
    values[key] = value
  }
  const configured = !missing.length && !invalid.length
  return Object.freeze({ configured, missing, invalid, credentials: configured ? Object.freeze(values) : null })
}

// Names only, never values.
export function describeConfigProblem({ missing = [], invalid = [] }) {
  const lines = []
  if (missing.length) {
    lines.push('缺少 B站开放平台配置，以下环境变量未设置：')
    lines.push(...missing.map(name => `  - ${name}`))
  }
  if (invalid.length) {
    lines.push('以下环境变量格式不正确：')
    const keys = Object.fromEntries(Object.entries(BILIBILI_ENV_NAMES).map(([key, name]) => [name, key]))
    lines.push(...invalid.map(name => `  - ${name}（${FORMAT_HINTS[keys[name]]}）`))
  }
  lines.push('请自己把它们写进 .env.local（不要贴到对话或日志里），然后用 node --env-file-if-exists=.env.local 启动。')
  return lines.join('\n')
}

// The Bilibili live open-platform input source: starts a game, keeps both
// heartbeats running, holds the long connection, and emits normalised events.
// It recovers on its own: socket failures, heartbeat expiry (7003) and
// INTERACTION_END end the old game and start a new one. stop() always ends an
// open game and clears every timer. status() never contains secrets.
export function createBilibiliSource({
  env = process.env,
  fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket,
  timers = globalThis,
  now = Date.now,
  storagePath = DEFAULT_SESSION_PATH,
  onEvent,
  onStatus,
  logger = console,
} = {}) {
  const config = readBilibiliConfig(env)
  // Every auth_body issued so far stays redacted, also after stop().
  const authBodies = []
  const secrets = () => [...Object.values(BILIBILI_ENV_NAMES).map(name => env?.[name]), ...authBodies]
  const log = createRedactingLogger(logger, secrets)
  const normalize = createEventNormalizer({ now })

  let state = config.configured ? 'idle' : 'unconfigured'
  let roomId = null
  let errorCode = config.configured ? null : 'NOT_CONFIGURED'
  let lastEventAt = null
  let openLive = null
  let socket = null
  let controller = null
  let starting = null
  let restarting = null
  let stopping = null
  let restartTimer = null
  let restartFailures = 0

  function status() {
    return {
      state,
      roomId,
      hasGame: Boolean(openLive?.session?.gameId),
      lastEventAgeMs: lastEventAt === null ? null : Math.max(0, now() - lastEventAt),
      errorCode,
    }
  }

  let lastEmitted = ''
  function setState(next) {
    state = next
    const { lastEventAgeMs, ...stable } = status()
    const key = JSON.stringify(stable)
    if (key === lastEmitted)
      return
    lastEmitted = key
    try {
      onStatus?.(status())
    }
    catch (error) {
      log.warn('onStatus 回调出错：', error?.message)
    }
  }

  function getOpenLive() {
    openLive ??= createOpenLive({
      credentials: config.credentials, fetchImpl, now, timers, logger: log,
      store: storagePath ? createSessionStore(storagePath) : null,
      onGameLost: () => restartGame('项目心跳失败'),
    })
    return openLive
  }

  function handleMessage(message) {
    lastEventAt = now()
    const event = normalize(message)
    if (!event)
      return
    if (event.type === 'interaction-end') {
      const current = openLive?.session?.gameId
      if (!event.gameId || event.gameId === current)
        restartGame('平台通知场次结束')
    }
    try {
      onEvent?.(event)
    }
    catch (error) {
      log.warn('onEvent 处理事件时出错：', error?.message)
    }
  }

  function connect(session) {
    authBodies.push(session.authBody)
    if (authBodies.length > 16)
      authBodies.shift()
    socket = createOpenLiveSocket({
      authBody: session.authBody, links: session.wssLinks, WebSocketImpl, timers, now, logger: log,
      onMessage: handleMessage,
      onState(socketState) {
        if (socketState === 'connected') {
          errorCode = null
          restartFailures = 0
          log.info(`已连接 B站直播间 ${roomId ?? '(未知房间)'} 的长连接`)
        }
        const mapped = { connecting: 'connecting', authenticating: 'connecting', connected: 'connected', backoff: 'reconnecting' }[socketState]
        if (mapped && !stopping && !restarting)
          setState(mapped)
      },
      onRestartNeeded: reason => restartGame(`长连接 ${reason}`),
    })
    socket.connect()
  }

  async function openGame(signal) {
    const session = await getOpenLive().start({ signal })
    signal.throwIfAborted()
    roomId = session.anchor.roomId
    log.info(`B站开放平台场次已开启，房间 ${roomId ?? '(未知)'}`)
    connect(session)
  }

  function restartGame(reason) {
    if (restarting || stopping || !controller || controller.signal.aborted)
      return
    const signal = controller.signal
    restarting = (async () => {
      setState('restarting')
      log.warn(`重新开启场次：${reason}`)
      socket?.close()
      socket = null
      await openLive?.end()
      try {
        await openGame(signal)
        if (socket?.state !== 'connected')
          setState('connecting')
      }
      catch (error) {
        if (signal.aborted)
          return
        errorCode = error?.code ?? 'UNKNOWN'
        if (error?.retryable) {
          restartFailures += 1
          const delay = Math.min(RESTART_BACKOFF_MAX_MS, RESTART_BACKOFF_BASE_MS * 2 ** (restartFailures - 1))
          log.warn(`重新开启场次失败：${error.message}，${Math.round(delay / 1_000)} 秒后再试`)
          restartTimer = timers.setTimeout(() => {
            restartTimer = null
            restartGame('上次重开失败')
          }, delay)
          setState('restarting')
        }
        else {
          log.error(`重新开启场次失败，已停止重试：${error?.message}`)
          controller = null
          setState('error')
        }
      }
    })().catch((error) => {
      log.error(`重新开启场次时出现意外错误：${error?.message}`)
    }).finally(() => {
      restarting = null
    })
  }

  return {
    async start() {
      if (!config.configured) {
        setState('unconfigured')
        throw new BilibiliConfigError(config)
      }
      if (stopping)
        await stopping
      if (starting)
        return starting
      if (controller && !controller.signal.aborted)
        return
      controller = new AbortController()
      const signal = controller.signal
      errorCode = null
      setState('starting')
      starting = openGame(signal).catch((error) => {
        if (signal.aborted)
          return
        errorCode = error?.code ?? 'UNKNOWN'
        controller = null
        log.error(`开启场次失败：${error?.message}`)
        setState('error')
        throw error
      }).finally(() => {
        starting = null
      })
      return starting
    },
    async stop() {
      if (stopping)
        return stopping
      stopping = (async () => {
        if (state !== 'unconfigured')
          setState('stopping')
        controller?.abort(new Error('B站来源已停止'))
        if (restartTimer !== null)
          timers.clearTimeout(restartTimer)
        restartTimer = null
        socket?.close()
        await starting?.catch(() => {})
        await restarting
        socket?.close()
        socket = null
        const { ended } = await openLive?.end() ?? { ended: false }
        if (ended)
          log.info('已结束 B站开放平台场次')
        controller = null
        if (state !== 'unconfigured')
          setState('stopped')
      })().finally(() => {
        stopping = null
      })
      return stopping
    },
    status,
  }
}
