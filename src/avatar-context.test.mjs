import assert from 'node:assert/strict'
import test from 'node:test'
import { createAvatarContext } from './avatar-context.ts'

function fixture(options = {}) {
  let now = 0
  let nextId = 0
  const timers = []
  const cancelled = []
  const changes = []
  const context = createAvatarContext({
    ...options,
    onChange: delivery => changes.push(delivery),
    schedule(callback, delayMs) {
      const timer = { id: ++nextId, callback, due: now + delayMs, cancelled: false, fired: false }
      timers.push(timer)
      return timer.id
    },
    cancel(id) {
      cancelled.push(id)
      timers.find(timer => timer.id === id).cancelled = true
    },
  })
  function advance(ms) {
    const target = now + ms
    for (;;) {
      const next = timers.find(timer => !timer.cancelled && !timer.fired && timer.due <= target)
      if (!next)
        break
      now = next.due
      next.fired = true
      next.callback()
    }
    now = target
  }
  return { context, changes, timers, cancelled, advance,
    pending: () => timers.filter(timer => !timer.cancelled && !timer.fired) }
}

const idle = (spokenDelivery = 'neutral') => ({ speaking: false, waiting: false, spokenDelivery })
const waiting = (spokenDelivery = 'neutral') => ({ speaking: false, waiting: true, spokenDelivery })
const speaking = spokenDelivery => ({ speaking: true, waiting: false, spokenDelivery })

test('initial idle has a readable neutral context and no timer or callbacks', () => {
  const f = fixture()
  f.context.sync(idle('bright'))
  f.context.sync(idle('curious'))
  assert.equal(f.context.current, 'neutral')
  assert.deepEqual(f.changes, [])
  assert.equal(f.timers.length, 0)
})

test('a low-mood first turn remains soft while waiting without inventing speech', () => {
  const f = fixture()
  f.context.beginTurn('今天有点低落，不想说话。')
  assert.equal(f.context.current, 'soft')
  f.context.sync(waiting('bright'))
  f.advance(20_000)
  assert.equal(f.context.current, 'soft')
  assert.deepEqual(f.changes, ['soft'])
  assert.equal(f.timers.length, 0)
})

test('a neutral new topic clears the previous cue and its release timer', () => {
  const f = fixture()
  f.context.sync(speaking('bright'))
  f.context.sync(idle())
  const oldTimer = f.timers[0]
  f.context.beginTurn('晚饭吃什么？')
  assert.equal(f.context.current, 'neutral')
  assert.deepEqual(f.cancelled, [oldTimer.id])
  f.context.sync(waiting('bright'))
  oldTimer.callback()
  f.advance(10_000)
  assert.equal(f.context.current, 'neutral')
  assert.deepEqual(f.changes, ['bright', 'neutral'])
  assert.equal(f.pending().length, 0)
})

test('only cues from actual speaking override context, including between sentences', () => {
  const f = fixture()
  f.context.beginTurn('昨天不开心。')
  f.context.sync(waiting('bright'))
  assert.equal(f.context.current, 'soft')
  f.context.sync(speaking('bright'))
  assert.equal(f.context.current, 'bright')
  f.context.sync(waiting('curious'))
  f.advance(2_499)
  assert.equal(f.context.current, 'bright')
  f.advance(1)
  assert.equal(f.context.current, 'soft')
  f.context.sync(speaking('curious'))
  assert.equal(f.context.current, 'curious')
  f.context.sync(idle('soft'))
  assert.equal(f.context.current, 'curious')
  assert.deepEqual(f.changes, ['soft', 'bright', 'soft', 'curious'])
  assert.equal(f.pending().length, 1)
})

test('simultaneous speaking and waiting still uses the current audible cue', () => {
  const f = fixture()
  f.context.beginTurn('今天好累。')
  f.context.sync({ speaking: true, waiting: true, spokenDelivery: 'curious' })
  assert.equal(f.context.current, 'curious')
  assert.equal(f.timers.length, 0)
})

test('the first active-to-idle transition releases after 2500 ms; sync cannot extend it', () => {
  const f = fixture()
  f.context.beginTurn('我很难过。')
  f.context.sync(idle('bright'))
  f.advance(1_000)
  f.context.sync(idle('curious'))
  f.advance(1_499)
  f.context.sync(idle('bright'))
  assert.equal(f.context.current, 'soft')
  assert.equal(f.timers.length, 1)
  f.advance(1)
  assert.equal(f.context.current, 'neutral')
  f.context.sync(idle('soft'))
  f.advance(10_000)
  assert.deepEqual(f.changes, ['soft', 'neutral'])
  assert.equal(f.timers.length, 1)
})

test('waiting and idle retarget one release window without extending its deadline', () => {
  const f = fixture()
  f.context.beginTurn('今天有点低落。')
  f.context.sync(speaking('bright'))
  f.context.sync(waiting('curious'))
  f.advance(2_000)
  f.context.sync(waiting('soft'))
  assert.equal(f.context.current, 'bright')
  assert.equal(f.timers.length, 1)
  f.context.sync(idle('curious'))
  f.advance(499)
  assert.equal(f.context.current, 'bright')
  f.advance(1)
  assert.equal(f.context.current, 'neutral')
  assert.equal(f.timers.length, 1)
})

test('long neutral sentence waits release the last cue and repeated sync cannot revive it', () => {
  const f = fixture()
  f.context.beginTurn('今天买了本书。')
  f.context.sync(speaking('bright'))
  f.context.sync(waiting('curious'))
  f.advance(2_000)
  f.context.sync(waiting('curious'))
  f.advance(500)
  assert.equal(f.context.current, 'neutral')
  f.context.sync(waiting('bright'))
  f.advance(9_000)
  assert.equal(f.context.current, 'neutral')
  assert.equal(f.timers.length, 1)
  f.context.sync(speaking('soft'))
  assert.equal(f.context.current, 'soft')
})

test('a wait resuming during an idle release returns to its contextual baseline on time', () => {
  const f = fixture()
  f.context.beginTurn('今天很难过。')
  f.context.sync(speaking('curious'))
  f.context.sync(idle())
  f.advance(2_000)
  f.context.sync(waiting('bright'))
  f.advance(500)
  assert.equal(f.context.current, 'soft')
  assert.equal(f.timers.length, 1)
  f.context.sync(idle())
  f.advance(2_500)
  assert.equal(f.context.current, 'neutral')
})

test('resuming speech invalidates a gap timer even if its old callback already queued', () => {
  const f = fixture()
  f.context.sync(speaking('bright'))
  f.context.sync(waiting('soft'))
  const oldTimer = f.timers[0]
  f.context.sync(speaking('curious'))
  oldTimer.callback()
  f.advance(9_000)
  assert.equal(f.context.current, 'curious')
  assert.deepEqual(f.cancelled, [oldTimer.id])
})

test('resumed speech cancels an idle release and stale callbacks cannot reset its cue', () => {
  const f = fixture()
  f.context.sync(speaking('soft'))
  f.context.sync(idle())
  const oldTimer = f.timers[0]
  f.context.sync(speaking('curious'))
  oldTimer.callback()
  assert.equal(f.context.current, 'curious')
  f.context.sync(idle())
  oldTimer.callback()
  assert.equal(f.context.current, 'curious')
  assert.equal(f.pending().length, 1)
  f.advance(2_500)
  assert.equal(f.context.current, 'neutral')
})

test('a new low-mood turn is not neutralized by the previous turn timer', () => {
  const f = fixture()
  f.context.sync(speaking('bright'))
  f.context.sync(idle())
  const oldTimer = f.timers[0]
  f.context.beginTurn('有点孤独。')
  oldTimer.callback()
  f.advance(5_000)
  assert.equal(f.context.current, 'soft')
  assert.deepEqual(f.changes, ['bright', 'soft'])
})

test('clear cancels, resets and remains safe when an old callback runs in a later turn', () => {
  const f = fixture()
  f.context.sync(speaking('bright'))
  f.context.sync(idle())
  const oldTimer = f.timers[0]
  f.context.clear()
  f.context.clear()
  assert.equal(f.context.current, 'neutral')
  assert.deepEqual(f.changes, ['bright', 'neutral'])
  assert.deepEqual(f.cancelled, [oldTimer.id])
  f.context.beginTurn('今天不开心。')
  oldTimer.callback()
  f.context.sync(idle())
  oldTimer.callback()
  assert.equal(f.context.current, 'soft')
  f.advance(2_500)
  assert.equal(f.context.current, 'neutral')
})

test('destroy silently resets, cancels once and leaves every later method inert', () => {
  const f = fixture()
  f.context.sync(speaking('bright'))
  f.context.sync(idle())
  const oldTimer = f.timers[0]
  f.context.destroy()
  assert.equal(f.context.current, 'neutral')
  assert.deepEqual(f.changes, ['bright'])
  assert.deepEqual(f.cancelled, [oldTimer.id])
  f.context.destroy()
  f.context.beginTurn('很难过。')
  f.context.sync(speaking('soft'))
  f.context.sync(waiting('curious'))
  f.context.sync(idle('bright'))
  f.context.clear()
  oldTimer.callback()
  f.advance(10_000)
  assert.equal(f.context.current, 'neutral')
  assert.deepEqual(f.changes, ['bright'])
  assert.deepEqual(f.cancelled, [oldTimer.id])
  assert.equal(f.timers.length, 1)
})

test('unchanged context never re-notifies a mounted avatar and neutral idle needs no timer', () => {
  const f = fixture()
  f.context.beginTurn('今天有点低落。')
  f.context.sync(speaking('soft'))
  f.context.sync(speaking('soft'))
  f.context.sync(waiting())
  assert.deepEqual(f.changes, ['soft'])
  f.context.sync(speaking('neutral'))
  f.context.sync(idle())
  assert.equal(f.context.current, 'neutral')
  assert.deepEqual(f.changes, ['soft', 'neutral'])
  assert.equal(f.timers.length, 0)
})

for (const action of ['beginTurn', 'clear', 'destroy']) {
  test(`${action} invalidates a sentence-gap timer even after its target changes`, () => {
    const f = fixture()
    f.context.beginTurn('今天好累。')
    f.context.sync(speaking('bright'))
    f.context.sync(waiting('curious'))
    const oldTimer = f.timers[0]
    f.context.sync(idle())
    f.context.sync(waiting('bright'))
    if (action === 'beginTurn')
      f.context.beginTurn('今天有点孤独。')
    else
      f.context[action]()
    const expected = action === 'beginTurn' ? 'soft' : 'neutral'
    const count = f.changes.length
    oldTimer.callback()
    f.advance(10_000)
    assert.equal(f.context.current, expected)
    assert.equal(f.changes.length, count)
    assert.deepEqual(f.cancelled, [oldTimer.id])
    assert.equal(f.pending().length, 0)
  })
}
