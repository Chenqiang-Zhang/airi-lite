import assert from 'node:assert/strict'
import test from 'node:test'

import { createCandidateQueue } from './queue.mjs'

function setup(options = {}) {
  let time = 0
  let id = 0
  const queue = createCandidateQueue({ now: () => time, newId: () => `i${++id}`, ...options })
  const changes = []
  queue.onChange((item, change) => changes.push([item.id, change]))
  return { queue, changes, advance: ms => (time += ms) }
}
const viewer = name => ({ openId: `o-${name}`, name, guardLevel: 0, medalLevel: 3, isAdmin: false })

test('viewer messages wait for approval; host messages arrive approved', () => {
  const { queue } = setup()
  const danmaku = queue.add({ kind: 'danmaku', msgId: 'm1', user: viewer('甲'), text: '你好' })
  assert.equal(danmaku.status, 'pending')
  assert.equal(queue.hasApproved(), false)
  assert.deepEqual(queue.take(), [], 'nothing unapproved is ever handed to the brain')
  const host = queue.add({ kind: 'host', text: '大家晚上好' })
  assert.equal(host.status, 'approved')
  assert.deepEqual(queue.take().map(item => item.id), [host.id])
  assert.equal(queue.approve(danmaku.id), true)
  assert.equal(queue.approve(danmaku.id), false, 'approving twice does nothing')
  assert.deepEqual(queue.take().map(item => item.id), [danmaku.id])
})

test('approved items are taken Super Chat first, then host, then danmaku, oldest first, at most three', () => {
  const { queue, advance } = setup()
  const ids = []
  for (const kind of ['danmaku', 'danmaku', 'superchat', 'host', 'danmaku']) {
    const item = queue.add({ kind, msgId: `m${ids.length}`, user: viewer('x'), text: kind, amountCny: kind === 'superchat' ? 30 : 0 })
    queue.approve(item.id)
    ids.push(item.id)
    advance(10)
  }
  assert.deepEqual(queue.take().map(item => item.kind), ['superchat', 'host', 'danmaku'])
  assert.deepEqual(queue.take(5).map(item => item.id), [ids[1], ids[4]])
})

test('expired, rejected, duplicate, sticker and mirror messages never reach the brain', () => {
  const { queue, advance } = setup()
  const old = queue.add({ kind: 'danmaku', msgId: 'm1', user: viewer('甲'), text: '早' })
  queue.approve(old.id)
  advance(2 * 60_000)
  assert.equal(queue.hasApproved(), false, 'danmaku expire after two minutes')
  assert.equal(queue.snapshot().recent[0].status, 'expired')
  assert.equal(queue.add({ kind: 'danmaku', msgId: 'm1', user: viewer('甲'), text: '早' }), null, 'msgId dedupe')
  assert.equal(queue.add({ kind: 'danmaku', msgId: 'm2', user: viewer('乙'), text: '[吃瓜]', emoji: { url: '' } }), null)
  assert.equal(queue.add({ kind: 'danmaku', msgId: 'm3', text: '跨房', mirror: true }), null)
  assert.equal(queue.add({ kind: 'gift', msgId: 'm4', text: '' }), null, 'gifts are not chat candidates')
  assert.equal(queue.add({ kind: 'danmaku', msgId: 'm5', text: '   ' }), null)
  const rejected = queue.add({ kind: 'danmaku', msgId: 'm6', user: viewer('丙'), text: '不回答这条' })
  assert.equal(queue.reject(rejected.id), true)
  assert.equal(queue.approve(rejected.id), false)
  const superchat = queue.add({ kind: 'superchat', msgId: 'm7', user: viewer('丁'), text: 'SC', amountCny: 30 })
  queue.approve(superchat.id)
  advance(9 * 60_000)
  assert.equal(queue.hasApproved(), true, 'Super Chats wait ten minutes')
})

test('a full queue drops its weakest message, but never a stronger one for a weaker one', () => {
  const { queue } = setup({ maxOpen: 2 })
  const first = queue.add({ kind: 'danmaku', msgId: 'a', user: viewer('甲'), text: '一' })
  queue.add({ kind: 'superchat', msgId: 'b', user: viewer('乙'), text: '二', amountCny: 50 })
  const third = queue.add({ kind: 'danmaku', msgId: 'c', user: viewer('丙'), text: '三' })
  assert.ok(third)
  assert.equal(queue.snapshot().recent[0].id, first.id)
  assert.equal(queue.snapshot().recent[0].status, 'dropped')
  queue.add({ kind: 'superchat', msgId: 'd', user: viewer('丁'), text: '四', amountCny: 30 })
  assert.equal(queue.add({ kind: 'danmaku', msgId: 'e', user: viewer('戊'), text: '五' }), null,
    'two Super Chats are never displaced by a danmaku')
})

test('taken items resolve once as answered, blocked or failed, and long text is clipped', () => {
  const { queue, changes } = setup()
  const item = queue.add({ kind: 'host', text: '长'.repeat(500) })
  assert.equal(item.text.length, 200)
  const [taken] = queue.take()
  assert.equal(taken.status, 'answering')
  queue.complete([taken.id], 'blocked', 'url')
  queue.complete([taken.id], 'answered')
  const [resolved] = queue.snapshot().recent
  assert.equal(resolved.status, 'blocked')
  assert.equal(resolved.detail, 'url')
  assert.deepEqual(changes.map(([, change]) => change), ['added', 'answering', 'blocked'])
})
