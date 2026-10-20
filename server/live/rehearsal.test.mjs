import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { createFakeDeepSeek } from './fake-deepseek.mjs'
import { screenReply } from './moderation.mjs'
import { createLiveRuntime, createMemoryReplyBudget } from './runtime.mjs'
import { createFixtureSource, loadFixture } from './sources/fixture.mjs'
import { planUtterance } from './utterance.mjs'

// The M2 acceptance run: the real runtime, brain, queue, gate and audit log,
// fed the bundled 30-minute rehearsal on a fake clock, with an adversarial
// fake model (every other reply is something the gate must stop). A
// simulated stage buys and plays every turn; a simulated host approves every
// viewer message and resumes after each automatic pause.
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)) }
const socket = { remoteAddress: '127.0.0.1', localPort: 4176 }
const headers = { host: '127.0.0.1:4176' }

function fakeResponse() {
  const response = new EventEmitter()
  Object.assign(response, { chunks: [], writableLength: 0, destroyed: false, writableEnded: false, headersSent: false, status: null })
  response.writeHead = (status) => { response.status = status; response.headersSent = true; return response }
  response.flushHeaders = () => {}
  response.write = (text) => { response.chunks.push(String(text)); return true }
  response.end = (text) => { if (text) response.chunks.push(String(text)); response.writableEnded = true }
  response.events = () => response.chunks.filter(chunk => chunk.startsWith('id: '))
    .map(chunk => ({ type: /event: (\w+)/.exec(chunk)[1], data: JSON.parse(chunk.split('data: ')[1]) }))
  return response
}
const get = url => ({ method: 'GET', url, socket, headers })
function post(url, body) {
  const request = Readable.from([Buffer.from(JSON.stringify(body))])
  return Object.assign(request, { method: 'POST', url, socket, headers: { ...headers, 'content-type': 'application/json', 'x-airi-live': '1' } })
}

function fakeClock() {
  let time = Date.parse('2026-10-19T12:00:00Z')
  let next = 0
  const pending = new Map()
  return {
    now: () => time,
    timers: {
      setTimeout(callback, ms) { const handle = { id: ++next, at: time + Math.max(0, ms), callback, unref() {} }; pending.set(handle.id, handle); return handle },
      clearTimeout(handle) { if (handle) pending.delete(handle.id) },
      setInterval: () => ({ unref() {} }),
      clearInterval: () => {},
    },
    // Fires the earliest timer; false when none are left before `until`.
    step(until) {
      const due = [...pending.values()].sort((a, b) => a.at - b.at || a.id - b.id)[0]
      if (!due || due.at > until) return false
      pending.delete(due.id)
      time = due.at
      due.callback()
      return true
    },
  }
}

test('a 30-minute adversarial rehearsal never puts unscreened text on stage', { timeout: 60_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'airi-rehearsal-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const clock = fakeClock()
  const model = createFakeDeepSeek({ adversarial: true })
  const entries = await loadFixture(fileURLToPath(new URL('./fixtures/rehearsal.jsonl', import.meta.url)))
  const synthesised = []
  const runtime = createLiveRuntime({
    speech: {
      health: () => ({ configured: true, provider: 'minimax', model: 'fake', region: 'cn' }),
      async synthesise(request) { synthesised.push(request.text); return { audio: 'AAAA', format: 'mp3', sampleRate: 32000, words: [] } },
    },
    env: { DEEPSEEK_API_KEY: 'test-only' },
    root,
    fetchImpl: model.fetch,
    now: clock.now,
    timers: clock.timers,
    // In memory: a filesystem ledger would let the fake clock run ahead of
    // real I/O. The on-disk ledger is covered by the HTTP integration test.
    replyBudget: createMemoryReplyBudget({ dailyLimit: 250, now: clock.now }),
    sources: [({ publish }) => createFixtureSource({ entries, now: clock.now, timers: clock.timers, onEvent: event => publish(event, 'fixture') })],
  })
  context.after(() => runtime.stop())
  await runtime.ready
  const call = async (request, path) => { const response = fakeResponse(); await runtime.handle(request, response, path); return response }
  const control = body => call(post('/api/live/control', body), '/api/live/control')
  const state = async () => JSON.parse((await call(get('/api/live/state'), '/api/live/state')).chunks.at(-1))

  // The OBS stage.
  const stage = fakeResponse()
  await runtime.handle(get('/api/live/stage/events?role=obs'), stage, '/api/live/stage/events')
  const { leaseId } = stage.events().find(event => event.type === 'hello').data
  await call(post('/api/live/stage/report', { leaseId, type: 'ready' }), '/api/live/stage/report')

  const said = []
  const blocked = []
  let pauses = 0
  runtime.hub.subscribe('brain.blocked', event => blocked.push(event.data.text))
  runtime.hub.subscribe('brain.paused', () => pauses++)
  // The stage plays every turn: buy each planned sentence once, report played.
  runtime.hub.subscribe('turn.started', (event) => {
    const { turnId, text, delivery, cues } = event.data
    said.push(text)
    void (async () => {
      for (const sentence of await planUtterance({ text, delivery, cues }))
        assert.equal((await call(post('/api/live/stage/speech', { leaseId, turnId, ...sentence }), '/api/live/stage/speech')).status, 200)
      await call(post('/api/live/stage/report', { leaseId, type: 'ended', turnId, outcome: 'played' }), '/api/live/stage/report')
    })()
  })

  const end = clock.now() + 31 * 60_000
  let approvals = 0
  // Never advance the clock while the brain is mid-generation.
  const idle = async () => {
    for (let i = 0; i < 200 && (await state()).brain.phase === 'generating'; i++)
      await new Promise(resolve => setTimeout(resolve, 2))
  }
  while (true) {
    await settle()
    await idle()
    const current = await state()
    for (const item of current.queue.open.filter(item => item.status === 'pending')) {
      await control({ action: 'approve', itemId: item.id })
      approvals++
    }
    if (current.control === 'paused')
      await control({ action: 'resume', skipPreflight: true })
    await settle()
    if (!clock.step(end)) break
  }
  await settle()
  const final = await state()
  await runtime.stop()

  // Every line that reached the stage passes the gate, and no blocked text
  // was ever spoken, captioned or bought.
  assert.ok(said.length >= 10, `the rehearsal produced ${said.length} turns`)
  for (const text of said)
    assert.deepEqual(await screenReply(text), { ok: true }, text)
  assert.ok(blocked.length >= 5, `the gate stopped ${blocked.length} adversarial replies`)
  for (const text of blocked) {
    assert.equal(said.includes(text), false)
    assert.equal(synthesised.some(sentence => text.includes(sentence) && sentence.length > 8), false)
  }
  assert.ok(pauses >= 1, 'repeated blocks paused the stream at least once')
  assert.ok(said.includes('第一句说完了。'), 'a length-cut reply keeps only its complete sentence')
  assert.ok(approvals >= 30)
  assert.equal(model.requests.every(request => request.messages[0].content === model.requests[0].messages[0].content), true,
    'the system prompt is byte-identical on every call')
  for (const request of model.requests) {
    const viewerTurns = request.messages.filter(message => message.role === 'user')
    for (const message of viewerTurns) {
      assert.equal((message.content.match(/<viewer_message /g) ?? []).length, (message.content.match(/<\/viewer_message>/g) ?? []).length)
      assert.equal(/\[\[|[\u202e\u200b]/.test(message.content), false, 'no forged cues or invisible characters reach the model')
    }
  }
  const sticker = entries.findIndex(entry => entry.emoji)
  assert.ok(sticker >= 0)
  assert.equal(model.requests.some(request => request.messages.some(message => message.content.includes('kind="gift"'))), false)

  // The audit log recorded inputs, replies and blocks; the reply ledger exists.
  const logs = await readdir(join(root, '.data', 'live-logs'))
  const lines = (await Promise.all(logs.map(name => readFile(join(root, '.data', 'live-logs', name), 'utf8'))))
    .join('').trim().split('\n').map(line => JSON.parse(line))
  const types = new Set(lines.map(line => line.type))
  for (const type of ['input.danmaku', 'input.superchat', 'input.gift', 'brain.reply', 'brain.blocked', 'brain.usage', 'turn.started', 'turn.ended', 'control.changed'])
    assert.ok(types.has(type), type)
  // Cost is reconstructible from the log alone: one usage record per model
  // call, whatever happened to the reply, summing to the brain's own count.
  const usage = lines.filter(line => line.type === 'brain.usage')
  assert.equal(usage.length, model.calls)
  assert.equal(usage.reduce((sum, line) => sum + line.data.usage.prompt_tokens, 0), final.brain.usage.promptTokens)
  assert.equal(usage.reduce((sum, line) => sum + line.data.usage.completion_tokens, 0), final.brain.usage.completionTokens)
  assert.equal(final.brain.dailyRepliesReserved, model.calls, 'the daily count covers every call')
})
