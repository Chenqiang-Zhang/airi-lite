import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createRequestHandler } from '../app.mjs'
import { parseRules } from './moderation.mjs'
import { countRuleTerms, resolveProfile, runPreflight, STALE_LOCK_MS } from './preflight.mjs'
import { createLiveRuntime } from './runtime.mjs'

// Nothing here reaches a paid provider: DeepSeek is never called by the
// checklist, and the only probe is an injected fake or a loopback server.
const NOW = Date.parse('2026-10-20T12:00:00Z')
const READY_STAGE = { ready: true, avatar: 'ready', obs: { active: true, visible: true, streaming: false } }
const CLOUD_SPEECH = { configured: true, provider: 'minimax', model: 'speech-2.8-turbo', region: 'cn' }
const LOCAL_SPEECH = { configured: true, provider: 'local', model: 'cosyvoice' }
const refuseProbe = async () => { throw new Error('no probe expected') }

async function temporaryDirectory(context) {
  const directory = await mkdtemp(join(tmpdir(), 'airi-preflight-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

// Everything passes; each test changes one thing.
function passing(dataDirectory, overrides = {}) {
  return {
    env: { DEEPSEEK_API_KEY: 'test-only' },
    deepseek: { configured: true, model: 'deepseek-flash' },
    speech: CLOUD_SPEECH,
    dataDirectory,
    moderation: { loaded: true, problem: null, terms: 3, ignored: 0 },
    stage: READY_STAGE,
    probe: refuseProbe,
    now: () => NOW,
    ...overrides,
  }
}

const byId = (result, id) => result.checks.find(check => check.id === id)
const failed = result => result.checks.filter(check => !check.ok).map(check => check.id)

test('a ready cloud host passes every check, each with a detail and no fix', async (context) => {
  const result = await runPreflight(passing(await temporaryDirectory(context)))
  assert.equal(result.profile, 'cloud')
  assert.equal(result.ok, true)
  assert.equal(result.at, NOW)
  assert.deepEqual(result.checks.map(check => check.id), ['profile', 'deepseek', 'tts', 'ledger', 'replies', 'moderation', 'stage', 'avatar', 'obs'])
  for (const check of result.checks) {
    assert.deepEqual(Object.keys(check), ['id', 'ok', 'detail', 'fix'])
    assert.equal(typeof check.detail, 'string')
    assert.equal(check.fix, null)
  }
})

test('a missing DeepSeek key fails with a fix that names the variable', async (context) => {
  const result = await runPreflight(passing(await temporaryDirectory(context), { deepseek: { configured: false, model: 'deepseek-flash' } }))
  assert.equal(result.ok, false)
  assert.deepEqual(failed(result), ['deepseek'])
  assert.match(byId(result, 'deepseek').fix, /DEEPSEEK_API_KEY/)
})

test('unconfigured or mismatched TTS fails for the selected profile', async (context) => {
  const directory = await temporaryDirectory(context)
  const unconfigured = await runPreflight(passing(directory, { speech: { configured: false, provider: 'minimax', model: 'speech-2.8-turbo' } }))
  assert.deepEqual(failed(unconfigured), ['tts'])
  assert.match(byId(unconfigured, 'tts').fix, /MINIMAX_TTS_ENABLED=1/)
  const eleven = await runPreflight(passing(directory, { speech: { configured: false, provider: 'elevenlabs', model: 'eleven_v4' } }))
  assert.match(byId(eleven, 'tts').fix, /ELEVENLABS_TTS_ENABLED=1/)
  const unavailable = await runPreflight(passing(directory, { speech: { configured: false, provider: 'unavailable', model: '' } }))
  assert.deepEqual(failed(unavailable), ['tts'])
  assert.deepEqual(failed(await runPreflight(passing(directory, { speech: null }))), ['tts'])
  // A cloud host that selected the local engine is told to switch profile.
  const local = await runPreflight(passing(directory, { speech: LOCAL_SPEECH }))
  assert.deepEqual(failed(local), ['tts'])
  assert.match(byId(local, 'tts').fix, /AIRI_PROFILE/)
})

test('local-voice needs the local provider and a reachable LOCAL_TTS_URL host', async (context) => {
  const directory = await temporaryDirectory(context)
  const env = { AIRI_PROFILE: 'local-voice', LOCAL_TTS_URL: 'http://127.0.0.1:9880/v1/audio/speech' }
  const probes = []
  const reachable = await runPreflight(passing(directory, {
    env, speech: LOCAL_SPEECH,
    probe: async (url, init) => { probes.push([url, init.method, init.redirect]); return new Response(null, { status: 405 }) },
  }))
  assert.equal(reachable.profile, 'local-voice')
  assert.equal(reachable.ok, true)
  assert.deepEqual(reachable.checks.map(check => check.id), ['profile', 'deepseek', 'tts', 'local-tts', 'ledger', 'replies', 'moderation', 'stage', 'avatar', 'obs'])
  // Only the origin is probed, cheaply.
  assert.deepEqual(probes, [['http://127.0.0.1:9880/', 'HEAD', 'manual']])
  assert.match(byId(reachable, 'local-tts').detail, /127\.0\.0\.1:9880 可达（HTTP 405）/)
  // A URL the local provider would refuse fails without a probe, and its
  // credential or query is never shown.
  for (const [url, reason] of [
    ['http://user:secret@127.0.0.1:9880/', /用户名或密码/],
    ['http://127.0.0.1:9880/?token=abc', /\? 或 #/],
    ['http://tts.example.com:9880/', /局域网 IP 或 localhost/],
    ['', /没有 LOCAL_TTS_URL/],
  ]) {
    const before = probes.length
    const refused = await runPreflight(passing(directory, { env: { ...env, LOCAL_TTS_URL: url }, speech: LOCAL_SPEECH, probe: async (...args) => { probes.push(args); return new Response(null, { status: 200 }) } }))
    assert.deepEqual(failed(refused), ['local-tts'], url)
    assert.match(byId(refused, 'local-tts').detail, reason)
    assert.match(byId(refused, 'local-tts').fix, /基础地址/)
    assert.equal(probes.length, before, 'no probe of a refused URL')
    assert.doesNotMatch(JSON.stringify(refused), /secret|token=abc/)
  }

  const down = await runPreflight(passing(directory, { env, speech: LOCAL_SPEECH, probe: async () => { throw new TypeError('fetch failed') } }))
  assert.deepEqual(failed(down), ['local-tts'])
  assert.match(byId(down, 'local-tts').detail, /连接失败/)
  assert.doesNotMatch(JSON.stringify(down), /secret/)

  const slow = await runPreflight(passing(directory, {
    env, speech: LOCAL_SPEECH, probeTimeoutMs: 20,
    probe: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
  }))
  assert.match(byId(slow, 'local-tts').detail, /秒内没有响应/)

  for (const LOCAL_TTS_URL of [undefined, '', 'not a url', 'file:///etc/passwd']) {
    const result = await runPreflight(passing(directory, { env: { AIRI_PROFILE: 'local-voice', LOCAL_TTS_URL }, speech: LOCAL_SPEECH }))
    assert.deepEqual(failed(result), ['local-tts'], String(LOCAL_TTS_URL))
    assert.match(byId(result, 'local-tts').fix, /LOCAL_TTS_URL/)
  }
  // The local profile with a cloud provider is a mismatch, not a pass.
  const cloud = await runPreflight(passing(directory, { env, probe: async () => new Response(null), speech: CLOUD_SPEECH }))
  assert.deepEqual(failed(cloud), ['tts'])
})

test('an unknown AIRI_PROFILE fails closed and the rest is checked as cloud', async (context) => {
  assert.deepEqual(resolveProfile({}), { profile: 'cloud', requested: 'cloud', valid: true })
  assert.deepEqual(resolveProfile({ AIRI_PROFILE: ' local-voice ' }), { profile: 'local-voice', requested: 'local-voice', valid: true })
  const result = await runPreflight(passing(await temporaryDirectory(context), { env: { AIRI_PROFILE: 'locall' } }))
  assert.equal(result.profile, 'cloud')
  assert.deepEqual(failed(result), ['profile'])
  assert.match(byId(result, 'profile').fix, /cloud 或 local-voice/)
})

test('a stale ledger lock fails with removal instructions; an in-flight one does not', async (context) => {
  const directory = await temporaryDirectory(context)
  await mkdir(join(directory, 'tts-budget.json.lock'))
  await mkdir(join(directory, 'live-reply-budget.json.lock'))
  const old = new Date(NOW - 5 * 60_000)
  await utimes(join(directory, 'tts-budget.json.lock'), old, old)
  const fresh = new Date(NOW - 1_000)
  await utimes(join(directory, 'live-reply-budget.json.lock'), fresh, fresh)
  const result = await runPreflight(passing(directory))
  assert.deepEqual(failed(result), ['ledger'])
  const ledger = byId(result, 'ledger')
  assert.match(ledger.detail, /tts-budget\.json\.lock（5 分钟前）/)
  assert.doesNotMatch(ledger.detail, /live-reply-budget/, 'a lock younger than the threshold is a reservation in progress')
  assert.match(ledger.fix, /删除/)
  assert.match(ledger.fix, /npm run live/)
  // The write probe leaves nothing behind.
  assert.deepEqual((await readdir(directory)).sort(), ['live-reply-budget.json.lock', 'tts-budget.json.lock'])
  assert.ok(STALE_LOCK_MS >= 10_000)
})

test('an unwritable data directory fails the ledger check', async (context) => {
  const directory = await temporaryDirectory(context)
  const denied = Object.assign(new Error('denied'), { code: 'EACCES' })
  const fs = { mkdir: async () => {}, writeFile: async () => { throw denied }, unlink: async () => {}, readdir: async () => [], stat: async () => null }
  const result = await runPreflight(passing(directory, { fs }))
  assert.deepEqual(failed(result), ['ledger'])
  assert.match(byId(result, 'ledger').detail, /EACCES/)
  // Tests and runs without a data directory keep their ledgers in memory.
  assert.equal(byId(await runPreflight(passing(null)), 'ledger').ok, true)
})

test('the host blocklist must be loaded and non-empty', async (context) => {
  const directory = await temporaryDirectory(context)
  const cases = [
    [{ loaded: false, problem: null, terms: 0 }, /还在读取/],
    [{ loaded: true, problem: 'blocklist-unreadable', terms: 0 }, /读取失败/],
    [{ loaded: true, problem: null, terms: 0 }, /没有主播自己的屏蔽词/],
  ]
  for (const [moderation, detail] of cases) {
    const result = await runPreflight(passing(directory, { moderation }))
    assert.deepEqual(failed(result), ['moderation'])
    assert.match(byId(result, 'moderation').detail, detail)
    assert.match(byId(result, 'moderation').fix, /blocklist\.txt|重新检查/)
  }
  const partial = await runPreflight(passing(directory, { moderation: { loaded: true, problem: 'blocklist-terms-ignored', terms: 2, ignored: 1 } }))
  assert.equal(partial.ok, true, 'usable terms are loaded; the ignored ones are shown as a warning')
  assert.match(byId(partial, 'moderation').detail, /2 条.*1 条无法使用/)
  assert.equal(countRuleTerms(parseRules('坏词\navoid: 敏感\ncrisis: 危机\nsb\n+v\n❤️')), 6)
  assert.equal(countRuleTerms(null), 0)
})

test('no primary stage fails the stage, avatar and OBS checks', async (context) => {
  const result = await runPreflight(passing(await temporaryDirectory(context), { stage: null, stageUrl: 'http://127.0.0.1:4176/airi/stage.html?role=obs' }))
  assert.deepEqual(failed(result), ['stage', 'avatar', 'obs'])
  assert.match(byId(result, 'stage').fix, /4176\/airi\/stage\.html\?role=obs/)
})

test('a stage that is not ready or has no avatar yet fails', async (context) => {
  const directory = await temporaryDirectory(context)
  assert.deepEqual(failed(await runPreflight(passing(directory, { stage: { ...READY_STAGE, ready: false } }))), ['stage'])
  for (const avatar of ['unknown', 'loading', 'failed', 'weird']) {
    const result = await runPreflight(passing(directory, { stage: { ...READY_STAGE, avatar } }))
    assert.deepEqual(failed(result), ['avatar'], avatar)
    assert.ok(byId(result, 'avatar').fix)
  }
})

test('an inactive OBS source fails; a page outside OBS passes with a note', async (context) => {
  const directory = await temporaryDirectory(context)
  const inactive = await runPreflight(passing(directory, { stage: { ...READY_STAGE, obs: { active: false, visible: true, streaming: true } } }))
  assert.equal(inactive.ok, false)
  assert.deepEqual(failed(inactive), ['obs'])
  assert.match(inactive.checks.at(-1).fix, /场景/)
  for (const obs of [null, { active: null, visible: null, streaming: null }]) {
    const outside = await runPreflight(passing(directory, { stage: { ...READY_STAGE, obs } }))
    assert.equal(outside.ok, true)
    assert.match(byId(outside, 'obs').detail, /没有 OBS 状态/)
  }
})

// ---- The route and the resume gate, through the real request handler ----

const CLIP = { audio: 'AAAA', format: 'mp3', sampleRate: 32_000, words: [] }
const fakeSpeech = (health = CLOUD_SPEECH) => ({
  health: () => health,
  async handle(_request, response) { response.writeHead(418); response.end() },
  async synthesise() { return CLIP },
})

async function start(context, { env = { DEEPSEEK_API_KEY: 'test-only' }, speech = fakeSpeech(), blocklist = '坏词\n', locks = [], probe = refuseProbe, startPaused = false, replyBudget } = {}) {
  // Removed only after the runtime has stopped (see the after hook below):
  // its audit log writes into root until then, and an rm racing it fails
  // with ENOTEMPTY, which skips the remaining hooks and leaves the server
  // open (the file then never finishes).
  const root = await mkdtemp(join(tmpdir(), 'airi-preflight-'))
  if (blocklist !== null) {
    await mkdir(join(root, '.data', 'moderation'), { recursive: true })
    await writeFile(join(root, '.data', 'moderation', 'blocklist.txt'), blocklist)
  }
  for (const name of locks) {
    await mkdir(join(root, '.data', name), { recursive: true })
    const old = new Date(Date.now() - 10 * 60_000)
    await utimes(join(root, '.data', name), old, old)
  }
  let runtime = null
  let ids = 0
  const handler = createRequestHandler({
    env: {},
    root,
    fetchImpl: async () => { throw new Error('preflight tests must not call DeepSeek') },
    speech,
    live: (deps) => {
      runtime = createLiveRuntime({ ...deps, env, probeFetch: probe, startPaused, newId: () => `id-${++ids}`, ...(replyBudget ? { replyBudget } : {}) })
      return runtime
    },
  })
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  context.after(async () => {
    await handler.stop()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  })
  await runtime.ready
  const events = []
  runtime.hub.subscribe('preflight', event => events.push(event))
  return { base: `http://127.0.0.1:${server.address().port}`, runtime, events, root }
}

const post = (base, path, body) => fetch(`${base}/airi${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Airi-Live': '1' },
  body: JSON.stringify(body),
})
const control = (base, body) => post(base, '/api/live/control', body)
const preflight = async base => (await fetch(`${base}/airi/api/live/preflight`)).json()

// Opens an OBS stage and reads its hello for the speaking lease.
async function openStage(context, base) {
  const controller = new AbortController()
  context.after(() => controller.abort())
  const response = await fetch(`${base}/airi/api/live/stage/events?role=obs`, { signal: controller.signal })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (!/event: hello\ndata: .+\n/.test(buffer)) {
    const { value, done } = await reader.read()
    if (done) throw new Error('stage stream ended before hello')
    buffer += decoder.decode(value, { stream: true })
  }
  const hello = JSON.parse(/event: hello\ndata: (.+)\n/.exec(buffer)[1])
  return {
    hello,
    report: body => post(base, '/api/live/stage/report', { leaseId: hello.leaseId, ...body }),
  }
}

async function readyStage(context, base, { obs = { active: true, visible: true, streaming: true } } = {}) {
  const stage = await openStage(context, base)
  assert.equal((await stage.report({ type: 'ready' })).status, 204)
  assert.equal((await stage.report({ type: 'avatar', status: 'ready' })).status, 204)
  if (obs)
    assert.equal((await stage.report({ type: 'obs', ...obs })).status, 204)
  return stage
}

test('GET /api/live/preflight reports the checklist and is local-only', async (context) => {
  const { base, events } = await start(context)
  const before = await preflight(base)
  assert.equal(before.ok, false)
  assert.deepEqual(failed(before), ['stage', 'avatar', 'obs'])
  assert.equal(byId(before, 'moderation').ok, true)
  assert.equal(byId(before, 'ledger').ok, true)

  await readyStage(context, base)
  const after = await preflight(base)
  assert.equal(after.ok, true, JSON.stringify(after.checks.filter(check => !check.ok)))
  // Only a changed outcome is recorded, so the console's re-checks stay quiet.
  await preflight(base)
  assert.deepEqual(events.map(event => [event.type, event.data.trigger, event.data.ok]),
    [['preflight.checked', 'check', false], ['preflight.checked', 'check', true]])
  assert.deepEqual(events[0].data.failed, ['stage', 'avatar', 'obs'])
  assert.equal(events[0].data.checks[0].fix, undefined, 'the audit line keeps id, ok and detail only')

  const crossSite = await fetch(`${base}/airi/api/live/preflight`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })
  assert.equal(crossSite.status, 403)
  const proxied = await fetch(`${base}/airi/api/live/preflight`, { headers: { 'X-Forwarded-For': '203.0.113.9' } })
  assert.equal(proxied.status, 403)
  assert.equal((await post(base, '/api/live/preflight', {})).status, 404, 'the route is read-only')
})

test('resume is refused until the checklist passes, and the refusal is audited', async (context) => {
  const { base, events } = await start(context, { env: {} })
  await readyStage(context, base)
  await control(base, { action: 'pause' })
  const refused = await control(base, { action: 'resume' })
  assert.equal(refused.status, 409)
  const body = await refused.json()
  assert.equal(body.code, 'LIVE_PREFLIGHT_FAILED')
  assert.deepEqual(failed(body.preflight), ['deepseek'])
  assert.match(byId(body.preflight, 'deepseek').fix, /DEEPSEEK_API_KEY/)
  const state = await (await fetch(`${base}/airi/api/live/state`)).json()
  assert.equal(state.control, 'paused')
  assert.deepEqual(events.at(-1).data, {
    trigger: 'resume', profile: 'cloud', ok: false, skipped: false, failed: ['deepseek'],
    checks: body.preflight.checks.map(({ id, ok, detail }) => ({ id, ok, detail })),
  })
  // A non-boolean flag is not an explicit skip.
  assert.equal((await control(base, { action: 'resume', skipPreflight: 'true' })).status, 409)
})

test('the host can skip a failing checklist explicitly; the skip is audited', async (context) => {
  const { base, events, runtime } = await start(context, { blocklist: null, locks: ['tts-budget.json.lock'] })
  const lines = []
  runtime.hub.subscribe('control', event => lines.push(event))
  await control(base, { action: 'panic' })
  const skipped = await control(base, { action: 'resume', skipPreflight: true })
  assert.equal(skipped.status, 200)
  const state = await skipped.json()
  assert.equal(state.control, 'running')
  assert.equal(state.mode, 'live')
  const record = events.at(-1).data
  assert.equal(record.trigger, 'resume')
  assert.equal(record.skipped, true)
  assert.deepEqual(record.failed, ['ledger', 'moderation', 'stage', 'avatar', 'obs'])
  assert.equal(lines.at(-1).type, 'control.changed')
  assert.equal(lines.at(-1).data.control, 'running')
})

test('a passing checklist resumes without a skip, and an inactive OBS source blocks it', async (context) => {
  const { base, events } = await start(context)
  const stage = await readyStage(context, base, { obs: { active: false, visible: true, streaming: true } })
  await control(base, { action: 'pause' })
  const blocked = await control(base, { action: 'resume' })
  assert.equal(blocked.status, 409)
  assert.deepEqual(failed((await blocked.json()).preflight), ['obs'])
  await stage.report({ type: 'obs', active: true, visible: true, streaming: true })
  const resumed = await control(base, { action: 'resume' })
  assert.equal(resumed.status, 200)
  assert.equal((await resumed.json()).control, 'running')
  assert.deepEqual(events.at(-1).data.skipped, false)
  assert.deepEqual(events.at(-1).data.failed, [])
})

test('after a paused start, the first go-live is a resume through the checklist', async (context) => {
  const { base, events } = await start(context, { startPaused: true })
  const stage = await readyStage(context, base, { obs: { active: false, visible: true, streaming: false } })
  const blocked = await control(base, { action: 'resume' })
  assert.equal(blocked.status, 409)
  assert.deepEqual(failed((await blocked.json()).preflight), ['obs'])
  await stage.report({ type: 'obs', active: true, visible: true, streaming: false })
  const live = await control(base, { action: 'resume' })
  assert.equal(live.status, 200)
  const state = await live.json()
  assert.deepEqual([state.control, state.pauseReason, state.mode], ['running', null, 'live'])
  assert.deepEqual(events.map(event => [event.data.trigger, event.data.ok, event.data.skipped]),
    [['resume', false, false], ['resume', true, false]])
})

test('a pause or panic pressed while the checklist runs wins over the resume', async (context) => {
  let probed
  const reached = new Promise(resolve => { probed = resolve })
  let release
  const held = new Promise(resolve => { release = resolve })
  // local-voice probes LOCAL_TTS_URL; hold that probe to keep resume waiting.
  const { base } = await start(context, {
    env: { DEEPSEEK_API_KEY: 'test-only', AIRI_PROFILE: 'local-voice', LOCAL_TTS_URL: 'http://127.0.0.1:9/' },
    speech: fakeSpeech(LOCAL_SPEECH),
    probe: async () => { probed(); await held; return new Response(null, { status: 404 }) },
  })
  await readyStage(context, base)
  await control(base, { action: 'pause' })
  const resume = control(base, { action: 'resume' })
  await reached
  assert.equal((await control(base, { action: 'panic' })).status, 200)
  release()
  const refused = await resume
  assert.equal(refused.status, 409)
  assert.deepEqual(await refused.json(), { code: 'LIVE_CONTROL_CHANGED' })
  const state = await (await fetch(`${base}/airi/api/live/state`)).json()
  assert.equal(state.control, 'panic')
  assert.equal(state.mode, 'brb')
})

test('the local-voice setup hint names everything the local provider needs', async (context) => {
  const directory = await temporaryDirectory(context)
  const env = { AIRI_PROFILE: 'local-voice', LOCAL_TTS_URL: 'http://127.0.0.1:9880' }
  const reachable = async () => new Response(null, { status: 404 })
  const unconfigured = await runPreflight(passing(directory, { env, speech: { configured: false, provider: 'local', model: '' }, probe: reachable }))
  assert.deepEqual(failed(unconfigured), ['tts'])
  for (const name of ['TTS_PROVIDER=local', 'LOCAL_TTS_ENABLED=1', 'LOCAL_TTS_URL', 'LOCAL_TTS_MODEL', 'LOCAL_TTS_VOICE'])
    assert.match(byId(unconfigured, 'tts').fix, new RegExp(name), name)
  const cloud = await runPreflight(passing(directory, { env, speech: CLOUD_SPEECH }))
  assert.match(byId(cloud, 'tts').fix, /LOCAL_TTS_ENABLED=1/)
})

test('a used-up daily reply budget fails the checklist; one reply left passes with a note', async (context) => {
  const directory = await temporaryDirectory(context)
  const used = await runPreflight(passing(directory, { replies: { limit: 250, reserved: 250 } }))
  assert.deepEqual(failed(used), ['replies'])
  assert.match(byId(used, 'replies').detail, /已用完（250\/250）/)
  assert.match(byId(used, 'replies').fix, /LIVE_DAILY_REPLY_LIMIT/)
  const last = await runPreflight(passing(directory, { replies: { limit: 250, reserved: 249 } }))
  assert.equal(last.ok, true)
  assert.match(byId(last, 'replies').detail, /还剩 1 次.*只够一回合/)
  assert.deepEqual(failed(await runPreflight(passing(directory, { replies: { limit: 250, reserved: null } }))), ['replies'])
})

test('resume is refused while the daily reply budget is used up', async (context) => {
  const ledger = { day: new Date().toISOString().slice(0, 10), reserved: 0 }
  const replyBudget = { peek: async () => ({ ...ledger }), reserve: async () => { ledger.reserved++; return { ...ledger } } }
  const { base } = await start(context, { env: { DEEPSEEK_API_KEY: 'test-only', LIVE_DAILY_REPLY_LIMIT: '1' }, replyBudget })
  await readyStage(context, base)
  await control(base, { action: 'pause' })
  assert.equal((await control(base, { action: 'resume' })).status, 200, 'one reply left')
  await control(base, { action: 'pause' })
  ledger.reserved = 1
  const refused = await control(base, { action: 'resume' })
  assert.equal(refused.status, 409)
  assert.deepEqual(failed((await refused.json()).preflight), ['replies'])
})
