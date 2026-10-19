import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { callOpenLive, createOpenLive, createSessionStore, OpenLiveError, parseStartData } from './open-live.mjs'
import { OPEN_LIVE_ORIGIN } from './sign.mjs'
import { createCapturingLogger, createFakeClock, createFakeFetch, credentials, startResponse } from './testing.mjs'

async function tempPath(context) {
  const directory = await mkdtemp(join(tmpdir(), 'airi-bili-open-live-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  return join(directory, '.data', 'live', 'bilibili-session.json')
}

function setup({ script = {}, store = null, ...options } = {}) {
  const clock = createFakeClock()
  const fake = createFakeFetch(script)
  const { logger, lines } = createCapturingLogger()
  let uuid = 0
  const lost = []
  const live = createOpenLive({
    credentials, fetchImpl: fake.fetchImpl, now: clock.now, timers: clock.timers, store, logger,
    randomUUID: () => `nonce-${uuid += 1}`, onGameLost: error => lost.push(error), ...options,
  })
  return { clock, fake, live, lines, lost }
}

test('every call is a signed POST of JSON to the fixed origin and success means body.code === 0', async () => {
  const { fetchImpl, calls } = createFakeFetch({ '/v2/app/heartbeat': [{ code: 0, data: { ok: 1 } }] })
  const data = await callOpenLive('/v2/app/heartbeat', { game_id: 'g' }, {
    credentials, fetchImpl, now: () => 1_760_000_000_500, randomUUID: () => 'fixed-nonce',
  })
  assert.deepEqual(data, { ok: 1 })
  assert.equal(calls[0].url, `${OPEN_LIVE_ORIGIN}/v2/app/heartbeat`)
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.redirect, 'error')
  assert.equal(calls[0].init.body, '{"game_id":"g"}')
  assert.equal(calls[0].headers['x-bili-timestamp'], '1760000000')
  assert.equal(calls[0].headers['x-bili-signature-nonce'], 'fixed-nonce')
  assert.equal(calls[0].headers['x-bili-accesskeyid'], credentials.accessKeyId)
  assert.match(calls[0].headers.Authorization, /^[0-9a-f]{64}$/)
})

test('API, network and malformed-body failures become typed errors without leaking the request', async () => {
  const cases = [
    [{ code: 7007, message: `bad ${credentials.code}` }, 7007, false],
    [new Error(`connect failed ${credentials.accessKeySecret}`), 'NETWORK', true],
    ['<html>gateway</html>', 'BAD_RESPONSE', true],
    [{ message: 'no code' }, 'BAD_RESPONSE', true],
    [{ code: 4009 }, 4009, true],
  ]
  for (const [reply, code, transient] of cases) {
    const { fetchImpl } = createFakeFetch({ '/v2/app/start': [reply] })
    const error = await callOpenLive('/v2/app/start', { code: credentials.code, app_id: 1 }, { credentials, fetchImpl })
      .then(() => null, value => value)
    assert.ok(error instanceof OpenLiveError)
    assert.equal(error.code, code)
    assert.equal(error.transient, transient)
    assert.equal(error.path, '/v2/app/start')
    for (const secret of Object.values(credentials).filter(value => value !== credentials.appId))
      assert.ok(!error.message.includes(secret), `message leaks ${secret}`)
  }
})

test('start parses game id, auth body, wss links and anchor info, then persists the game id (0600)', async (context) => {
  const path = await tempPath(context)
  const { fake, live, clock } = setup({
    script: { '/v2/app/start': [startResponse({ gameId: 'game-xyz', links: ['wss://a.test/sub', 'http://not-wss', 3, 'wss://b.test/sub'] })] },
    store: createSessionStore(path),
  })
  const session = await live.start()
  assert.deepEqual(fake.calls[0].body, { code: credentials.code, app_id: 1_234_567_890_123 })
  assert.equal(session.gameId, 'game-xyz')
  assert.equal(session.authBody, '{"key":"auth-for-game-xyz"}')
  assert.deepEqual(session.wssLinks, ['wss://a.test/sub', 'wss://b.test/sub'])
  assert.deepEqual(session.anchor, { roomId: 4_242, name: '主播本人', face: 'https://i0.hdslb.test/face.jpg', openId: 'anchor-open-id' })
  const record = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(record.version, 1)
  assert.equal(record.gameId, 'game-xyz')
  assert.equal(record.startedAt, new Date(clock.now()).toISOString())
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  for (const secret of Object.values(credentials))
    assert.ok(!(await readFile(path, 'utf8')).includes(secret))
  await live.end()
  await assert.rejects(stat(path), { code: 'ENOENT' })
})

test('HTTP heartbeats run every 20 s while a game is open and stop on end', async () => {
  const { fake, live, clock } = setup({ script: { '/v2/app/start': [startResponse()] } })
  await live.start()
  await clock.advance(19_999)
  assert.deepEqual(fake.paths(), ['/v2/app/start'])
  await clock.advance(1)
  await clock.advance(20_000)
  await clock.advance(20_000)
  assert.deepEqual(fake.paths(), ['/v2/app/start', '/v2/app/heartbeat', '/v2/app/heartbeat', '/v2/app/heartbeat'])
  assert.deepEqual(fake.calls[1].body, { game_id: 'game-1' })
  assert.deepEqual(await live.end(), { ended: true })
  assert.deepEqual(fake.calls.at(-1).body, { app_id: 1_234_567_890_123, game_id: 'game-1' })
  assert.deepEqual(clock.pending, [])
  await clock.advance(60_000)
  assert.equal(fake.paths().filter(path => path === '/v2/app/heartbeat').length, 3)
  assert.deepEqual(await live.end(), { ended: false })
})

test('7001 cooldown waits ~10 s and retries', async () => {
  const { fake, live, clock } = setup({ script: { '/v2/app/start': [{ code: 7001 }, startResponse()] } })
  const started = live.start()
  await clock.advance(9_999)
  assert.equal(fake.calls.length, 1)
  await clock.advance(1)
  assert.equal((await started).gameId, 'game-1')
  assert.deepEqual(fake.paths(), ['/v2/app/start', '/v2/app/start'])
})

test('7002 duplicate game ends the stale persisted game then starts again', async (context) => {
  const store = createSessionStore(await tempPath(context))
  await store.write({ gameId: 'stale-game' })
  // The first clean-up cannot reach the platform, so the stale game survives
  // into start, which reports 7002; the retry path ends it and starts again.
  const offline = new Error('offline')
  const { fake, live, clock } = setup({
    store,
    script: {
      '/v2/app/end': [offline, offline, offline, { code: 0 }],
      '/v2/app/start': [{ code: 7002 }, startResponse({ gameId: 'fresh' })],
    },
  })
  const started = live.start()
  assert.equal((await clock.run(started)).gameId, 'fresh')
  assert.deepEqual(fake.paths(),
    ['/v2/app/end', '/v2/app/end', '/v2/app/end', '/v2/app/start', '/v2/app/end', '/v2/app/start'])
  assert.deepEqual(fake.calls[4].body, { app_id: 1_234_567_890_123, game_id: 'stale-game' })
  assert.equal((await store.read()).gameId, 'fresh')
})

test('7002 without a known stale game waits for the cooldown and retries', async () => {
  const { fake, live, clock } = setup({ script: { '/v2/app/start': [{ code: 7002 }, startResponse()] } })
  const started = live.start()
  await clock.advance(9_999)
  assert.equal(fake.calls.length, 1)
  await clock.advance(1)
  assert.equal((await started).gameId, 'game-1')
})

test('4009 rate limiting backs off exponentially, then gives up with a typed error', async () => {
  const { fake, live, clock } = setup({ script: { '/v2/app/start': [{ code: 4009 }] }, maxStartAttempts: 4 })
  const started = live.start().then(() => null, error => error)
  const times = []
  for (const step of [2_000, 4_000, 8_000]) {
    await clock.advance(step - 1)
    times.push(fake.calls.length)
    await clock.advance(1)
  }
  const error = await started
  assert.deepEqual(times, [1, 2, 3])
  assert.equal(fake.calls.length, 4)
  assert.ok(error instanceof OpenLiveError)
  assert.equal(error.code, 4009)
})

test('non-retryable codes surface immediately as typed errors', async () => {
  const { fake, live } = setup({ script: { '/v2/app/start': [{ code: 7007, message: '身份码错误' }] } })
  await assert.rejects(live.start(), (error) => {
    assert.ok(error instanceof OpenLiveError)
    assert.equal(error.code, 7007)
    assert.equal(error.retryable, false)
    assert.match(error.message, /身份码/)
    return true
  })
  assert.equal(fake.calls.length, 1)
})

test('a start response without auth body or links is rejected and its game is ended', async () => {
  const response = startResponse({ gameId: 'half', links: [] })
  const { fake, live } = setup({ script: { '/v2/app/start': [response] } })
  await assert.rejects(live.start(), { code: 'BAD_START_RESPONSE' })
  assert.deepEqual(fake.paths(), ['/v2/app/start', '/v2/app/end'])
  assert.throws(() => parseStartData({ game_info: { game_id: 'g' }, websocket_info: { auth_body: '', wss_link: ['wss://a'] } }),
    { code: 'BAD_START_RESPONSE' })
})

test('on start, a stale persisted game is ended first and its record removed', async (context) => {
  const path = await tempPath(context)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify({ version: 1, gameId: 'crashed-game', startedAt: '2026-10-18T00:00:00Z' }))
  const { fake, live } = setup({ script: { '/v2/app/start': [startResponse({ gameId: 'next' })] }, store: createSessionStore(path) })
  await live.start()
  assert.deepEqual(fake.paths(), ['/v2/app/end', '/v2/app/start'])
  assert.deepEqual(fake.calls[0].body, { app_id: 1_234_567_890_123, game_id: 'crashed-game' })
  assert.equal(JSON.parse(await readFile(path, 'utf8')).gameId, 'next')
})

test('a stale game the platform no longer knows is treated as ended; an unreachable one keeps its record', async (context) => {
  const goneStore = createSessionStore(await tempPath(context))
  await goneStore.write({ gameId: 'gone' })
  const gone = setup({ script: { '/v2/app/end': [{ code: 7003 }], '/v2/app/start': [{ code: 7007 }] }, store: goneStore })
  await assert.rejects(gone.live.start(), { code: 7007 })
  assert.equal(await goneStore.read(), null)

  const keptStore = createSessionStore(await tempPath(context))
  await keptStore.write({ gameId: 'unreachable' })
  const kept = setup({ script: { '/v2/app/end': [new Error('offline')], '/v2/app/start': [{ code: 7007 }] }, store: keptStore })
  await assert.rejects(kept.clock.run(kept.live.start()), { code: 7007 })
  assert.deepEqual(kept.fake.paths(), ['/v2/app/end', '/v2/app/end', '/v2/app/end', '/v2/app/start'])
  assert.equal((await keptStore.read()).gameId, 'unreachable')
  assert.ok(kept.lines.some(line => line.includes('结束场次失败')))

  const signedStore = createSessionStore(await tempPath(context))
  await signedStore.write({ gameId: 'bad-signature' })
  const signed = setup({ script: { '/v2/app/end': [{ code: 4002 }], '/v2/app/start': [{ code: 4002 }] }, store: signedStore })
  await assert.rejects(signed.live.start(), { code: 4002 })
  assert.deepEqual(signed.fake.paths(), ['/v2/app/end', '/v2/app/start'], 'a credential error is not retried')
  assert.equal((await signedStore.read()).gameId, 'bad-signature', 'and does not count as the game being gone')
})

test('corrupted or oversized session files are ignored instead of crashing start', async (context) => {
  for (const contents of ['not json', '{"version":2,"gameId":"x"}', JSON.stringify({ version: 1, gameId: 'x'.repeat(5_000) })]) {
    const path = await tempPath(context)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, contents)
    const { fake, live } = setup({ script: { '/v2/app/start': [startResponse()] }, store: createSessionStore(path) })
    await live.start()
    assert.deepEqual(fake.paths(), ['/v2/app/start'])
  }
})

test('heartbeat 7003 or repeated failures report the game as lost', async () => {
  const expired = setup({ script: { '/v2/app/start': [startResponse()], '/v2/app/heartbeat': [{ code: 7003 }] } })
  await expired.live.start()
  await expired.clock.advance(20_000)
  assert.equal(expired.lost.length, 1)
  assert.equal(expired.lost[0].code, 7003)
  assert.deepEqual(expired.clock.pending, [])

  const flaky = setup({ script: { '/v2/app/start': [startResponse()], '/v2/app/heartbeat': [new Error('a'), { code: 0 }, new Error('b'), new Error('c'), new Error('d')] } })
  await flaky.live.start()
  await flaky.clock.advance(80_000)
  assert.equal(flaky.lost.length, 0, 'a success resets the failure count')
  await flaky.clock.advance(20_000)
  assert.equal(flaky.lost.length, 1)
  assert.equal(flaky.lost[0].code, 'NETWORK')
  assert.ok(flaky.lines.some(line => line.includes('第 1 次')))
})

test('an aborted start stops waiting and ends a game that started during the abort', async () => {
  const cooling = setup({ script: { '/v2/app/start': [{ code: 7001 }] } })
  const controller = new AbortController()
  const waiting = cooling.live.start({ signal: controller.signal })
  await cooling.clock.advance(1_000)
  controller.abort(new Error('stopped'))
  await assert.rejects(waiting, /stopped/)
  assert.deepEqual(cooling.clock.pending, [])

  let release
  const slow = setup({ script: { '/v2/app/start': () => new Promise((resolve) => { release = () => resolve(startResponse({ gameId: 'late' })) }) } })
  const late = new AbortController()
  const starting = slow.live.start({ signal: late.signal })
  await slow.clock.advance(0)
  late.abort(new Error('stopped'))
  release()
  await assert.rejects(starting, /stopped/)
  assert.deepEqual(slow.fake.paths(), ['/v2/app/start', '/v2/app/end'])
  assert.deepEqual(slow.fake.calls[1].body.game_id, 'late')
  assert.equal(slow.live.session, null)
})

test('end retries transient failures briefly and never throws', async () => {
  const { fake, live, clock } = setup({ script: { '/v2/app/start': [startResponse()], '/v2/app/end': [{ code: 5000 }, { code: 0 }] } })
  await live.start()
  assert.deepEqual(await clock.run(live.end()), { ended: true })
  assert.deepEqual(fake.paths(), ['/v2/app/start', '/v2/app/end', '/v2/app/end'])
})

test('an empty game id (no game to keep alive) skips heartbeats and end', async () => {
  const { fake, live, clock, lines } = setup({ script: { '/v2/app/start': [startResponse({ gameId: '' })] } })
  await live.start()
  await clock.advance(60_000)
  assert.deepEqual(await live.end(), { ended: false })
  assert.deepEqual(fake.paths(), ['/v2/app/start'])
  assert.ok(lines.some(line => line.includes('game_id')))
})
