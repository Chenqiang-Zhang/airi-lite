import { decodePackets, encodePacket, OP } from './packet.mjs'

export const WS_HEARTBEAT_MS = 20_000
const silentLogger = Object.freeze({ info() {}, warn() {}, error() {} })

// One long connection for one game. The first frame is OP_AUTH with the
// auth_body from /v2/app/start verbatim; an empty OP_HEARTBEAT follows every
// 20 s (the server drops a connection after ~30 s without one). On close,
// error, a connect timeout or silence it rotates to the next wss_link with
// exponential backoff. Silence (no traffic for idleTimeoutMs) is only judged
// once this connection has seen a heartbeat reply, so a server that never
// answers op2 cannot cause a reconnect loop in a quiet room. After maxFailures consecutive failures, or a rejected
// auth, it gives up and calls onRestartNeeded: the owner must start a new
// game, which brings a fresh auth_body. A connection that has been up for
// days can go silent (~7 days) without closing; callers watch lastEventAt.
export function createOpenLiveSocket({
  authBody,
  links,
  WebSocketImpl = globalThis.WebSocket,
  timers = globalThis,
  now = Date.now,
  logger = silentLogger,
  onMessage,
  onState,
  onRestartNeeded,
  heartbeatMs = WS_HEARTBEAT_MS,
  connectTimeoutMs = 15_000,
  idleTimeoutMs = 70_000,
  backoffBaseMs = 1_000,
  backoffMaxMs = 30_000,
  maxFailures = 3,
  stableAfterMs = 60_000,
} = {}) {
  if (typeof authBody !== 'string' || !authBody || !Array.isArray(links) || !links.length)
    throw new TypeError('authBody and at least one wss link are required')
  let attempt = null // { ws, linkIndex } for the current connection only
  let linkIndex = 0
  let failures = 0
  let closed = false
  let gaveUp = false
  let state = 'idle'
  let heartbeatTimer = null
  let connectTimer = null
  let reconnectTimer = null
  let lastEventAt = null
  let lastReceivedAt = null

  function setState(next, detail) {
    if (state === next)
      return
    state = next
    try {
      onState?.(next, detail)
    }
    catch (error) {
      logger.warn(`长连接状态回调出错：${error?.message}`)
    }
  }

  function clear(timer) {
    if (timer !== null)
      timers.clearTimeout(timer)
    return null
  }

  function send(current, operation, body) {
    try {
      current.ws.send(encodePacket(operation, body))
      return true
    }
    catch {
      return false
    }
  }

  function open() {
    reconnectTimer = null
    if (closed || gaveUp)
      return
    const current = { ws: null, linkIndex, openedAt: null, heartbeatReplies: 0, fatal: false }
    attempt = current
    setState('connecting', { link: linkIndex })
    try {
      current.ws = new WebSocketImpl(links[linkIndex])
      current.ws.binaryType = 'arraybuffer'
    }
    catch {
      return drop(current, 'constructor')
    }
    current.ws.addEventListener('open', () => {
      if (attempt !== current)
        return
      connectTimer = clear(connectTimer)
      lastReceivedAt = now()
      current.openedAt = lastReceivedAt
      if (!send(current, OP.AUTH, authBody))
        return drop(current, 'send-auth')
      setState('authenticating')
      scheduleHeartbeat(current)
    })
    current.ws.addEventListener('message', event => receive(current, event.data))
    current.ws.addEventListener('error', () => {
      if (attempt === current)
        logger.warn('长连接出错，等待关闭后重连')
    })
    current.ws.addEventListener('close', (event) => {
      if (attempt === current)
        drop(current, `close ${event?.code ?? ''}`.trim())
    })
    connectTimer = timers.setTimeout(() => {
      connectTimer = null
      if (attempt === current)
        drop(current, 'connect-timeout')
    }, connectTimeoutMs)
  }

  function scheduleHeartbeat(current) {
    heartbeatTimer = timers.setTimeout(() => {
      heartbeatTimer = null
      if (attempt !== current)
        return
      if (current.heartbeatReplies > 0 && now() - lastReceivedAt > idleTimeoutMs)
        return drop(current, 'idle')
      if (!send(current, OP.HEARTBEAT, ''))
        return drop(current, 'send-heartbeat')
      scheduleHeartbeat(current)
    }, heartbeatMs)
  }

  function receive(current, data) {
    if (attempt !== current)
      return
    lastReceivedAt = now()
    const { packets, errors } = decodePackets(data)
    if (errors.length)
      logger.warn(`收到无法解析的长连接数据：${errors.join(', ')}`)
    for (const packet of packets) {
      if (attempt !== current)
        return
      if (packet.operation === OP.AUTH_REPLY) {
        let reply = null
        try {
          reply = JSON.parse(packet.body.toString('utf8'))
        }
        catch {
          logger.warn('鉴权回复无法解析，按成功处理')
        }
        if (Number.isSafeInteger(reply?.code) && reply.code !== 0) {
          logger.warn(`长连接鉴权被拒绝（code ${reply.code}），需要重新开启场次`)
          current.fatal = true
          return drop(current, 'auth-rejected')
        }
        // Failures reset only on later traffic (heartbeat reply or message),
        // so a server that accepts auth and then drops us still escalates.
        setState('connected')
      }
      else if (packet.operation === OP.HEARTBEAT_REPLY) {
        current.heartbeatReplies += 1
        failures = 0
      }
      else if (packet.operation === OP.MESSAGE) {
        failures = 0
        let message
        try {
          message = JSON.parse(packet.body.toString('utf8'))
        }
        catch {
          logger.warn('业务消息不是合法 JSON，已丢弃')
          continue
        }
        lastEventAt = now()
        try {
          onMessage?.(message)
        }
        catch (error) {
          logger.warn(`处理业务消息时出错：${error?.message}`)
        }
      }
    }
  }

  function drop(current, reason) {
    if (attempt !== current)
      return
    attempt = null
    heartbeatTimer = clear(heartbeatTimer)
    connectTimer = clear(connectTimer)
    try {
      current.ws?.close()
    }
    catch {}
    if (closed)
      return
    // A connection that stayed up for a while counts as healthy even if the
    // server never sent op3/op5, so rare drops do not add up to a restart.
    if (current.openedAt !== null && now() - current.openedAt >= stableAfterMs)
      failures = 0
    failures = current.fatal ? maxFailures : failures + 1
    if (failures >= maxFailures) {
      gaveUp = true
      logger.warn(`长连接连续失败 ${failures} 次（${reason}），需要重新开启场次`)
      setState('failed', { reason })
      try {
        onRestartNeeded?.(reason)
      }
      catch (error) {
        logger.warn(`重新开启场次的回调出错：${error?.message}`)
      }
      return
    }
    linkIndex = (linkIndex + 1) % links.length
    const delay = Math.min(backoffMaxMs, backoffBaseMs * 2 ** (failures - 1))
    logger.warn(`长连接断开（${reason}），${delay} 毫秒后改连第 ${linkIndex + 1} 个地址`)
    setState('backoff', { reason, delay, link: linkIndex })
    reconnectTimer = timers.setTimeout(open, delay)
  }

  return {
    connect() {
      if (closed || gaveUp || attempt || reconnectTimer !== null)
        return
      open()
    },
    close() {
      if (closed)
        return
      closed = true
      reconnectTimer = clear(reconnectTimer)
      heartbeatTimer = clear(heartbeatTimer)
      connectTimer = clear(connectTimer)
      const current = attempt
      attempt = null
      try {
        current?.ws?.close(1000)
      }
      catch {}
      setState('closed')
    },
    get state() {
      return state
    },
    get lastEventAt() {
      return lastEventAt
    },
    get lastReceivedAt() {
      return lastReceivedAt
    },
  }
}
