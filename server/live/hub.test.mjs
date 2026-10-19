import assert from 'node:assert/strict'
import test from 'node:test'

import { createHub } from './hub.mjs'

test('events are envelopes delivered by prefix, in subscription order', () => {
  let id = 0
  const hub = createHub({ now: () => 1_000, newId: () => `e${++id}` })
  const seen = []
  hub.subscribe('', event => seen.push(['all', event.type]))
  hub.subscribe('input', event => seen.push(['input', event.type]))
  hub.subscribe('input.danmaku', event => seen.push(['danmaku', event.type]))
  const event = hub.publish('input.danmaku', { text: '你好' }, { source: 'fixture', parentId: 'p1' })
  hub.publish('inputs.other', {})
  hub.publish('turn.ended', { turnId: 't' })
  assert.deepEqual(event, { id: 'e1', type: 'input.danmaku', source: 'fixture', ts: 1_000, parentId: 'p1', data: { text: '你好' } })
  assert.ok(Object.isFrozen(event))
  assert.deepEqual(seen, [['all', 'input.danmaku'], ['input', 'input.danmaku'], ['danmaku', 'input.danmaku'],
    ['all', 'inputs.other'], ['all', 'turn.ended']], '"input" does not match "inputs.other"')
})

test('a failing subscriber, sync or async, never stops the others', async () => {
  const errors = []
  const hub = createHub({ onError: error => errors.push(error.message) })
  const seen = []
  hub.subscribe('', () => { throw new Error('sync boom') })
  hub.subscribe('', async () => { throw new Error('async boom') })
  hub.subscribe('', event => seen.push(event.type))
  hub.publish('control.changed', {})
  await Promise.resolve()
  assert.deepEqual(seen, ['control.changed'])
  assert.deepEqual(errors.sort(), ['async boom', 'sync boom'])
})

test('unsubscribing during a publish takes effect for later subscribers', () => {
  const hub = createHub()
  const seen = []
  let second = null
  hub.subscribe('', () => second())
  second = hub.subscribe('', () => seen.push('second'))
  hub.publish('x', {})
  assert.deepEqual(seen, [])
  assert.equal(hub.size, 1)
})
