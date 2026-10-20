import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createRequestHandler } from '../app.mjs'
import { createFakeDeepSeek } from './fake-deepseek.mjs'
import { createLiveRuntime } from './runtime.mjs'
import { planUtterance } from './utterance.mjs'

// The brain through the real request handler, with the canned fake model
// injected as fetch: nothing here can reach DeepSeek or a speech provider.
const CLIP = { audio: 'AAAA', format: 'mp3', sampleRate: 32_000, words: [] }

async function start(context, { model = createFakeDeepSeek(), env = { DEEPSEEK_API_KEY: 'test-only' } } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'airi-brain-http-'))
  const synthesised = []
  const speech = {
    health: () => ({ configured: true, provider: 'minimax', model: 'fake', region: 'cn' }),
    async handle(_request, response) { response.writeHead(418); response.end() },
    async synthesise(request) { synthesised.push(request.text); return CLIP },
  }
  let runtime
  const handler = createRequestHandler({ env, root, fetchImpl: model.fetch, speech, live: deps => (runtime = createLiveRuntime(deps)) })
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  // Stop first (it flushes the audit log), then delete the data directory.
  context.after(async () => {
    await handler.stop()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  })
  await runtime.ready
  return { base: `http://127.0.0.1:${server.address().port}/airi`, root, model, synthesised, runtime }
}

const post = (base, path, body) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Airi-Live': '1' }, body: JSON.stringify(body),
})
const control = (base, body) => post(base, '/api/live/control', body)
const state = async base => (await fetch(`${base}/api/live/state`)).json()
async function until(check, label, timeoutMs = 3_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await check()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${label}`)
}

// A stage page over SSE that buys every planned sentence and reports played.
async function playingStage(context, base) {
  const controller = new AbortController()
  context.after(() => controller.abort())
  const response = await fetch(`${base}/api/live/stage/events?role=obs`, { signal: controller.signal })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const said = []
  let leaseId = null
  let buffer = ''
  ;(async () => {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let index
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          const type = /^event: (.+)$/m.exec(frame)?.[1]
          const data = /^data: (.+)$/m.exec(frame)?.[1]
          if (!type || !data) continue
          const payload = JSON.parse(data)
          if (type === 'hello') {
            leaseId = payload.leaseId
            await post(base, '/api/live/stage/report', { leaseId, type: 'ready' })
          }
          if (type === 'say') {
            said.push(payload)
            for (const sentence of await planUtterance(payload))
              await post(base, '/api/live/stage/speech', { leaseId, turnId: payload.turnId, ...sentence })
            await post(base, '/api/live/stage/report', { leaseId, type: 'ended', turnId: payload.turnId, outcome: 'played' })
          }
        }
      }
    }
    catch {}
  })()
  await until(async () => (await state(base)).stage.primary?.ready, 'stage ready')
  return { said }
}

test('a host message is answered by the brain, spoken by the stage, and kept as context', async (context) => {
  const { base, model, synthesised } = await start(context)
  const { said } = await playingStage(context, base)
  const injected = await control(base, { action: 'inject', text: '跟大家打个招呼吧' })
  assert.equal(injected.status, 200)
  await until(() => said.length === 1, 'first reply on stage')
  assert.equal(said[0].text, '欢迎欢迎！今天也一起慢慢聊吧。')
  assert.equal(said[0].delivery, 'bright')
  assert.equal(model.requests[0].max_tokens, 160)
  assert.equal(model.requests[0].messages.at(-1).content, '<viewer_message from="主播" kind="host">跟大家打个招呼吧</viewer_message>')
  await until(async () => (await state(base)).brain.historyRounds === 1, 'history recorded')
  assert.deepEqual(synthesised, ['欢迎欢迎！', '今天也一起慢慢聊吧。'])
  const current = await state(base)
  assert.equal(current.queue.recent[0].status, 'answered')
  assert.equal(current.brain.usage.calls, 1)
  assert.equal(current.brain.configured, true)
})

test('viewer danmaku wait in the queue until the host approves them', async (context) => {
  const { base, model, runtime } = await start(context)
  const { said } = await playingStage(context, base)
  runtime.hub.publish('input.danmaku', { type: 'danmaku', msgId: 'm1', user: { openId: 'o1', name: '甲' }, text: '晚上好' }, { source: 'test' })
  const pending = await until(async () => (await state(base)).queue.open.find(item => item.status === 'pending'), 'pending item')
  assert.equal(pending.user.name, '甲')
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(model.calls, 0, 'nothing unapproved reaches the model')
  assert.equal((await control(base, { action: 'approve', itemId: 'nope' })).status, 404)
  assert.equal((await control(base, { action: 'approve', itemId: pending.id })).status, 200)
  await until(() => said.length === 1, 'approved reply on stage')
  assert.equal(model.requests[0].messages.at(-1).content, '<viewer_message from="甲" kind="danmaku">晚上好</viewer_message>')
  // The item is answered only after the stage reports the turn played, which
  // can land after the next steps under load; wait so the queue is settled.
  await until(async () => (await state(base)).queue.recent.find(item => item.id === pending.id)?.status === 'answered', 'first answered')

  runtime.hub.publish('input.danmaku', { type: 'danmaku', msgId: 'm2', user: { name: '乙' }, text: '不回答这条' }, { source: 'test' })
  const second = await until(async () => (await state(base)).queue.open.find(item => item.status === 'pending'), 'second pending')
  assert.equal((await control(base, { action: 'reject', itemId: second.id })).status, 200)
  assert.equal((await state(base)).queue.recent.find(item => item.id === second.id)?.status, 'rejected')
})

test('the host\'s own "say" passes the output gate without counting a strike', async (context) => {
  const { base } = await start(context)
  await playingStage(context, base)
  const blocked = await control(base, { action: 'say', text: '大家记得刷礼物哦' })
  assert.equal(blocked.status, 400)
  assert.deepEqual(await blocked.json(), { code: 'LIVE_BLOCKED', reason: 'blocklist' })
  const current = await state(base)
  assert.equal(current.turn, null)
  assert.equal(current.lastHostBlock.term, '刷礼物')
  assert.equal(current.brain.strikes, 0)
  assert.equal((await control(base, { action: 'say', text: '大家晚上好。' })).status, 200)
})

test('panic during generation aborts the model request and nothing is spoken', async (context) => {
  const model = createFakeDeepSeek({ delayMs: 5_000 })
  const { base } = await start(context, { model })
  const { said } = await playingStage(context, base)
  await control(base, { action: 'inject', text: '说一句很长的话' })
  await until(async () => (await state(base)).brain.phase === 'generating', 'generating')
  await until(() => model.requests.length === 1, 'model request sent')
  const panic = await (await control(base, { action: 'panic' })).json()
  assert.equal(panic.control, 'panic')
  await until(async () => (await state(base)).brain.phase === 'idle', 'generation aborted')
  const current = await state(base)
  assert.equal(current.queue.recent[0].detail, 'stopped')
  assert.equal(said.length, 0)
  assert.equal(current.brain.usage.calls, 0, 'an aborted call is not counted as a reply')
})

test('without a DeepSeek key the brain stays idle and approved items simply wait', async (context) => {
  const { base, model } = await start(context, { env: {} })
  await playingStage(context, base)
  await control(base, { action: 'inject', text: '你好' })
  await new Promise(resolve => setTimeout(resolve, 50))
  const current = await state(base)
  assert.equal(current.brain.configured, false)
  assert.equal(model.calls, 0)
  assert.equal(current.queue.open[0].status, 'approved')
})

test('a data directory gets the reply ledger and an owner-only audit log', async (context) => {
  const { base, root } = await start(context)
  const { said } = await playingStage(context, base)
  await control(base, { action: 'inject', text: '你好' })
  await until(() => said.length === 1, 'reply on stage')
  await until(async () => (await readdir(join(root, '.data'))).includes('live-logs'), 'audit directory')
  assert.ok((await readdir(join(root, '.data'))).includes('live-reply-budget.json'))
  await until(async () => {
    const [name] = await readdir(join(root, '.data', 'live-logs'))
    return name && (await readFile(join(root, '.data', 'live-logs', name), 'utf8')).includes('"brain.reply"')
  }, 'audit lines')
})

test('panic drops every waiting candidate and the interrupted context; resume starts fresh', async (context) => {
  const { base, model, runtime } = await start(context)
  const { said } = await playingStage(context, base)
  await control(base, { action: 'inject', text: '先聊一句' })
  await until(() => said.length === 1, 'first reply')
  await until(async () => (await state(base)).brain.historyRounds === 1, 'context recorded')
  for (const [index, name] of ['甲', '乙'].entries())
    runtime.hub.publish('input.danmaku', { type: 'danmaku', msgId: `p${index}`, user: { name }, text: `第${index}条` }, { source: 'test' })
  await until(async () => (await state(base)).queue.open.length === 2, 'two waiting')
  const panic = await (await control(base, { action: 'panic' })).json()
  assert.deepEqual(panic.queue.open, [])
  assert.deepEqual(panic.queue.recent.slice(0, 2).map(item => [item.status, item.detail]), [['dropped', 'panic'], ['dropped', 'panic']])
  assert.equal(panic.brain.historyRounds, 0)
  await control(base, { action: 'resume', skipPreflight: true })
  await control(base, { action: 'inject', text: '重新开始' })
  await until(() => model.requests.length === 2, 'second request')
  assert.equal(model.requests[1].messages.length, 2, 'system prompt and the new message only')
})

test('the host\'s "say" is screened as spoken too, and invisible-only text is simply empty', async (context) => {
  const { base } = await start(context)
  await playingStage(context, base)
  const split = await control(base, { action: 'say', text: '记得[刷](a)礼物哦' })
  assert.equal(split.status, 400)
  assert.deepEqual(await split.json(), { code: 'LIVE_BLOCKED', reason: 'blocklist' })
  for (const text of ['\u200b', '\u00ad', '\u200b\u200b '])
    assert.deepEqual(await (await control(base, { action: 'say', text })).json(), { code: 'LIVE_EMPTY' }, JSON.stringify(text))
  assert.equal((await state(base)).lastHostBlock.term, '刷礼物', 'an empty line never replaces the last real block')
})

test('the console sees the durable daily reply count, including after a restart', async (context) => {
  const { base, root } = await start(context)
  const { said } = await playingStage(context, base)
  assert.equal((await state(base)).brain.dailyRepliesReserved, 0)
  await control(base, { action: 'inject', text: '你好' })
  await until(() => said.length === 1, 'reply')
  assert.equal((await state(base)).brain.dailyRepliesReserved, 1)
  const ledger = JSON.parse(await readFile(join(root, '.data', 'live-reply-budget.json'), 'utf8'))
  assert.equal(ledger.reservedCharacters, 1)
  // A second runtime on the same data directory reads the same count.
  const again = createLiveRuntime({ speech: { synthesise: async () => CLIP, health: () => ({}) }, env: {}, root })
  context.after(() => again.stop())
  await again.ready
  const response = { chunks: [], writeHead() {}, end(text) { this.chunks.push(text) } }
  await again.handle({ method: 'GET', url: '/api/live/state', socket: { remoteAddress: '127.0.0.1', localPort: 1 }, headers: { host: '127.0.0.1:1' } },
    Object.assign(response, { destroyed: false, writableEnded: false }), '/api/live/state')
  assert.equal(JSON.parse(response.chunks[0]).brain.dailyRepliesReserved, 1)
})

test('a stage page that connects while the brain is composing starts in the thinking pose', async (context) => {
  const model = createFakeDeepSeek({ delayMs: 5_000 })
  const { base } = await start(context, { model })
  await playingStage(context, base)
  await control(base, { action: 'inject', text: '想一想' })
  await until(async () => (await state(base)).brain.phase === 'generating', 'generating')
  const controller = new AbortController()
  context.after(() => controller.abort())
  const preview = await fetch(`${base}/api/live/stage/events?role=preview`, { signal: controller.signal })
  const reader = preview.body.getReader()
  let text = ''
  while (!text.includes('event: hello')) text += new TextDecoder().decode((await reader.read()).value)
  const hello = JSON.parse(/event: hello\ndata: (.+)/.exec(text)[1])
  assert.equal(hello.activity, 'thinking')
  await control(base, { action: 'stop' })
})
