import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import test from 'node:test'

import { createLiveRuntime } from './runtime.mjs'

// A frozen OBS source stops reading its event stream; the next write that
// finds >256 KiB buffered closes it, which changes the lease while the runtime
// is still publishing. Fake request/response objects let the test stall the
// primary deterministically instead of filling a real socket.
const socket = { remoteAddress: '127.0.0.1', localPort: 5173 }
const host = '127.0.0.1:5173'

function fakeResponse() {
  const response = new EventEmitter()
  Object.assign(response, { chunks: [], writableLength: 0, destroyed: false, writableEnded: false, headersSent: false, status: null })
  response.writeHead = (status) => { response.status = status; response.headersSent = true; return response }
  response.flushHeaders = () => {}
  response.write = (text) => { response.chunks.push(String(text)); return true }
  response.end = (text) => { if (text) response.chunks.push(String(text)); response.writableEnded = true }
  response.events = () => response.chunks.filter(chunk => chunk.startsWith('id: '))
    .map(chunk => ({ type: /event: (\w+)/.exec(chunk)[1], data: JSON.parse(chunk.split('data: ')[1]) }))
  response.json = () => JSON.parse(response.chunks.at(-1))
  return response
}

const get = url => ({ method: 'GET', url, socket, headers: { host } })
function post(url, body) {
  const request = Readable.from([Buffer.from(JSON.stringify(body))])
  Object.assign(request, { method: 'POST', url, socket, headers: { host, 'content-type': 'application/json', 'x-airi-live': '1' } })
  return request
}

async function setup() {
  const pending = []
  const timers = {
    setTimeout: (callback, ms) => { const handle = { callback, ms, unref() {} }; pending.push(handle); return handle },
    clearTimeout: (handle) => { const index = pending.indexOf(handle); if (index >= 0) pending.splice(index, 1) },
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
  }
  let ids = 0
  const runtime = createLiveRuntime({ speech: { synthesise: async () => ({}), health: () => ({}) }, timers, newId: () => `id-${++ids}` })
  const call = async (request, path) => {
    const response = fakeResponse()
    await runtime.handle(request, response, path)
    return response
  }
  const stage = fakeResponse()
  await runtime.handle(get('/api/live/stage/events?role=obs'), stage, '/api/live/stage/events')
  const leaseId = stage.events().find(event => event.type === 'hello').data.leaseId
  await call(post('/api/live/stage/report', { leaseId, type: 'ready' }), '/api/live/stage/report')
  const preview = fakeResponse()
  await runtime.handle(get('/api/live/stage/events?role=preview'), preview, '/api/live/stage/events')
  return {
    runtime, stage, preview, pending,
    control: body => call(post('/api/live/control', body), '/api/live/control'),
    state: async () => (await call(get('/api/live/state'), '/api/live/state')).json(),
    stall() { stage.writableLength = 300_000 },
  }
}

test('stopping while the stalled primary is dropped records "stopped" and does not throw', async () => {
  const f = await setup()
  await f.control({ action: 'say', text: '你好。' })
  f.stall()
  const stopped = await f.control({ action: 'stop' })
  assert.equal(stopped.status, 200)
  await Promise.resolve()
  const state = await f.state()
  assert.equal(state.turn, null)
  assert.equal(state.lastOutcome.outcome, 'stopped')
  assert.equal(state.stage.primary, null, 'the frozen page lost its lease')
})

test('a watchdog that drops the stalled primary cannot throw out of its timer', async () => {
  const f = await setup()
  await f.control({ action: 'say', text: '没有人回报。' })
  f.stall()
  const watchdog = f.pending.find(handle => handle.ms > 15_000)
  assert.doesNotThrow(() => watchdog.callback())
  await Promise.resolve()
  assert.equal((await f.state()).lastOutcome.outcome, 'timeout')
})

test('panic still reaches the brb screen when its stop drops the primary', async () => {
  const f = await setup()
  await f.control({ action: 'say', text: '紧急停止。' })
  f.stall()
  const panic = await f.control({ action: 'panic' })
  assert.equal(panic.status, 200)
  assert.equal(panic.json().control, 'panic')
  assert.equal(panic.json().mode, 'brb')
  assert.deepEqual(f.preview.events().slice(-2).map(event => event.type), ['stop', 'mode'])
  await f.runtime.stop()
})

test('a say whose publish drops the primary is refused, and pages end on "stop"', async () => {
  const f = await setup()
  f.stall()
  const said = await f.control({ action: 'say', text: '发不出去。' })
  assert.equal(said.status, 409)
  assert.deepEqual(said.json(), { code: 'LIVE_NO_STAGE' })
  const types = f.preview.events().map(event => event.type)
  assert.equal(types.at(-1), 'stop', 'a preview never keeps a caption for a cancelled turn')
  assert.ok(types.indexOf('say') < types.lastIndexOf('stop'))
  const state = await f.state()
  assert.equal(state.turn, null)
  assert.equal(state.lastOutcome.outcome, 'cancelled')
})
