import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { brotliCompressSync, deflateSync } from 'node:zlib'

import { CMD } from './events.mjs'
import { encodePacket, OP, VERSION } from './packet.mjs'
import { BilibiliConfigError, BILIBILI_ENV_NAMES, createBilibiliSource, describeConfigProblem, readBilibiliConfig } from './source.mjs'
import { createCapturingLogger, createFakeClock, createFakeFetch, createFakeWebSocket, credentials, env, startResponse } from './testing.mjs'

const fixture = cmd => JSON.parse(readFileSync(new URL(`./fixtures/${cmd}.json`, import.meta.url), 'utf8'))
const SECRETS = [credentials.accessKeyId, credentials.accessKeySecret, credentials.code]

async function tempPath(context) {
  const directory = await mkdtemp(join(tmpdir(), 'airi-bili-source-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  return join(directory, '.data', 'live', 'bilibili-session.json')
}

function setup({ script = { '/v2/app/start': [startResponse()] }, storagePath = null, sourceEnv = env, ...options } = {}) {
  const clock = createFakeClock()
  const fake = createFakeFetch(script)
  const ws = createFakeWebSocket()
  const { logger, lines } = createCapturingLogger()
  const events = []
  const statuses = []
  const source = createBilibiliSource({
    env: sourceEnv, fetchImpl: fake.fetchImpl, WebSocketImpl: ws.WebSocketImpl, timers: clock.timers, now: clock.now,
    storagePath, logger, onEvent: event => events.push(event), onStatus: value => statuses.push(value), ...options,
  })
  return { clock, fake, ws, source, events, statuses, lines }
}

function connectLast(ws) {
  const socket = ws.last()
  socket.serverOpen()
  socket.serverAuthReply(0)
  return socket
}

function assertNoSecrets(text, extra = []) {
  for (const secret of [...SECRETS, ...extra])
    assert.ok(!text.includes(secret), `leaked ${secret.slice(0, 4)}…`)
}

test('reads the four BILIBILI_OPEN_* variables and reports problems by name only', () => {
  assert.deepEqual(Object.values(BILIBILI_ENV_NAMES),
    ['BILIBILI_OPEN_ACCESS_KEY_ID', 'BILIBILI_OPEN_ACCESS_KEY_SECRET', 'BILIBILI_OPEN_APP_ID', 'BILIBILI_OPEN_CODE'])
  const good = readBilibiliConfig(env)
  assert.equal(good.configured, true)
  assert.deepEqual(good.credentials, credentials)

  const partial = readBilibiliConfig({ BILIBILI_OPEN_ACCESS_KEY_ID: 'present-id-value', BILIBILI_OPEN_APP_ID: '' })
  assert.equal(partial.configured, false)
  assert.equal(partial.credentials, null)
  assert.deepEqual(partial.missing, ['BILIBILI_OPEN_ACCESS_KEY_SECRET', 'BILIBILI_OPEN_APP_ID', 'BILIBILI_OPEN_CODE'])

  const bad = readBilibiliConfig({ ...env, BILIBILI_OPEN_APP_ID: '12ab', BILIBILI_OPEN_ACCESS_KEY_SECRET: 'has space' })
  assert.deepEqual(bad.invalid, ['BILIBILI_OPEN_ACCESS_KEY_SECRET', 'BILIBILI_OPEN_APP_ID'])
  assert.equal(readBilibiliConfig({ ...env, BILIBILI_OPEN_APP_ID: '99999999999999999' }).configured, false)
  assert.equal(readBilibiliConfig({ ...env, BILIBILI_OPEN_CODE: ' TESTIDCODE789' }).configured, false)

  const message = describeConfigProblem(bad)
  assert.match(message, /BILIBILI_OPEN_APP_ID（应为纯数字的项目 ID）/)
  assert.ok(!message.includes('has space') && !message.includes('12ab'))
  assert.match(describeConfigProblem(partial), /未设置[\s\S]*BILIBILI_OPEN_CODE/)
  assert.ok(!describeConfigProblem(partial).includes('present-id-value'))
})

test('an unconfigured source refuses to start without any network call', async () => {
  const { source, fake, ws } = setup({ sourceEnv: { BILIBILI_OPEN_CODE: 'ONLY-CODE-VALUE' } })
  assert.deepEqual(source.status(), { state: 'unconfigured', roomId: null, hasGame: false, lastEventAgeMs: null, errorCode: 'NOT_CONFIGURED' })
  await assert.rejects(source.start(), (error) => {
    assert.ok(error instanceof BilibiliConfigError)
    assert.deepEqual(error.missing, ['BILIBILI_OPEN_ACCESS_KEY_ID', 'BILIBILI_OPEN_ACCESS_KEY_SECRET', 'BILIBILI_OPEN_APP_ID'])
    assert.ok(!error.message.includes('ONLY-CODE-VALUE'))
    return true
  })
  await source.stop()
  assert.equal(fake.calls.length, 0)
  assert.equal(ws.sockets.length, 0)
  assert.equal(source.status().state, 'unconfigured')
})

test('start → op7 first frame → 20 s heartbeats on both channels → events → stop ends the game', async (context) => {
  const storagePath = await tempPath(context)
  const { clock, fake, ws, source, events, statuses } = setup({ storagePath })
  await source.start()
  assert.deepEqual(fake.paths(), ['/v2/app/start'])
  assert.equal(JSON.parse(await readFile(storagePath, 'utf8')).gameId, 'game-1')
  assert.equal((await stat(storagePath)).mode & 0o777, 0o600)
  assert.equal(ws.sockets.length, 1)
  assert.equal(ws.last().url, 'wss://ws-a.test/sub')
  const socket = connectLast(ws)
  assert.deepEqual(socket.sentOps, [OP.AUTH])
  assert.equal(socket.sentPackets[0].body.toString(), '{"key":"auth-for-game-1"}')
  assert.deepEqual(source.status(), { state: 'connected', roomId: 4_242, hasGame: true, lastEventAgeMs: null, errorCode: null })

  await clock.advance(20_000)
  socket.serverSend(encodePacket(OP.HEARTBEAT_REPLY, ''))
  await clock.advance(20_000)
  assert.deepEqual(fake.paths(), ['/v2/app/start', '/v2/app/heartbeat', '/v2/app/heartbeat'])
  assert.deepEqual(socket.sentOps, [OP.AUTH, OP.HEARTBEAT, OP.HEARTBEAT])

  const batch = cmds => Buffer.concat(cmds.map(cmd => encodePacket(OP.MESSAGE, JSON.stringify(fixture(cmd)))))
  socket.serverSend(encodePacket(OP.MESSAGE, deflateSync(batch([CMD.DM, CMD.SEND_GIFT, CMD.DM])), { version: VERSION.ZLIB }))
  socket.serverSend(encodePacket(OP.MESSAGE, brotliCompressSync(batch([CMD.SUPER_CHAT, CMD.GUARD])), { version: VERSION.BROTLI }))
  assert.deepEqual(events.map(event => event.type), ['danmaku', 'gift', 'superchat', 'guard'], 'the repeated DM is dropped')
  assert.equal(events[2].amountCny, 30)
  await clock.advance(5_000)
  assert.equal(source.status().lastEventAgeMs, 5_000)

  await source.stop()
  assert.deepEqual(fake.paths().slice(-1), ['/v2/app/end'])
  assert.deepEqual(fake.calls.at(-1).body, { app_id: 1_234_567_890_123, game_id: 'game-1' })
  assert.deepEqual(clock.pending, [], 'every timer is cleared')
  assert.equal(socket.closeCalls.length > 0, true)
  await assert.rejects(stat(storagePath), { code: 'ENOENT' })
  assert.deepEqual(source.status(), { state: 'stopped', roomId: 4_242, hasGame: false, lastEventAgeMs: 5_000, errorCode: null })
  assert.deepEqual(statuses.map(value => value.state), ['starting', 'connecting', 'connected', 'stopping', 'stopped'])
  await clock.advance(120_000)
  assert.equal(fake.paths().filter(path => path === '/v2/app/heartbeat').length, 2)
})

test('a stale game persisted by a crashed process is ended before the new start', async (context) => {
  const storagePath = await tempPath(context)
  const first = setup({ storagePath, script: { '/v2/app/start': [startResponse({ gameId: 'crashed' })] } })
  await first.source.start() // "crash": never stopped
  const second = setup({ storagePath, script: { '/v2/app/start': [startResponse({ gameId: 'next' })] } })
  await second.source.start()
  assert.deepEqual(second.fake.paths(), ['/v2/app/end', '/v2/app/start'])
  assert.equal(second.fake.calls[0].body.game_id, 'crashed')
  await second.source.stop()
  first.source.stop().catch(() => {})
})

test('repeated socket failures end the game and start a new one with a fresh auth body', async () => {
  const { clock, fake, ws, source, statuses } = setup({
    script: { '/v2/app/start': [startResponse({ gameId: 'game-1' }), startResponse({ gameId: 'game-2', links: ['wss://ws-c.test/sub'] })] },
  })
  await source.start()
  ws.last().serverFail()
  await clock.advance(1_000)
  assert.equal(ws.last().url, 'wss://ws-b.test/sub')
  ws.last().serverFail()
  await clock.advance(2_000)
  assert.equal(source.status().state, 'connecting')
  ws.last().serverFail()
  await clock.advance(0)
  assert.deepEqual(fake.paths(), ['/v2/app/start', '/v2/app/end', '/v2/app/start'])
  assert.equal(fake.calls[1].body.game_id, 'game-1')
  assert.equal(ws.sockets.length, 4)
  assert.equal(ws.last().url, 'wss://ws-c.test/sub')
  const socket = connectLast(ws)
  assert.equal(socket.sentPackets[0].body.toString(), '{"key":"auth-for-game-2"}')
  assert.equal(source.status().state, 'connected')
  assert.ok(statuses.some(value => value.state === 'reconnecting'))
  assert.ok(statuses.some(value => value.state === 'restarting'))
  await source.stop()
  assert.equal(fake.calls.at(-1).body.game_id, 'game-2')
  assert.deepEqual(clock.pending, [])
})

test('heartbeat expiry (7003) and INTERACTION_END for the current game both restart it', async () => {
  const expired = setup({
    script: { '/v2/app/start': [startResponse({ gameId: 'game-1' }), startResponse({ gameId: 'game-2' })], '/v2/app/heartbeat': [{ code: 7003 }, { code: 0 }] },
  })
  await expired.source.start()
  connectLast(expired.ws)
  await expired.clock.advance(20_000)
  assert.deepEqual(expired.fake.paths(), ['/v2/app/start', '/v2/app/heartbeat', '/v2/app/end', '/v2/app/start'])
  await expired.source.stop()

  const ended = setup({ script: { '/v2/app/start': [startResponse({ gameId: 'game-1' }), startResponse({ gameId: 'game-2' })] } })
  await ended.source.start()
  const socket = connectLast(ended.ws)
  socket.serverMessage({ cmd: CMD.INTERACTION_END, data: { game_id: 'some-older-game', timestamp: 1 } })
  await ended.clock.advance(0)
  assert.deepEqual(ended.fake.paths(), ['/v2/app/start'], 'another game id is ignored')
  socket.serverMessage(fixture(CMD.INTERACTION_END))
  await ended.clock.advance(0)
  assert.deepEqual(ended.fake.paths(), ['/v2/app/start', '/v2/app/end', '/v2/app/start'])
  assert.equal(ended.events.filter(event => event.type === 'interaction-end').length, 2)
  await ended.source.stop()
  assert.deepEqual(ended.clock.pending, [])
})

test('a failed restart retries later when transient and stops on a permanent error', async () => {
  const transient = setup({ script: { '/v2/app/start': [startResponse(), new Error('offline')], '/v2/app/end': [{ code: 0 }] } })
  await transient.source.start()
  connectLast(transient.ws)
  transient.ws.last().serverMessage(fixture(CMD.INTERACTION_END))
  // 6 attempts with 2/4/8/16/32 s backoff, then a 30 s restart timer.
  await transient.clock.advance(62_000)
  assert.equal(transient.fake.paths().filter(path => path === '/v2/app/start').length, 7)
  assert.equal(transient.source.status().state, 'restarting')
  assert.equal(transient.source.status().errorCode, 'NETWORK')
  assert.deepEqual(transient.clock.pending, [30_000])
  await transient.source.stop()
  assert.deepEqual(transient.clock.pending, [])

  const permanent = setup({ script: { '/v2/app/start': [startResponse(), { code: 7007 }] } })
  await permanent.source.start()
  connectLast(permanent.ws)
  permanent.ws.last().serverMessage(fixture(CMD.INTERACTION_END))
  await permanent.clock.advance(0)
  assert.deepEqual(permanent.source.status(), { state: 'error', roomId: 4_242, hasGame: false, lastEventAgeMs: 0, errorCode: 7007 })
  assert.deepEqual(permanent.clock.pending, [])
  await permanent.source.stop()
  assert.deepEqual(permanent.fake.paths(), ['/v2/app/start', '/v2/app/end', '/v2/app/start'])
})

test('stop during a start cooldown cancels the wait without calling end', async () => {
  const { clock, fake, source } = setup({ script: { '/v2/app/start': [{ code: 7001 }] } })
  const started = source.start()
  await clock.advance(3_000)
  await source.stop()
  await started
  assert.deepEqual(fake.paths(), ['/v2/app/start'])
  assert.deepEqual(clock.pending, [])
  assert.equal(source.status().state, 'stopped')
})

test('stop during an in-flight start still ends the game that start opened', async () => {
  let release
  const { fake, ws, source, clock } = setup({
    script: { '/v2/app/start': () => new Promise((resolve) => { release = () => resolve(startResponse({ gameId: 'late' })) }) },
  })
  const started = source.start()
  await clock.advance(0)
  const stopped = source.stop()
  release()
  await stopped
  await started
  assert.deepEqual(fake.paths(), ['/v2/app/start', '/v2/app/end'])
  assert.equal(fake.calls[1].body.game_id, 'late')
  assert.equal(ws.sockets.length, 0)
  assert.deepEqual(clock.pending, [])
})

test('start can be called again after stop and start failures surface as errors', async () => {
  const { source, ws, clock } = setup({ script: { '/v2/app/start': [{ code: 4002 }, startResponse({ gameId: 'again' })] } })
  await assert.rejects(source.start(), { code: 4002 })
  assert.equal(source.status().state, 'error')
  assert.equal(source.status().errorCode, 4002)
  await source.start()
  connectLast(ws)
  assert.equal(source.status().state, 'connected')
  await Promise.all([source.stop(), source.stop()])
  await source.start()
  assert.equal(ws.sockets.length, 2)
  await source.stop()
  assert.deepEqual(clock.pending, [])
})

test('a throwing onEvent or onStatus never breaks the source', async () => {
  const { ws, source } = setup({ onEvent: () => { throw new Error('consumer') }, onStatus: () => { throw new Error('status') } })
  await source.start()
  const socket = connectLast(ws)
  socket.serverMessage(fixture(CMD.DM))
  socket.serverMessage(fixture(CMD.LIKE))
  assert.equal(source.status().state, 'connected')
  await source.stop()
})

test('secrets and the auth body never appear in status() or logged output', async () => {
  const authBody = '{"key":"AUTH-BODY-SECRET-0001","group":"open"}'
  const leaky = {
    '/v2/app/start': [
      { code: 7001, message: `cooldown for ${credentials.code}` },
      startResponse({ authBody }),
      { code: 7007, message: `身份码 ${credentials.code} 无效 ${credentials.accessKeySecret}` },
    ],
    '/v2/app/heartbeat': [new Error(`net ${credentials.accessKeyId}`)],
    '/v2/app/end': [new Error(`net ${credentials.accessKeySecret}`), { code: 0 }],
  }
  const { clock, ws, source, lines, statuses } = setup({ script: leaky })
  const started = source.start()
  await clock.advance(10_000)
  await started
  const socket = connectLast(ws)
  socket.serverAuthReply(-1)
  await clock.advance(70_000)
  await clock.run(source.stop())
  const output = lines.join('\n')
  assert.ok(lines.length > 5)
  assertNoSecrets(output, ['AUTH-BODY-SECRET-0001'])
  assertNoSecrets(JSON.stringify(statuses), ['AUTH-BODY-SECRET-0001', 'game-1'])
  assertNoSecrets(JSON.stringify(source.status()), ['AUTH-BODY-SECRET-0001'])
  assert.deepEqual(Object.keys(source.status()).sort(), ['errorCode', 'hasGame', 'lastEventAgeMs', 'roomId', 'state'])
})

test('the redacting logger scrubs secrets that reach it through callback errors', async () => {
  const echo = `${credentials.code} ${credentials.accessKeySecret} {"key":"auth-for-game-1"}`
  const { source, lines, ws, clock } = setup({
    onEvent: () => { throw new Error(`consumer saw ${echo}`) },
    // Before 'connected' the auth body has not been issued yet.
    onStatus: (status) => {
      if (['connected', 'stopping', 'stopped'].includes(status.state))
        throw new Error(`status saw ${echo}`)
    },
  })
  await source.start()
  connectLast(ws)
  await clock.advance(20_000)
  ws.last().serverMessage(fixture(CMD.DM))
  await source.stop()
  assert.ok(lines.some(line => line.includes('consumer saw')))
  assert.ok(lines.some(line => line.includes('status saw')))
  assertNoSecrets(lines.join('\n'), ['auth-for-game-1'])
})
