import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { createSseChannel } from './sse.mjs'

class FakeResponse extends EventEmitter {
  chunks = []
  writableLength = 0
  ended = false
  flushed = false
  writeHead(status, headers) { this.status = status; this.headers = headers }
  flushHeaders() { this.flushed = true }
  write(text) { this.chunks.push(text); return true }
  end() { this.ended = true }
  get text() { return this.chunks.join('') }
}

function fakeIntervals() {
  const intervals = []
  return {
    intervals,
    setInterval(callback, ms) {
      const handle = { callback, ms, cleared: false, unrefed: false, unref() { this.unrefed = true } }
      intervals.push(handle)
      return handle
    },
    clearInterval(handle) { handle.cleared = true },
  }
}

const open = (channel, onClose) => {
  const response = new FakeResponse()
  const client = channel.open(new EventEmitter(), response, { onClose })
  return { response, client }
}

test('a stage stream starts with stream headers and a retry hint, then numbered events', () => {
  const channel = createSseChannel({ timers: fakeIntervals() })
  const { response, client } = open(channel)
  assert.equal(response.status, 200)
  assert.equal(response.headers['Content-Type'], 'text/event-stream; charset=utf-8')
  assert.equal(response.headers['Cache-Control'], 'no-cache, no-store')
  assert.equal(response.headers['X-Accel-Buffering'], 'no')
  assert.equal(response.flushed, true)
  assert.equal(response.chunks[0], 'retry: 2000\n\n')
  client.send('say', { text: '你好' })
  client.send('stop', { turnId: 't' })
  assert.equal(response.chunks[1], 'id: 1\nevent: say\ndata: {"text":"你好"}\n\n')
  assert.equal(response.chunks[2], 'id: 2\nevent: stop\ndata: {"turnId":"t"}\n\n')
})

test('the heartbeat runs only while a page is connected and never holds the process open', () => {
  const timers = fakeIntervals()
  const channel = createSseChannel({ heartbeatMs: 15_000, timers })
  assert.equal(timers.intervals.length, 0, 'importing or creating the channel starts no timer')
  const first = open(channel)
  const second = open(channel)
  assert.equal(timers.intervals.length, 1, 'one shared heartbeat')
  const [heartbeat] = timers.intervals
  assert.equal(heartbeat.ms, 15_000)
  assert.equal(heartbeat.unrefed, true)
  heartbeat.callback()
  assert.equal(first.response.chunks.at(-1), ': ping\n\n')
  assert.equal(second.response.chunks.at(-1), ': ping\n\n')
  first.client.close()
  assert.equal(heartbeat.cleared, false)
  second.response.emit('close')
  assert.equal(heartbeat.cleared, true)
  assert.equal(channel.size, 0)
})

test('a page that stops reading is dropped instead of buffering forever', async () => {
  const channel = createSseChannel({ maxBufferedBytes: 100, timers: fakeIntervals() })
  let closed = 0
  const { response, client } = open(channel, () => closed++)
  response.writableLength = 101
  assert.equal(client.send('say', { text: 'x' }), false)
  assert.equal(response.ended, true)
  assert.equal(channel.size, 0)
  assert.equal(closed, 0, 'onClose is deferred out of the publishing call')
  await Promise.resolve()
  assert.equal(closed, 1)
  assert.equal(client.send('say', { text: 'x' }), false, 'a closed client never writes again')
  client.close()
  await Promise.resolve()
  assert.equal(closed, 1, 'onClose fires once')
})

test('closeAll ends every open stream', () => {
  const channel = createSseChannel({ timers: fakeIntervals() })
  const pages = [open(channel), open(channel)]
  channel.closeAll()
  assert.ok(pages.every(page => page.response.ended && page.client.closed))
  assert.equal(channel.size, 0)
})
