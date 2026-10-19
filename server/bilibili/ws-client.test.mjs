import assert from 'node:assert/strict'
import test from 'node:test'
import { deflateSync } from 'node:zlib'

import { encodePacket, OP, VERSION } from './packet.mjs'
import { createCapturingLogger, createFakeClock, createFakeWebSocket } from './testing.mjs'
import { createOpenLiveSocket } from './ws-client.mjs'

const AUTH = '{"key":"secret-auth-body"}'
const LINKS = ['wss://ws-a.test/sub', 'wss://ws-b.test/sub', 'wss://ws-c.test/sub']

function setup(options = {}) {
  const clock = createFakeClock()
  const fake = createFakeWebSocket()
  const { logger, lines } = createCapturingLogger()
  const messages = []
  const states = []
  const restarts = []
  const socket = createOpenLiveSocket({
    authBody: AUTH, links: LINKS, WebSocketImpl: fake.WebSocketImpl, timers: clock.timers, now: clock.now, logger,
    onMessage: message => messages.push(message), onState: state => states.push(state),
    onRestartNeeded: reason => restarts.push(reason), ...options,
  })
  return { clock, fake, socket, messages, states, restarts, lines }
}

test('the first frame is OP_AUTH with auth_body verbatim, then an empty heartbeat every 20 s', async () => {
  const { clock, fake, socket, states } = setup()
  socket.connect()
  const ws = fake.last()
  assert.equal(ws.url, LINKS[0])
  assert.equal(ws.binaryType, 'arraybuffer')
  ws.serverOpen()
  assert.deepEqual(ws.sentOps, [OP.AUTH])
  assert.equal(ws.sentPackets[0].body.toString(), AUTH)
  assert.equal(ws.sentPackets[0].version, VERSION.JSON)
  ws.serverAuthReply(0)
  assert.equal(socket.state, 'connected')
  await clock.advance(19_999)
  assert.deepEqual(ws.sentOps, [OP.AUTH])
  await clock.advance(1)
  ws.serverSend(encodePacket(OP.HEARTBEAT_REPLY, ''))
  await clock.advance(20_000)
  ws.serverSend(encodePacket(OP.HEARTBEAT_REPLY, ''))
  await clock.advance(20_000)
  assert.deepEqual(ws.sentOps, [OP.AUTH, OP.HEARTBEAT, OP.HEARTBEAT, OP.HEARTBEAT])
  assert.ok(ws.sentPackets.slice(1).every(packet => packet.body.length === 0))
  assert.deepEqual(states, ['connecting', 'authenticating', 'connected'])
  socket.close()
  assert.deepEqual(clock.pending, [])
  assert.deepEqual(ws.closeCalls, [{ code: 1000, reason: undefined }])
})

test('business messages (plain and zlib multi-packet) reach onMessage and update lastEventAt', async () => {
  const { clock, fake, socket, messages, lines } = setup()
  socket.connect()
  const ws = fake.last()
  ws.serverOpen()
  ws.serverAuthReply()
  assert.equal(socket.lastEventAt, null)
  await clock.advance(5_000)
  ws.serverMessage({ cmd: 'A' })
  const inner = Buffer.concat([{ cmd: 'B' }, { cmd: 'C' }].map(message => encodePacket(OP.MESSAGE, JSON.stringify(message))))
  ws.serverSend(encodePacket(OP.MESSAGE, deflateSync(inner), { version: VERSION.ZLIB }), encodePacket(OP.MESSAGE, 'not json'))
  ws.serverSend(Buffer.from([0, 0, 0, 99, 0, 16]))
  assert.deepEqual(messages, [{ cmd: 'A' }, { cmd: 'B' }, { cmd: 'C' }])
  assert.equal(socket.lastEventAt, clock.now())
  assert.ok(lines.some(line => line.includes('不是合法 JSON')))
  assert.ok(lines.some(line => line.includes('PACKET_TRUNCATED')))
  assert.equal(socket.state, 'connected')
  socket.close()
})

test('a throwing onMessage handler does not break the connection', async () => {
  const { fake, socket, lines } = setup({ onMessage: () => { throw new Error('consumer bug') } })
  socket.connect()
  fake.last().serverOpen()
  fake.last().serverMessage({ cmd: 'X' })
  assert.equal(socket.state, 'authenticating')
  assert.ok(lines.some(line => line.includes('consumer bug')))
  socket.close()
})

test('drops rotate through wss links with exponential backoff, reusing auth_body', async () => {
  const { clock, fake, socket, states, restarts } = setup({ maxFailures: 4 })
  socket.connect()
  fake.last().serverOpen()
  fake.last().serverFail()
  assert.equal(socket.state, 'backoff')
  assert.deepEqual(clock.pending, [1_000])
  await clock.advance(999)
  assert.equal(fake.sockets.length, 1)
  await clock.advance(1)
  assert.equal(fake.sockets.length, 2)
  assert.equal(fake.last().url, LINKS[1])
  fake.last().serverFail()
  assert.deepEqual(clock.pending, [2_000])
  await clock.advance(2_000)
  assert.equal(fake.last().url, LINKS[2])
  fake.last().serverOpen()
  assert.equal(fake.last().sentPackets[0].body.toString(), AUTH)
  fake.last().serverFail()
  assert.deepEqual(clock.pending, [4_000])
  await clock.advance(4_000)
  assert.equal(fake.last().url, LINKS[0], 'wraps around to the first link')
  assert.deepEqual(restarts, [])
  assert.ok(states.includes('backoff'))
  socket.close()
  assert.deepEqual(clock.pending, [])
})

test('repeated failures stop reconnecting and ask the owner to start a new game', async () => {
  const { clock, fake, socket, restarts } = setup()
  socket.connect()
  fake.last().serverFail()
  await clock.advance(1_000)
  fake.last().serverFail()
  await clock.advance(2_000)
  fake.last().serverFail()
  assert.equal(socket.state, 'failed')
  assert.equal(restarts.length, 1)
  assert.match(restarts[0], /close/)
  assert.deepEqual(clock.pending, [])
  await clock.advance(120_000)
  assert.equal(fake.sockets.length, 3)
  socket.connect()
  assert.equal(fake.sockets.length, 3, 'a failed socket stays failed; the owner creates a new one')
})

test('a healthy connection resets the failure count so a later drop retries quickly', async () => {
  const { clock, fake, socket, restarts } = setup()
  socket.connect()
  fake.last().serverFail()
  await clock.advance(1_000)
  fake.last().serverFail()
  await clock.advance(2_000)
  const ws = fake.last()
  ws.serverOpen()
  ws.serverAuthReply()
  ws.serverSend(encodePacket(OP.HEARTBEAT_REPLY, ''))
  ws.serverFail()
  assert.deepEqual(clock.pending, [1_000])
  assert.deepEqual(restarts, [])
  socket.close()
})

test('a rejected auth asks for a new game immediately', () => {
  const { fake, socket, restarts, clock } = setup()
  socket.connect()
  fake.last().serverOpen()
  fake.last().serverAuthReply(-101)
  assert.deepEqual(restarts, ['auth-rejected'])
  assert.equal(socket.state, 'failed')
  assert.deepEqual(clock.pending, [])
})

test('a connect timeout and a silent half-open connection both count as failures', async () => {
  const { clock, fake, socket } = setup({ maxFailures: 5 })
  socket.connect()
  await clock.advance(15_000)
  assert.equal(socket.state, 'backoff')
  assert.equal(fake.sockets[0].closeCalls.length, 1)
  await clock.advance(1_000)
  const ws = fake.last()
  ws.serverOpen()
  ws.serverAuthReply()
  await clock.advance(20_000)
  ws.serverSend(encodePacket(OP.HEARTBEAT_REPLY, ''))
  // Heartbeats keep being sent but nothing comes back for > 70 s.
  await clock.advance(80_000)
  assert.equal(socket.state, 'backoff')
  assert.ok(ws.sentOps.filter(op => op === OP.HEARTBEAT).length >= 4)
  assert.equal(ws.closeCalls.length, 1)
  socket.close()
})

test('silence is not judged on a connection that has never seen a heartbeat reply', async () => {
  const { clock, fake, socket } = setup()
  socket.connect()
  const ws = fake.last()
  ws.serverOpen()
  ws.serverAuthReply()
  await clock.advance(600_000)
  assert.equal(socket.state, 'connected')
  assert.equal(ws.sentOps.filter(op => op === OP.HEARTBEAT).length, 30)
  socket.close()
})

test('a connection that stayed up past the stability window resets the failure count', async () => {
  const { clock, fake, socket, restarts } = setup()
  socket.connect()
  fake.last().serverFail()
  await clock.advance(1_000)
  fake.last().serverFail()
  await clock.advance(2_000)
  fake.last().serverOpen()
  fake.last().serverAuthReply()
  await clock.advance(60_000)
  fake.last().serverFail()
  assert.deepEqual(restarts, [])
  assert.deepEqual(clock.pending, [1_000])
  await clock.advance(1_000)
  fake.last().serverOpen()
  await clock.advance(10_000)
  fake.last().serverFail()
  assert.deepEqual(clock.pending, [2_000], 'a short-lived connection still escalates')
  socket.close()
})

test('a late close event from a replaced socket is ignored', async () => {
  const { clock, fake, socket } = setup()
  socket.connect()
  await clock.advance(15_000) // connect timeout replaces the first socket
  await clock.advance(1_000)
  assert.equal(fake.sockets.length, 2)
  fake.sockets[0].serverFail()
  assert.equal(socket.state, 'connecting')
  assert.deepEqual(clock.pending, [15_000])
  socket.close()
})

test('a constructor failure is handled like a drop and close() is idempotent', async () => {
  const { clock, fake, socket } = setup({ links: ['not-a-url', 'wss://ok.test/sub'] })
  socket.connect()
  assert.equal(socket.state, 'backoff')
  await clock.advance(1_000)
  assert.equal(fake.last().url, 'wss://ok.test/sub')
  socket.close()
  socket.close()
  assert.equal(socket.state, 'closed')
  assert.deepEqual(clock.pending, [])
  assert.throws(() => createOpenLiveSocket({ authBody: '', links: LINKS }), TypeError)
})

test('the auth body is never logged', async () => {
  const { clock, fake, socket, lines } = setup()
  socket.connect()
  fake.last().serverOpen()
  fake.last().serverAuthReply(-1)
  await clock.advance(60_000)
  assert.ok(lines.length > 0)
  assert.ok(lines.every(line => !line.includes('secret-auth-body')))
})
