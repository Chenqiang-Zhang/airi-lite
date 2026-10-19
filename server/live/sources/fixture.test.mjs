import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { createFixtureSource, loadFixture, parseFixture } from './fixture.mjs'

function fakeTimers() {
  const pending = new Set()
  return {
    pending,
    setTimeout(callback, ms) { const handle = { callback, ms }; pending.add(handle); return handle },
    clearTimeout(handle) { pending.delete(handle) },
    runAll() {
      const handles = [...pending].sort((a, b) => a.ms - b.ms)
      for (const handle of handles) { pending.delete(handle); handle.callback() }
    },
  }
}

test('fixtures parse in time order and reject malformed lines', () => {
  const entries = parseFixture('// comment\n{"atMs": 20, "kind": "danmaku", "text": "二"}\n\n{"atMs": 10, "kind": "superchat", "text": "一", "amountCny": 30}\n')
  assert.deepEqual(entries.map(entry => entry.text), ['一', '二'])
  assert.throws(() => parseFixture('{oops'), /line 1 is not JSON/)
  assert.throws(() => parseFixture('{"atMs": -1, "kind": "danmaku"}'), /line 1 needs atMs/)
  assert.throws(() => parseFixture('{"atMs": 1, "kind": "rocket"}'), /known kind/)
})

test('replayed events have the Bilibili source shape, scaled timing and unique ids per loop', () => {
  const timers = fakeTimers()
  const events = []
  const source = createFixtureSource({
    entries: parseFixture('{"atMs": 1000, "kind": "danmaku", "user": {"name": "甲", "guardLevel": 3}, "text": "你好"}\n{"atMs": 3000, "kind": "danmaku", "text": "[吃瓜]", "emoji": true}'),
    onEvent: event => events.push(event), timers, speed: 10, loop: true, now: () => 42,
  })
  source.start()
  assert.deepEqual([...timers.pending].map(handle => handle.ms).sort((a, b) => a - b), [100, 300, 400])
  timers.runAll()
  assert.deepEqual(events[0], {
    type: 'danmaku', cmd: 'FIXTURE', msgId: 'fixture-0-0', ts: 42, roomId: null,
    user: { openId: 'fixture-viewer-0', name: '甲', face: '', guardLevel: 3, medalName: '', medalLevel: 0, isAdmin: false },
    text: '你好', emoji: null, amountCny: 0,
  })
  assert.deepEqual(events[1].emoji, { url: '' })
  timers.runAll()
  assert.deepEqual(events.map(event => event.msgId), ['fixture-0-0', 'fixture-0-1', 'fixture-1-0', 'fixture-1-1'])
  source.stop()
  assert.equal(timers.pending.size, 0)
})

test('the bundled 30-minute rehearsal parses and spans the half hour', async () => {
  const entries = await loadFixture(fileURLToPath(new URL('../fixtures/rehearsal.jsonl', import.meta.url)))
  assert.ok(entries.length >= 40)
  assert.ok(entries.at(-1).atMs > 25 * 60_000 && entries.at(-1).atMs <= 30 * 60_000)
  assert.ok(entries.some(entry => entry.kind === 'superchat'))
  assert.ok(entries.some(entry => /指令|提示词|设定/.test(entry.text)), 'includes prompt-injection attempts')
})
