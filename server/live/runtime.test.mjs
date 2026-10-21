import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import test from 'node:test'

import { STAGE_PROTOCOL } from '../../shared/performance-cues.mjs'

import { createRequestHandler } from '../app.mjs'
import { readMinimaxConfig } from '../minimax.mjs'
import { createSpeechHandler } from '../speech.mjs'
import { SpeechProviderError } from '../speech-error.mjs'
import { TtsBudgetError } from '../tts-budget.mjs'
import { createLiveRuntime } from './runtime.mjs'
import { planClips, planUtterance } from './utterance.mjs'

// Every test drives the real request handler with a fake speech instance and
// a fetch that refuses DeepSeek, so no test can reach a paid provider.
const unexpectedFetch = async () => { throw new Error('live tests must not call DeepSeek') }
const CLIP = { audio: 'AAAA', format: 'mp3', sampleRate: 32_000, words: [] }

function fakeSpeech(synthesise = async () => CLIP) {
  const calls = []
  return {
    calls,
    health: () => ({ configured: true, provider: 'minimax', model: 'fake-model', region: 'cn' }),
    async handle(_request, response) { response.writeHead(418); response.end() },
    async synthesise(request, options) {
      calls.push(request)
      return synthesise(request, options)
    },
  }
}

function fakeTimers() {
  const pending = new Map()
  let next = 0
  return {
    pending,
    setTimeout(callback, ms) {
      const handle = { id: ++next, ms, callback, unref() {} }
      pending.set(handle.id, handle)
      return handle
    },
    clearTimeout(handle) { if (handle) pending.delete(handle.id) },
    setInterval: (callback, ms) => setInterval(callback, ms),
    clearInterval: handle => clearInterval(handle),
    fire(ms) {
      for (const handle of [...pending.values()]) {
        if (handle.ms === ms) {
          pending.delete(handle.id)
          handle.callback()
        }
      }
    },
  }
}

async function start(context, { speech = fakeSpeech(), timers, live = true, startPaused = false, env = {}, fetchImpl = unexpectedFetch } = {}) {
  let ids = 0
  let runtime = null
  const handler = createRequestHandler({
    env,
    fetchImpl,
    speech,
    // root: null keeps ledgers and the audit log out of the repository's .data.
    live: live ? deps => (runtime = createLiveRuntime({ ...deps, root: null, startPaused, ...(timers ? { timers } : {}), newId: () => `id-${++ids}` })) : null,
  })
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  context.after(async () => {
    await handler.stop()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })
  const { port } = server.address()
  return { base: `http://127.0.0.1:${port}`, port, speech, handler, runtime }
}

// A canned DeepSeek answer for the brain (a fake fetch, never the network).
function cannedReply(content) {
  const frames = [{ choices: [{ delta: { content }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]
  return async (url) => {
    assert.match(String(url), /\/chat\/completions$/)
    return new Response(`${frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
  }
}

function post(base, path, body) {
  return fetch(`${base}/airi${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Airi-Live': '1' },
    body: JSON.stringify(body),
  })
}
const control = (base, body) => post(base, '/api/live/control', body)
const state = async base => (await fetch(`${base}/airi/api/live/state`)).json()

// Reads the SSE stream with fetch (Node has no EventSource).
async function openStage(context, base, role) {
  const controller = new AbortController()
  const response = await fetch(`${base}/airi/api/live/stage/events?role=${role}`, { signal: controller.signal })
  const events = []
  const waiters = new Set()
  let ended = false
  const notify = () => { for (const waiter of [...waiters]) waiter() }
  ;(async () => {
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let index
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          const fields = Object.fromEntries(frame.split('\n').filter(line => !line.startsWith(':'))
            .map(line => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]))
          events.push({ ...fields, ...(fields.data ? { data: JSON.parse(fields.data) } : {}) })
          notify()
        }
      }
    }
    catch {}
    ended = true
    notify()
  })()
  let consumed = 0
  const stage = {
    response,
    events,
    get ended() { return ended },
    // Resolves with the next not-yet-consumed event of this type.
    next(type, timeoutMs = 2_000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`no ${type} event`)) }, timeoutMs)
        const check = () => {
          const index = events.findIndex((event, position) => position >= consumed && event.event === type)
          if (index >= 0) {
            consumed = index + 1
            clearTimeout(timer)
            waiters.delete(check)
            resolve(events[index].data)
          }
        }
        waiters.add(check)
        check()
      })
    },
    waitForEnd(timeoutMs = 2_000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('stream did not end')), timeoutMs)
        const check = () => { if (ended) { clearTimeout(timer); waiters.delete(check); resolve() } }
        waiters.add(check)
        check()
      })
    },
    close: () => controller.abort(),
  }
  context.after(() => controller.abort())
  return stage
}

async function readyStage(context, base, role = 'obs') {
  const stage = await openStage(context, base, role)
  const hello = await stage.next('hello')
  if (hello.primary)
    assert.equal((await post(base, '/api/live/stage/report', { leaseId: hello.leaseId, type: 'ready', protocol: STAGE_PROTOCOL })).status, 204)
  return { stage, hello }
}

// Raw request for headers fetch() forbids (Host) or would normalise.
function rawRequest(port, { method = 'GET', path = '/airi/api/live/state', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (response) => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null })
      })
    })
    request.on('error', reject)
    request.end(body)
  })
}

test('without the live factory, /api/live/* stays a 404 and health has no live key', async (context) => {
  const { base } = await start(context, { live: false })
  assert.equal((await fetch(`${base}/airi/api/live/state`)).status, 404)
  assert.equal((await post(base, '/api/live/control', { action: 'say', text: '你好' })).status, 404)
  assert.equal(Object.hasOwn(await (await fetch(`${base}/airi/api/health`)).json(), 'live'), false)
})

test('health reports only non-secret live status', async (context) => {
  const { base } = await start(context)
  const health = await (await fetch(`${base}/airi/api/health`)).json()
  assert.deepEqual(health.live, {
    enabled: true, control: 'running', mode: 'live', stageOnline: false, stageReady: false,
    avatar: null, lastReportAgoMs: null,
  })
})

test('say is refused until an OBS stage is ready, then reaches every stage page', async (context) => {
  const { base } = await start(context)
  const refused = await control(base, { action: 'say', text: '你好。' })
  assert.equal(refused.status, 409)
  assert.deepEqual(await refused.json(), { code: 'LIVE_NO_STAGE' })

  const obs = await openStage(context, base, 'obs')
  const hello = await obs.next('hello')
  assert.deepEqual(hello, { leaseId: 'id-1', role: 'obs', primary: true, mode: 'live', activity: 'idle' })
  assert.equal((await control(base, { action: 'say', text: '你好。' })).status, 409, 'connected is not ready')

  const preview = await openStage(context, base, 'preview')
  assert.deepEqual(await preview.next('hello'), { leaseId: null, role: 'preview', primary: false, mode: 'live', activity: 'idle' })
  assert.equal((await post(base, '/api/live/stage/report', { leaseId: null, type: 'ready', protocol: STAGE_PROTOCOL })).status, 403,
    'a preview cannot report')
  assert.equal((await post(base, '/api/live/stage/report', { leaseId: hello.leaseId, type: 'ready', protocol: STAGE_PROTOCOL })).status, 204)

  const said = await control(base, { action: 'say', text: '你好。今天天气不错。', delivery: 'happy' })
  assert.equal(said.status, 200)
  const { turnId, sentences } = await said.json()
  assert.equal(sentences, 2)
  const expected = { turnId, text: '你好。今天天气不错。', delivery: 'happy', cues: [], acts: [], replyTo: null, join: true }
  assert.deepEqual(await obs.next('say'), expected)
  assert.deepEqual(await preview.next('say'), expected)

  const current = await state(base)
  assert.equal(current.turn.turnId, turnId)
  assert.equal(current.turn.sentencesPlanned, 2)
  assert.equal(current.turn.clipsPlanned, 1, 'the two same-tone sentences are one clip')
  assert.equal(current.stage.previews, 1)
  assert.equal(current.stage.primary.ready, true)
  const busy = await control(base, { action: 'say', text: '另一句。' })
  assert.equal(busy.status, 409)
  assert.deepEqual(await busy.json(), { code: 'LIVE_TURN_ACTIVE' })
})

test('the stage buys each planned clip once: a joined clip whole, never one of its sentences', async (context) => {
  const { base, speech, runtime } = await start(context)
  const ended = []
  runtime.hub.subscribe('turn.ended', event => ended.push(event.data))
  const { stage, hello } = await readyStage(context, base)
  const text = '好！好！再见。'
  const { turnId, sentences } = await (await control(base, { action: 'say', text, delivery: 'soft' })).json()
  assert.equal(sentences, 3)
  assert.equal((await stage.next('say')).join, true)
  const clips = await planClips({ text, delivery: 'soft' })
  assert.deepEqual(clips, [{ text: '好！好！再见。', delivery: 'soft', parts: ['好！', '好！', '再见。'] }])
  const buy = (sentence, overrides = {}) => post(base, '/api/live/stage/speech',
    { leaseId: hello.leaseId, turnId, ...sentence, ...overrides })
  for (const part of ['好！', '再见。', '好！好！'])
    assert.equal((await buy({ text: part, delivery: 'soft' })).status, 409, `${part} alone was never planned`)
  assert.equal((await buy({ text: '好！好！再见。', delivery: 'soft', act: 'laugh' })).status, 409)
  assert.equal(speech.calls.length, 0, 'refusals never reach the provider')
  const response = await buy({ text: '好！好！再见。', delivery: 'soft', parts: ['ignored'] })
  assert.equal(response.status, 200)
  assert.deepEqual(speech.calls, [{ text: '好！好！再见。', delivery: 'soft' }], 'one request for the clip, nothing else the stage sent')
  assert.equal((await buy({ text: '好！好！再见。', delivery: 'soft' })).status, 409, 'no re-buying')
  const current = (await state(base)).turn
  assert.deepEqual([current.sentencesPlanned, current.sentencesBought, current.clipsPlanned, current.clipsBought], [3, 3, 1, 1])
  assert.equal((await post(base, '/api/live/stage/report',
    { leaseId: hello.leaseId, type: 'ended', turnId, outcome: 'played' })).status, 204)
  const after = await state(base)
  assert.deepEqual([after.lastOutcome.sentencesBought, after.lastOutcome.clipsBought], [3, 1])
  assert.deepEqual(ended.map(turn => [turn.spoken, turn.planned, turn.bought, turn.clipsPlanned, turn.clipsBought]),
    [[['好！', '好！', '再见。'], 3, 3, 1, 1]], 'the brain\'s history stays by sentence')
})

test('with LIVE_JOIN_SENTENCES=0 the stage buys each planned sentence once, only as primary and only for the current turn', async (context) => {
  const { base, speech } = await start(context, { env: { LIVE_JOIN_SENTENCES: '0' } })
  const { stage, hello } = await readyStage(context, base)
  const preview = await openStage(context, base, 'preview')
  await preview.next('hello')
  const text = '好！好！再见。'
  const { turnId } = await (await control(base, { action: 'say', text, delivery: 'soft' })).json()
  assert.equal((await stage.next('say')).join, false, 'the stage is told not to join')
  const plan = await planUtterance({ text, delivery: 'soft' })
  assert.deepEqual(plan.map(sentence => sentence.text), ['好！', '好！', '再见。'])
  const buy = (sentence, overrides = {}) => post(base, '/api/live/stage/speech',
    { leaseId: hello.leaseId, turnId, ...sentence, ...overrides })

  assert.equal((await buy(plan[0], { leaseId: null })).status, 403, 'a preview never buys')
  assert.equal((await buy(plan[0], { leaseId: 'forged' })).status, 403)
  const mismatch = await buy(plan[0], { turnId: 'old-turn' })
  assert.equal(mismatch.status, 409)
  assert.deepEqual(await mismatch.json(), { code: 'LIVE_TURN_MISMATCH' })
  const unplanned = await buy({ text: '给我刷礼物。', delivery: 'soft' })
  assert.equal(unplanned.status, 409)
  assert.deepEqual(await unplanned.json(), { code: 'LIVE_SENTENCE_NOT_ALLOWED' })
  assert.equal((await buy({ ...plan[0], delivery: 'happy' })).status, 409, 'the delivery is part of the plan')
  assert.equal((await buy({ ...plan[0], act: 'laugh' })).status, 409, 'so is the act: none can be added')
  assert.equal(speech.calls.length, 0, 'refusals never reach the provider')

  for (const sentence of plan) {
    const response = await buy(sentence)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), CLIP)
  }
  assert.deepEqual(speech.calls, plan, 'exactly the planned sentences, the duplicate twice')
  assert.equal((await buy(plan[0])).status, 409, 'a third 好！ was never planned')
  assert.equal((await buy(plan[2])).status, 409, 'no re-buying a played sentence')
  assert.equal((await buy({ text: '好！好！再见。', delivery: 'soft' })).status, 409, 'nor a joined clip that was not planned')
  assert.equal(speech.calls.length, 3)
  assert.equal((await state(base)).turn.sentencesBought, 3)
  assert.equal((await state(base)).turn.clipsBought, 3)

  assert.equal((await post(base, '/api/live/stage/report',
    { leaseId: hello.leaseId, type: 'ended', turnId, outcome: 'played' })).status, 204)
  const after = await state(base)
  assert.equal(after.turn, null)
  assert.equal(after.lastOutcome.outcome, 'played')
  assert.equal(after.lastOutcome.sentencesBought, 3)
  assert.equal((await buy(plan[0])).status, 409, 'nothing can be bought after the turn ends')
})

test('speech failures use stable codes and never echo provider detail', async (context) => {
  const failures = [
    [new SpeechProviderError('TTS_BUSY'), 503, 'TTS_BUSY'],
    [new SpeechProviderError('TTS_NOT_CONFIGURED'), 503, 'TTS_NOT_CONFIGURED'],
    [new TtsBudgetError('TTS_DAILY_LIMIT'), 429, 'TTS_DAILY_LIMIT'],
    [new SpeechProviderError('TTS_TIMEOUT'), 504, 'TTS_TIMEOUT'],
    [new Error('sk-secret-key private sentence'), 502, 'TTS_UPSTREAM_FAILED'],
  ]
  let index = 0
  const { base } = await start(context, { speech: fakeSpeech(async () => { throw failures[index][0] }) })
  const { hello } = await readyStage(context, base)
  for (; index < failures.length; index++) {
    const text = `第${index}句。`
    const { turnId } = await (await control(base, { action: 'say', text })).json()
    const response = await post(base, '/api/live/stage/speech', { leaseId: hello.leaseId, turnId, text, delivery: 'neutral' })
    const body = await response.text()
    assert.equal(response.status, failures[index][1])
    assert.deepEqual(JSON.parse(body), { code: failures[index][2] })
    assert.equal(body.includes('secret') || body.includes('private'), false)
    await control(base, { action: 'stop' })
  }
})

test('a newer OBS page takes the lease, the old one stands by, and the lease returns when it closes', async (context) => {
  const { base } = await start(context)
  const first = await readyStage(context, base)
  const { turnId } = await (await control(base, { action: 'say', text: '换台测试。' })).json()
  await first.stage.next('say')

  const second = await openStage(context, base, 'obs')
  assert.deepEqual(await first.stage.next('standby'), {})
  const secondHello = await second.next('hello')
  assert.equal(secondHello.primary, true)
  assert.notEqual(secondHello.leaseId, first.hello.leaseId)
  assert.deepEqual(await first.stage.next('stop'), { turnId }, 'the turn does not survive a lease change')
  const afterSwitch = await state(base)
  assert.equal(afterSwitch.turn, null)
  assert.equal(afterSwitch.lastOutcome.outcome, 'cancelled')
  assert.equal(afterSwitch.stage.standby, 1)
  assert.equal(afterSwitch.stage.primary.ready, false, 'the new primary must report ready itself')
  assert.equal((await post(base, '/api/live/stage/report', { leaseId: first.hello.leaseId, type: 'ready', protocol: STAGE_PROTOCOL })).status, 403)
  assert.equal((await control(base, { action: 'say', text: '还没就绪。' })).status, 409)

  second.close()
  const promoted = await first.stage.next('hello')
  assert.equal(promoted.primary, true)
  assert.notEqual(promoted.leaseId, first.hello.leaseId)
  assert.equal((await post(base, '/api/live/stage/report', { leaseId: promoted.leaseId, type: 'ready', protocol: STAGE_PROTOCOL })).status, 204)
  assert.equal((await control(base, { action: 'say', text: '回来了。' })).status, 200)
})

test('the watchdog stops a turn the stage never reports, sized by text length', async (context) => {
  const timers = fakeTimers()
  const { base } = await start(context, { timers })
  const { stage } = await readyStage(context, base)
  const text = '这句话没有人回报结束。'
  const { turnId } = await (await control(base, { action: 'say', text })).json()
  const watchdogMs = 15_000 + 350 * text.length
  assert.ok([...timers.pending.values()].some(handle => handle.ms === watchdogMs))
  timers.fire(watchdogMs)
  assert.deepEqual(await stage.next('stop'), { turnId })
  const after = await state(base)
  assert.equal(after.turn, null)
  assert.equal(after.lastOutcome.outcome, 'timeout')
  assert.equal(Math.min(90_000, 15_000 + 350 * 200), 85_000, 'the longest allowed line stays under the 90 s cap')
})

test('stop, pause, resume, panic and reload drive the stage and gate new lines', async (context) => {
  const { base } = await start(context)
  const { stage, hello } = await readyStage(context, base)

  const { turnId } = await (await control(base, { action: 'say', text: '先停下。' })).json()
  assert.equal((await control(base, { action: 'stop' })).status, 200)
  assert.deepEqual(await stage.next('stop'), { turnId })
  assert.equal((await state(base)).lastOutcome.outcome, 'stopped')
  // A late "cancelled" report for the stopped turn is accepted and ignored.
  assert.equal((await post(base, '/api/live/stage/report', { leaseId: hello.leaseId, type: 'ended', turnId, outcome: 'cancelled' })).status, 204)
  assert.equal((await state(base)).lastOutcome.outcome, 'stopped')

  assert.equal((await control(base, { action: 'pause' })).status, 200)
  const paused = await control(base, { action: 'say', text: '暂停中。' })
  assert.equal(paused.status, 409)
  assert.deepEqual(await paused.json(), { code: 'LIVE_PAUSED' })
  assert.equal((await control(base, { action: 'resume', skipPreflight: true })).status, 200)
  const next = await (await control(base, { action: 'say', text: '紧急停止前。' })).json()

  const panic = await (await control(base, { action: 'panic' })).json()
  assert.equal(panic.control, 'panic')
  assert.equal(panic.mode, 'brb')
  assert.deepEqual(await stage.next('stop'), { turnId: next.turnId })
  assert.deepEqual(await stage.next('mode'), { mode: 'brb' })
  assert.equal((await control(base, { action: 'say', text: '不应说出。' })).status, 409)
  await control(base, { action: 'pause' })
  assert.equal((await state(base)).control, 'panic', 'pause cannot downgrade a panic')

  const reconnect = await openStage(context, base, 'preview')
  assert.equal((await reconnect.next('hello')).mode, 'brb', 'a new page starts on the brb screen')

  assert.equal((await control(base, { action: 'resume', skipPreflight: true })).status, 200)
  assert.deepEqual(await stage.next('mode'), { mode: 'live' })
  assert.equal((await control(base, { action: 'reload-stage' })).status, 200)
  assert.deepEqual(await stage.next('reload'), {})
})

test('startPaused boots paused for "startup", refuses lines, and the first resume runs the checklist', async (context) => {
  const { base } = await start(context, { startPaused: true })
  assert.equal((await (await fetch(`${base}/airi/api/health`)).json()).live.control, 'paused')
  const booted = await state(base)
  assert.deepEqual([booted.control, booted.pauseReason, booted.mode], ['paused', 'startup', 'live'])

  const { stage } = await readyStage(context, base)
  const refused = await control(base, { action: 'say', text: '还没开播。' })
  assert.equal(refused.status, 409)
  assert.deepEqual(await refused.json(), { code: 'LIVE_PAUSED' })

  // No pause-then-resume: the very first resume is gated (here no DeepSeek
  // key and no data directory, so the checklist fails).
  const gated = await control(base, { action: 'resume' })
  assert.equal(gated.status, 409)
  const { code, preflight } = await gated.json()
  assert.equal(code, 'LIVE_PREFLIGHT_FAILED')
  assert.equal(preflight.checks.find(check => check.id === 'deepseek').ok, false)
  assert.equal((await state(base)).pauseReason, 'startup', 'a refused resume stays paused for startup')

  const resumed = await (await control(base, { action: 'resume', skipPreflight: true })).json()
  assert.deepEqual([resumed.control, resumed.pauseReason], ['running', null])
  assert.equal((await control(base, { action: 'say', text: '开播了。' })).status, 200)
  assert.equal((await stage.next('say')).text, '开播了。')
})

test('console input is validated before any turn starts', async (context) => {
  const { base } = await start(context)
  await readyStage(context, base)
  const cases = [
    [{ action: 'say', text: '' }, 'LIVE_INVALID_TEXT'],
    [{ action: 'say', text: '长'.repeat(201) }, 'LIVE_INVALID_TEXT'],
    [{ action: 'say', text: '[[tone:bright]]你好' }, 'LIVE_INVALID_TEXT'],
    [{ action: 'say', text: '[[act:laugh]]你好' }, 'LIVE_INVALID_TEXT'],
    [{ action: 'say', text: '\u202e\u0007' }, 'LIVE_INVALID_TEXT'],
    [{ action: 'say', text: '你好', delivery: 'angry' }, 'LIVE_INVALID_DELIVERY'],
    [{ action: 'say', text: '……' }, 'LIVE_EMPTY'],
    [{ action: 'dance' }, 'LIVE_INVALID_ACTION'],
  ]
  for (const [body, code] of cases) {
    const response = await control(base, body)
    assert.equal(response.status, 400, code)
    assert.deepEqual(await response.json(), { code })
  }
  assert.equal((await state(base)).turn, null)

  const cleaned = await control(base, { action: 'say', text: ' 你\u0000好\u202e。 ' })
  assert.equal(cleaned.status, 200)
  assert.equal((await state(base)).turn.text, '你好。', 'control and bidi characters never reach captions or TTS')

  const reports = [
    { type: 'avatar', status: 'exploded' }, { type: 'ended', turnId: 'x', outcome: 'great' },
    { type: 'problem', message: '' }, { type: 'mystery' },
  ]
  const { hello } = await (async () => {
    const stage = await openStage(context, base, 'obs')
    return { hello: await stage.next('hello') }
  })()
  for (const report of reports)
    assert.equal((await post(base, '/api/live/stage/report', { leaseId: hello.leaseId, ...report })).status, 400)
  assert.equal((await post(base, '/api/live/stage/report',
    { leaseId: hello.leaseId, type: 'problem', message: `自动播放被拦截${'。'.repeat(300)}` })).status, 204)
  assert.equal((await state(base)).lastProblem.message.length, 120)
})

test('every live route rejects proxied, foreign-host, cross-origin and header-less requests', async (context) => {
  const { port } = await start(context)
  const host = `127.0.0.1:${port}`
  const json = { 'Content-Type': 'application/json', 'X-Airi-Live': '1' }
  const body = JSON.stringify({ action: 'pause' })
  const rejected = [
    [{ headers: { 'X-Real-IP': '203.0.113.9' } }, 403, 'LIVE_NOT_LOCAL'],
    [{ headers: { 'X-Forwarded-For': '203.0.113.9' } }, 403, 'LIVE_NOT_LOCAL'],
    [{ headers: { Forwarded: 'for=203.0.113.9' } }, 403, 'LIVE_NOT_LOCAL'],
    [{ headers: { Host: 'evil.test' } }, 403, 'LIVE_BAD_HOST'],
    [{ headers: { Host: `127.0.0.1:${port + 1}` } }, 403, 'LIVE_BAD_HOST'],
    [{ headers: { Origin: 'http://evil.test' } }, 403, 'LIVE_BAD_ORIGIN'],
    [{ method: 'POST', path: '/airi/api/live/control', headers: { 'Content-Type': 'application/json' }, body }, 403, 'LIVE_BAD_REQUEST_HEADERS'],
    [{ method: 'POST', path: '/airi/api/live/control', headers: { 'Content-Type': 'text/plain', 'X-Airi-Live': '1' }, body }, 403, 'LIVE_BAD_REQUEST_HEADERS'],
    [{ method: 'POST', path: '/airi/api/live/control', headers: { ...json, Origin: 'http://evil.test' }, body }, 403, 'LIVE_BAD_ORIGIN'],
    [{ method: 'POST', path: '/airi/api/live/control', headers: json, body: JSON.stringify({ action: 'say', text: 'x'.repeat(3_000) }) }, 400, 'LIVE_REQUEST_TOO_LARGE'],
    [{ method: 'POST', path: '/airi/api/live/control', headers: json, body: '{not json' }, 400, 'LIVE_INVALID_REQUEST'],
    [{ path: '/airi/api/live/stage/events?role=director' }, 400, 'LIVE_INVALID_ROLE'],
  ]
  for (const [options, status, code] of rejected) {
    const response = await rawRequest(port, options)
    assert.equal(response.status, status, code)
    assert.deepEqual(response.body, { code })
  }
  for (const allowedHost of [host, `localhost:${port}`]) {
    const response = await rawRequest(port, { headers: { Host: allowedHost, Origin: `http://${allowedHost}` } })
    assert.equal(response.status, 200)
  }
  assert.equal((await rawRequest(port, { method: 'POST', path: '/airi/api/live/control', headers: json, body })).status, 200)
  assert.equal((await rawRequest(port, { path: '/airi/api/live/unknown' })).status, 404)
})

test('live mode applies the loopback Host allowlist to every route, so rebinding cannot reach speech or chat', async (context) => {
  let handled = 0
  const speech = fakeSpeech()
  speech.handle = async (_request, response) => { handled++; response.writeHead(200); response.end('{}') }
  const { port } = await start(context, { speech })
  const json = { 'Content-Type': 'application/json' }
  for (const [method, path, body] of [['POST', '/airi/api/speech', '{"text":"x","delivery":"neutral"}'],
    ['POST', '/airi/api/chat', '{"messages":[]}'], ['GET', '/airi/api/health'], ['GET', '/airi/stage.html'], ['GET', '/airi/']]) {
    const response = await rawRequest(port, { method, path, body, headers: { ...json, Host: `evil.example:${port}` } })
    assert.equal(response.status, 403, path)
    assert.deepEqual(response.body, { code: 'LIVE_BAD_HOST' })
  }
  assert.equal(handled, 0, 'a rebinding page never occupies a speech slot')
  assert.equal((await rawRequest(port, { method: 'POST', path: '/airi/api/speech', body: '{}', headers: json })).status, 200)
  assert.equal(handled, 1)

  const { base } = await start(context, { live: false })
  const plainPort = new URL(base).port
  const unaffected = await rawRequest(Number(plainPort), { path: '/airi/api/health', headers: { Host: 'mmturingtest.online' } })
  assert.equal(unaffected.status, 200, 'without live mode the deployed proxy Host still works')
})

test('a cross-site page cannot take the speaking lease with a no-cors GET', async (context) => {
  const { base, port } = await start(context)
  const { stage } = await readyStage(context, base)
  const { turnId } = await (await control(base, { action: 'say', text: '正在直播。' })).json()
  const stolen = await rawRequest(port, { path: '/airi/api/live/stage/events?role=obs',
    headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'image' } })
  assert.equal(stolen.status, 403)
  assert.deepEqual(stolen.body, { code: 'LIVE_BAD_ORIGIN' })
  const current = await state(base)
  assert.equal(current.turn.turnId, turnId, 'the real stage keeps its turn')
  assert.equal(current.stage.primary.ready, true)
  assert.equal(current.stage.standby, 0)
  assert.equal(stage.events.some(event => event.event === 'standby'), false)
})

test('stopping the runtime ends the active turn and closes stage streams', async (context) => {
  const { base, handler } = await start(context)
  const { stage } = await readyStage(context, base)
  const { turnId } = await (await control(base, { action: 'say', text: '收工。' })).json()
  await handler.stop()
  assert.deepEqual(await stage.next('stop'), { turnId })
  await stage.waitForEnd()
  assert.equal((await fetch(`${base}/airi/api/live/state`)).status, 404, 'a stopped runtime no longer answers')
})

test('an old console sending "bright" says happy, and an old stage may buy happy as "bright"', async (context) => {
  const { base, speech } = await start(context)
  const { stage, hello } = await readyStage(context, base)
  const { turnId } = await (await control(base, { action: 'say', text: '好耶。', delivery: 'bright' })).json()
  assert.equal((await stage.next('say')).delivery, 'happy')
  const bought = await post(base, '/api/live/stage/speech', { leaseId: hello.leaseId, turnId, text: '好耶。', delivery: 'bright' })
  assert.equal(bought.status, 200)
  assert.deepEqual(speech.calls, [{ text: '好耶。', delivery: 'happy' }], 'the provider only ever sees the canonical name')
})

test('a stage buys an act sentence only with exactly the planned act, and names the act, never its sound', async (context) => {
  const reply = '[[tone:happy]][[act:laugh]]哈哈，被你逗笑了。再说一句吧。'
  const { base, speech, runtime } = await start(context, { env: { DEEPSEEK_API_KEY: 'test-only' }, fetchImpl: cannedReply(reply) })
  const started = []
  runtime.hub.subscribe('turn.started', event => started.push(event.data))
  const { stage, hello } = await readyStage(context, base)
  assert.equal((await control(base, { action: 'inject', text: '讲个笑话' })).status, 200)
  const say = await stage.next('say')
  assert.deepEqual([say.delivery, say.cues, say.acts], ['happy', [{ start: 0, delivery: 'happy' }], [{ start: 0, act: 'laugh' }]])
  assert.deepEqual(started.map(turn => turn.acts), [say.acts], 'the hub and the audit log see the same acts')
  assert.equal(say.join, true)
  assert.deepEqual(await planUtterance(say), [
    { text: '哈哈，被你逗笑了。', delivery: 'happy', act: 'laugh' },
    { text: '再说一句吧。', delivery: 'happy' },
  ])
  // The laugh opens a clip, and the same-tone sentence after it joins it.
  const plan = (await planClips(say)).map(({ parts: _parts, ...clip }) => clip)
  assert.deepEqual(plan, [{ text: '哈哈，被你逗笑了。再说一句吧。', delivery: 'happy', act: 'laugh' }])
  const sentences = await planUtterance(say)
  const buy = sentence => post(base, '/api/live/stage/speech', { leaseId: hello.leaseId, turnId: say.turnId, ...sentence })
  const { act: _laugh, ...withoutAct } = plan[0]
  for (const [sentence, label] of [
    [withoutAct, 'a planned laugh removed'],
    [{ ...plan[0], act: null }, 'removed as null'],
    [{ ...plan[0], act: 'sigh' }, 'changed'],
    [{ ...sentences[0] }, 'the act sentence alone'],
    [{ ...sentences[1], act: 'pause' }, 'a pause added'],
    [{ ...plan[0], act: 'giggle' }, 'an unknown act'],
    [{ ...plan[0], act: '(laughs)' }, 'provider syntax'],
    [{ ...plan[0], act: ['laugh'] }, 'not a name'],
  ]) {
    const refused = await buy(sentence)
    assert.equal(refused.status, 409, label)
    assert.deepEqual(await refused.json(), { code: 'LIVE_SENTENCE_NOT_ALLOWED' }, label)
  }
  assert.equal(speech.calls.length, 0, 'refusals never reach the provider')
  for (const sentence of plan)
    assert.equal((await buy({ ...sentence, pauseSeconds: 9 })).status, 200)
  assert.deepEqual(speech.calls, plan, 'exactly the validated text, delivery and act; nothing else the stage sent')
  assert.equal((await buy(sentences[1])).status, 409, 'the joined sentence is not sold again alone')
})
test('a stage page from before the current say payload is told to reload, not made ready', async (context) => {
  const { base } = await start(context)
  const old = await openStage(context, base, 'obs')
  const hello = await old.next('hello')
  const outdated = await post(base, '/api/live/stage/report', { leaseId: hello.leaseId, type: 'ready' })
  assert.equal(outdated.status, 409)
  assert.deepEqual(await outdated.json(), { code: 'LIVE_STAGE_OUTDATED' })
  await old.next('reload')
  const state = await (await fetch(`${base}/airi/api/live/state`)).json()
  assert.equal(state.stage.primary.ready, false)
  assert.match(state.lastProblem.message, /版本过旧/)
  // Within 30 s a second outdated report is refused without another reload.
  assert.equal((await post(base, '/api/live/stage/report', { leaseId: hello.leaseId, type: 'ready', protocol: 1 })).status, 409)
  await assert.rejects(old.next('reload', 200))
  assert.equal((await post(base, '/api/live/stage/report', { leaseId: hello.leaseId, type: 'ready', protocol: STAGE_PROTOCOL })).status, 204)
})

// Polls real time until the runtime (on fake timers) reaches a state.
async function until(predicate, message) {
  for (let index = 0; index < 400; index++) {
    if (await predicate())
      return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(message)
}
const retryPending = timers => [...timers.pending.values()].some(handle => handle.ms === 4_000)
const rateLimited = () => new SpeechProviderError('TTS_UPSTREAM_RATE_LIMITED')

test('a clip refused for the provider\'s rate limit waits 4 s once and is asked again; the host sees why', async (context) => {
  const timers = fakeTimers()
  let attempts = 0
  const speech = fakeSpeech(async () => { if (attempts++ === 0) throw rateLimited(); return CLIP })
  const { base, runtime } = await start(context, { speech, timers })
  const steps = []
  runtime.hub.subscribe('speech.rate_limited', event => steps.push(event.data))
  const { hello } = await readyStage(context, base)
  const text = '你好。'
  const { turnId } = await (await control(base, { action: 'say', text })).json()
  const pending = post(base, '/api/live/stage/speech', { leaseId: hello.leaseId, turnId, text, delivery: 'neutral' })
  await until(() => retryPending(timers), 'no retry wait was scheduled')
  assert.equal(speech.calls.length, 1, 'nothing more is sent during the wait')
  assert.equal((await state(base)).lastSpeechProblem.message, 'MiniMax 每分钟请求数到上限，4 秒后重试这一段。')

  timers.fire(4_000)
  const response = await pending
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), CLIP)
  assert.deepEqual(speech.calls, [{ text, delivery: 'neutral' }, { text, delivery: 'neutral' }])
  const current = await state(base)
  assert.deepEqual([current.lastSpeechProblem.code, current.lastSpeechProblem.message, current.lastSpeechProblem.clips],
    ['TTS_UPSTREAM_RATE_LIMITED', 'MiniMax 每分钟请求数到上限，重试后已出声。', 1])
  assert.equal(typeof current.lastSpeechProblem.agoMs, 'number')
  assert.deepEqual([current.turn.clipsBought, current.turn.sentencesBought], [1, 1], 'one clip, however many requests')
  assert.deepEqual(steps, [{ step: 'waiting', clips: 1 }, { step: 'recovered', clips: 1 }])
})

test('a second refusal ends the clip with 429 and no third request; the stage\'s own report does not hide it', async (context) => {
  const timers = fakeTimers()
  const speech = fakeSpeech(async () => { throw rateLimited() })
  const { base } = await start(context, { speech, timers })
  const { hello } = await readyStage(context, base)
  const text = '你好。'
  const { turnId } = await (await control(base, { action: 'say', text })).json()
  const pending = post(base, '/api/live/stage/speech', { leaseId: hello.leaseId, turnId, text, delivery: 'neutral' })
  await until(() => retryPending(timers), 'no retry wait was scheduled')
  timers.fire(4_000)
  const response = await pending
  assert.equal(response.status, 429)
  assert.deepEqual(await response.json(), { code: 'TTS_UPSTREAM_RATE_LIMITED' })
  assert.equal(speech.calls.length, 2)
  assert.equal(retryPending(timers), false)

  assert.equal((await post(base, '/api/live/stage/report',
    { leaseId: hello.leaseId, type: 'problem', message: '云端语音失败，本句已跳过。' })).status, 204)
  const current = await state(base)
  assert.equal(current.lastProblem.message, '云端语音失败，本句已跳过。')
  assert.equal(current.lastSpeechProblem.message, 'MiniMax 每分钟请求数到上限，这一段没有声音。')
})

test('every other speech failure is final: one request, no wait', async (context) => {
  const timers = fakeTimers()
  const failures = [new SpeechProviderError('TTS_UPSTREAM_INVALID'), new SpeechProviderError('TTS_UPSTREAM_FAILED'),
    new SpeechProviderError('TTS_TIMEOUT'), new TtsBudgetError('TTS_DAILY_LIMIT'), new SpeechProviderError('TTS_BUSY')]
  let index = 0
  const speech = fakeSpeech(async () => { throw failures[index] })
  const { base } = await start(context, { speech, timers })
  const { hello } = await readyStage(context, base)
  for (; index < failures.length; index++) {
    const text = `第${index}句。`
    const { turnId } = await (await control(base, { action: 'say', text })).json()
    const response = await post(base, '/api/live/stage/speech', { leaseId: hello.leaseId, turnId, text, delivery: 'neutral' })
    assert.notEqual(response.status, 200)
    assert.equal(speech.calls.length, index + 1, failures[index].code)
    assert.equal(retryPending(timers), false)
    await control(base, { action: 'stop' })
  }
  assert.equal((await state(base)).lastSpeechProblem, null)
})

test('a turn stopped during the wait is not bought again', async (context) => {
  const timers = fakeTimers()
  const speech = fakeSpeech(async () => { throw rateLimited() })
  const { base } = await start(context, { speech, timers })
  const { hello } = await readyStage(context, base)
  const text = '你好。'
  const { turnId } = await (await control(base, { action: 'say', text })).json()
  const pending = post(base, '/api/live/stage/speech', { leaseId: hello.leaseId, turnId, text, delivery: 'neutral' })
  await until(() => retryPending(timers), 'no retry wait was scheduled')
  assert.equal((await control(base, { action: 'stop' })).status, 200)
  timers.fire(4_000)
  const response = await pending
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { code: 'LIVE_TURN_MISMATCH' })
  assert.equal(speech.calls.length, 1)
  assert.equal((await state(base)).lastSpeechProblem.message, 'MiniMax 每分钟请求数到上限，这一段没有声音。')
})

test('a MiniMax 1002 body reaches the console as a rate-limit line, end to end (a fake fetch; nothing paid)', async (context) => {
  const timers = fakeTimers()
  const config = readMinimaxConfig({ MINIMAX_TTS_ENABLED: '1', MINIMAX_API_KEY: 'test-key-do-not-leak',
    MINIMAX_VOICE_ID: 'test-voice', MINIMAX_TTS_DAILY_CHAR_LIMIT: '1000' })
  const sent = []
  const speech = createSpeechHandler({ rootDirectory: '/unused-test-root', config, budget: { reserve: async () => {} },
    fetchImpl: async (url) => {
      sent.push(String(url))
      return new Response(JSON.stringify({ base_resp: { status_code: 1002, status_msg: 'rate limit exceeded(RPM)' } }),
        { headers: { 'content-type': 'application/json' } })
    } })
  const { base } = await start(context, { speech, timers })
  const { hello } = await readyStage(context, base)
  const text = '你好。'
  const { turnId } = await (await control(base, { action: 'say', text })).json()
  const pending = post(base, '/api/live/stage/speech', { leaseId: hello.leaseId, turnId, text, delivery: 'neutral' })
  await until(() => retryPending(timers), 'no retry wait was scheduled')
  timers.fire(4_000)
  const response = await pending
  const body = await response.text()
  assert.equal(response.status, 429)
  assert.deepEqual(JSON.parse(body), { code: 'TTS_UPSTREAM_RATE_LIMITED' })
  assert.deepEqual(sent, ['https://api.minimax.cn/v1/t2a_v2', 'https://api.minimax.cn/v1/t2a_v2'])
  const current = await state(base)
  assert.equal(current.lastSpeechProblem.message, 'MiniMax 每分钟请求数到上限，这一段没有声音。')
  // Timestamps could contain any digits, so only the texts are checked for the code.
  assert.doesNotMatch(JSON.stringify(current), /RPM|test-key/)
  assert.doesNotMatch(body + current.lastSpeechProblem.message, /1002|status-code/)
})
