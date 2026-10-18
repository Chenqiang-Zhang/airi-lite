// Test doubles shared by the server/bilibili tests: a fake clock with
// setTimeout/clearTimeout, a scripted fake fetch for the open-platform API and
// a fake WebSocket. Nothing here touches the network.
import { decodePackets, encodePacket, OP } from './packet.mjs'

export const START_TIME = Date.UTC(2026, 9, 19, 12, 0, 0)

export async function flush(rounds = 8) {
  for (let round = 0; round < rounds; round += 1)
    await new Promise(resolve => setImmediate(resolve))
}

export function createFakeClock(start = START_TIME) {
  let time = start
  let nextId = 1
  const pending = new Map()
  const timers = {
    setTimeout(callback, ms = 0) {
      const id = nextId
      nextId += 1
      pending.set(id, { id, at: time + Math.max(0, Number(ms) || 0), callback })
      return id
    },
    clearTimeout(id) {
      pending.delete(id)
    },
  }
  const next = () => [...pending.values()].sort((a, b) => a.at - b.at || a.id - b.id)[0]
  function fire(timer) {
    pending.delete(timer.id)
    time = Math.max(time, timer.at)
    timer.callback()
  }
  return {
    timers,
    now: () => time,
    // Delays (ms from now) of every pending timer, soonest first.
    get pending() {
      return [...pending.values()].sort((a, b) => a.at - b.at || a.id - b.id).map(timer => timer.at - time)
    },
    async advance(ms) {
      const target = time + ms
      await flush()
      for (let timer = next(); timer && timer.at <= target; timer = next()) {
        fire(timer)
        await flush()
      }
      time = target
      await flush()
    },
    // Fires timers one at a time (with real I/O in between) until the promise
    // settles. Used where a flow mixes real filesystem work and fake waits.
    async run(promise, { maxTimers = 200 } = {}) {
      let settled = false
      const tracked = promise.then(
        (value) => { settled = true; return value },
        (error) => { settled = true; throw error },
      )
      tracked.catch(() => {})
      const deadline = Date.now() + 5_000
      for (let fired = 0; !settled;) {
        await flush()
        if (settled)
          break
        const timer = next()
        if (timer && fired < maxTimers) {
          fire(timer)
          fired += 1
        }
        else if (Date.now() > deadline) {
          throw new Error('clock.run: promise did not settle')
        }
        else {
          await new Promise(resolve => setTimeout(resolve, 2))
        }
      }
      return tracked
    },
  }
}

export async function waitFor(predicate, { timeoutMs = 3_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error('waitFor: condition not met')
    await new Promise(resolve => setTimeout(resolve, 2))
  }
}

export const credentials = Object.freeze({
  accessKeyId: 'TEST-ACCESS-KEY-ID-123',
  accessKeySecret: 'TEST-ACCESS-KEY-SECRET-456',
  appId: '1234567890123',
  code: 'TESTIDCODE789',
})
export const env = Object.freeze({
  BILIBILI_OPEN_ACCESS_KEY_ID: credentials.accessKeyId,
  BILIBILI_OPEN_ACCESS_KEY_SECRET: credentials.accessKeySecret,
  BILIBILI_OPEN_APP_ID: credentials.appId,
  BILIBILI_OPEN_CODE: credentials.code,
})

export function startResponse({ gameId = 'game-1', authBody = `{"key":"auth-for-${gameId}"}`,
  links = ['wss://ws-a.test/sub', 'wss://ws-b.test/sub'], roomId = 4_242 } = {}) {
  return {
    code: 0,
    message: '0',
    data: {
      game_info: { game_id: gameId },
      websocket_info: { auth_body: authBody, wss_link: links },
      anchor_info: { room_id: roomId, uname: '主播本人', uface: 'https://i0.hdslb.test/face.jpg', uid: 0, open_id: 'anchor-open-id', union_id: '' },
    },
  }
}

// script maps an API path to a list of replies consumed in order (the last
// one repeats) or a function(call) → reply. A reply is a JSON body object, an
// Error to reject fetch with, or a string for a raw (possibly invalid) body.
export function createFakeFetch(script = {}) {
  const calls = []
  const counters = new Map()
  async function fetchImpl(url, init) {
    const parsed = new URL(url)
    const call = { url, origin: parsed.origin, path: parsed.pathname, headers: init.headers, body: JSON.parse(init.body), init }
    calls.push(call)
    const entry = script[call.path]
    let reply
    if (typeof entry === 'function') {
      reply = await entry(call, calls)
    }
    else if (Array.isArray(entry) && entry.length) {
      const index = counters.get(call.path) ?? 0
      counters.set(call.path, index + 1)
      reply = entry[Math.min(index, entry.length - 1)]
    }
    else {
      reply = { code: 0, message: '0', data: {} }
    }
    if (reply instanceof Error)
      throw reply
    return new Response(typeof reply === 'string' ? reply : JSON.stringify(reply), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }
  return { fetchImpl, calls, paths: () => calls.map(call => call.path) }
}

export function createFakeWebSocket() {
  const sockets = []
  class FakeWebSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3
    constructor(url) {
      if (!String(url).startsWith('wss://'))
        throw new SyntaxError('invalid url')
      this.url = url
      this.readyState = FakeWebSocket.CONNECTING
      this.binaryType = 'blob'
      this.sent = []
      this.listeners = new Map()
      this.closeCalls = []
      sockets.push(this)
    }

    addEventListener(type, listener) {
      if (!this.listeners.has(type))
        this.listeners.set(type, new Set())
      this.listeners.get(type).add(listener)
    }

    removeEventListener(type, listener) {
      this.listeners.get(type)?.delete(listener)
    }

    emit(type, event = {}) {
      for (const listener of this.listeners.get(type) ?? [])
        listener({ type, ...event })
    }

    send(data) {
      if (this.readyState !== FakeWebSocket.OPEN)
        throw new Error('not open')
      this.sent.push(Buffer.from(data))
    }

    close(code, reason) {
      this.closeCalls.push({ code, reason })
      if (this.readyState >= FakeWebSocket.CLOSING)
        return
      this.readyState = FakeWebSocket.CLOSING
      queueMicrotask(() => {
        this.readyState = FakeWebSocket.CLOSED
        this.emit('close', { code: code ?? 1005, reason: reason ?? '' })
      })
    }

    // Test controls.
    serverOpen() {
      this.readyState = FakeWebSocket.OPEN
      this.emit('open')
    }

    serverSend(...packets) {
      const frame = Buffer.concat(packets.map(packet => Buffer.isBuffer(packet) ? packet : Buffer.from(packet)))
      this.emit('message', { data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.length) })
    }

    serverAuthReply(code = 0) {
      this.serverSend(encodePacket(OP.AUTH_REPLY, JSON.stringify({ code })))
    }

    serverMessage(message) {
      this.serverSend(encodePacket(OP.MESSAGE, JSON.stringify(message)))
    }

    serverFail(code = 1006) {
      this.emit('error')
      this.readyState = FakeWebSocket.CLOSED
      this.emit('close', { code, reason: '' })
    }

    get sentPackets() {
      return this.sent.flatMap(frame => decodePackets(frame).packets)
    }

    get sentOps() {
      return this.sentPackets.map(packet => packet.operation)
    }
  }
  return { WebSocketImpl: FakeWebSocket, sockets, last: () => sockets.at(-1) }
}

export function createCapturingLogger() {
  const lines = []
  const record = level => (...args) => lines.push(`${level} ${args.map(String).join(' ')}`)
  return { logger: { info: record('info'), warn: record('warn'), error: record('error') }, lines }
}
