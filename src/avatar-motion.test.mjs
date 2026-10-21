import assert from 'node:assert/strict'
import test from 'node:test'
import { MOTION_PRIORITY, createMotionDirector, pickIdleIndex } from './avatar-motion.ts'

function fakePort(counts = { Idle: 3, Gesture: 3, Tap: 1 }) {
  const port = {
    calls: [],
    isBusy: false,
    playing: null,
    failures: new Set(),
    results: [], // queued play results (true/false or a pending promise); default true
    busy: () => port.isBusy,
    play(group, index, force) {
      port.calls.push([group, index, force])
      const result = port.results.length ? port.results.shift() : true
      return result instanceof Promise ? result : Promise.resolve(result)
    },
    failed: (group, index) => port.failures.has(`${group}/${index}`),
    current: () => port.playing,
    stop() {
      port.calls.push(['stop'])
      port.playing = null
    },
    count: group => counts[group] ?? 0,
  }
  return port
}

function rig(motions, { random = [] } = {}) {
  let time = 100_000
  let reduced = false
  const draws = [...random]
  const port = fakePort()
  const director = createMotionDirector({
    motions,
    port,
    now: () => time,
    random: () => {
      rig.draws++
      return draws.length ? draws.shift() : 0
    },
    reducedMotion: () => reduced,
  })
  rig.draws = 0
  const last = () => director.inspect().decisions.at(-1)
  return { director, port, last, advance: ms => (time += ms), setReduced: value => (reduced = value), queueRandom: (...values) => draws.push(...values) }
}

const gesture = (index = 0, extra = {}) => ({ motions: [{ group: 'Gesture', index }], ...extra })

test('each gate stops an offer in order and logs its code; the random draw comes last', async () => {
  const { director, port, last, advance, setReduced, queueRandom } = rig({
    minGapMs: 1_000,
    maxPerTurn: 1,
    acts: { laugh: gesture(0, { chance: 0.5, cooldownMs: 5_000 }), sigh: gesture(1, { chance: 0.5 }) },
  })
  assert.equal(await director.offerAct('pause'), false)
  assert.equal(last().code, 'unmapped')
  assert.equal(last().trigger, 'act:pause')

  queueRandom(0.1)
  assert.equal(await director.offerAct('laugh'), true)
  assert.deepEqual(last(), { at: 100_000, trigger: 'act:laugh', code: 'play', group: 'Gesture', index: 0 })
  assert.equal(rig.draws, 1)

  // Everything fails now; the earliest gate is the one reported.
  port.isBusy = true
  setReduced(true)
  const expectations = [
    ['reduced', () => setReduced(false)],
    ['turn-limit', () => director.beginTurn()],
    ['gap', () => advance(1_000)],
    ['cooldown', () => advance(4_000)],
    ['busy', () => { port.isBusy = false }],
  ]
  for (const [code, clear] of expectations) {
    assert.equal(await director.offerAct('laugh'), false)
    assert.equal(last().code, code)
    assert.equal(rig.draws, 1, `${code} is decided before any random draw`)
    clear()
  }
  queueRandom(0.5)
  assert.equal(await director.offerAct('laugh'), false)
  assert.equal(last().code, 'chance')
  assert.equal(rig.draws, 2)
  assert.deepEqual(port.calls, [['Gesture', 0, false]])
})

test('a chance below the threshold plays and one at or above it does not', async () => {
  const { director, port, last, queueRandom } = rig({ minGapMs: 0, maxPerTurn: 10, acts: { laugh: gesture(0, { chance: 0.4 }) } })
  queueRandom(0.4, 0.39, 0.9999)
  assert.equal(await director.offerAct('laugh'), false)
  assert.equal(last().code, 'chance')
  assert.equal(await director.offerAct('laugh'), true)
  assert.equal(await director.offerAct('laugh'), false)
  assert.equal(port.calls.length, 1)
  const always = rig({ minGapMs: 0, maxPerTurn: 10, acts: { laugh: gesture() } }, { random: [0.99999] })
  assert.equal(await always.director.offerAct('laugh'), true, 'no chance means always')
})

test('a refused start consumes neither cooldown, gap nor turn count, and a start in flight blocks a second one', async () => {
  const { director, port, last } = rig({ minGapMs: 8_000, maxPerTurn: 1, acts: { laugh: gesture(0, { cooldownMs: 20_000 }) } })
  port.results.push(false)
  assert.equal(await director.offerAct('laugh'), false)
  assert.equal(last().code, 'refused')
  assert.deepEqual(director.inspect().decisions.map(decision => decision.code), ['play', 'refused'])
  assert.equal(director.inspect().startsThisTurn, 0)
  assert.equal(director.inspect().lastStart, null)
  assert.deepEqual(director.inspect().cooldowns, {})
  assert.equal(await director.offerAct('laugh'), true, 'nothing was consumed')

  const pending = rig({ minGapMs: 8_000, maxPerTurn: 2, acts: { laugh: gesture(0), sigh: gesture(1) } })
  let finish
  pending.port.results.push(new Promise(resolve => (finish = resolve)))
  const first = pending.director.offerAct('laugh')
  assert.equal(await pending.director.offerAct('sigh'), false)
  assert.equal(pending.last().code, 'gap', 'recorded at request time')
  finish(false)
  assert.equal(await first, false)
  assert.equal(pending.director.inspect().startsThisTurn, 0)
  assert.equal(await pending.director.offerAct('sigh'), true, 'rolled back once refused')

  const rejected = rig({ minGapMs: 8_000, maxPerTurn: 1, acts: { laugh: gesture(0) } })
  rejected.port.results.push(Promise.reject(new Error('load failed')))
  assert.equal(await rejected.director.offerAct('laugh'), false)
  assert.equal(rejected.director.inspect().startsThisTurn, 0)
})

test('round-robin per trigger skips motions that failed to load', async () => {
  const { director, port, last } = rig({
    minGapMs: 0,
    maxPerTurn: 10,
    acts: { laugh: { motions: [0, 1, 2].map(index => ({ group: 'Gesture', index })) } },
  })
  port.failures.add('Gesture/1')
  for (let index = 0; index < 4; index++) await director.offerAct('laugh')
  assert.deepEqual(port.calls.map(([, index]) => index), [0, 2, 0, 2])
  port.failures.add('Gesture/0').add('Gesture/2')
  assert.equal(await director.offerAct('laugh'), false)
  assert.equal(last().code, 'failed')
  // An unresolved, index-less ref covers its whole group.
  const whole = rig({ minGapMs: 0, maxPerTurn: 10, acts: { laugh: { motions: [{ group: 'Gesture' }] } } })
  for (let index = 0; index < 4; index++) await whole.director.offerAct('laugh')
  assert.deepEqual(whole.port.calls.map(([, index]) => index), [0, 1, 2, 0])
})

test('beginTurn resets the turn count and the tone dedupe, and offers turnStart when one is configured', async () => {
  const { director, port, last } = rig({
    minGapMs: 0,
    maxPerTurn: 1,
    emotions: { happy: gesture(0), sad: gesture(1) },
  })
  assert.equal(await director.offerTone('happy'), true)
  assert.equal(await director.offerTone('happy'), false)
  assert.equal(director.inspect().decisions.length, 1, 'the same tone again is not offered')
  assert.equal(await director.offerTone('sad'), false)
  assert.equal(last().code, 'turn-limit')
  assert.equal(await director.offerTone('sad'), false)
  assert.equal(director.inspect().decisions.length, 2)
  director.beginTurn()
  assert.equal(director.inspect().startsThisTurn, 0)
  assert.equal(director.inspect().lastTone, null)
  assert.equal(await director.offerTone('sad'), true)
  assert.deepEqual(port.calls, [['Gesture', 0, false], ['Gesture', 1, false]])
  assert.equal(director.inspect().decisions.length, 3, 'no turnStart configured, nothing offered')

  const greeting = rig({ minGapMs: 0, maxPerTurn: 2, turnStart: gesture(2) })
  greeting.director.beginTurn()
  await Promise.resolve()
  assert.deepEqual(greeting.port.calls, [['Gesture', 2, false]])
  assert.equal(greeting.last().trigger, 'turnStart')
})

test('tap ignores chance, cooldown, gap, turn limit and reduced motion, but never interrupts a gesture', async () => {
  const { director, port, last, setReduced } = rig({
    minGapMs: 60_000,
    maxPerTurn: 0,
    tap: { motions: [{ group: 'Tap', index: 0 }], chance: 0, cooldownMs: 600_000 },
  })
  setReduced(true)
  assert.equal(await director.tap(), true)
  assert.equal(await director.tap(), true)
  assert.equal(director.inspect().startsThisTurn, 0, 'a click does not use up gestures')
  port.isBusy = true
  assert.equal(await director.tap(), false)
  assert.equal(last().code, 'busy')
  assert.deepEqual(port.calls, [['Tap', 0, false], ['Tap', 0, false]])
  const unmapped = rig({ minGapMs: 0, maxPerTurn: 2 })
  assert.equal(await unmapped.director.tap(), false)
  assert.equal(unmapped.last().code, 'unmapped')
})

test('a direct play uses NORMAL with the gates for busy and reduced motion, and force uses FORCE', async () => {
  const { director, port, last, setReduced } = rig({ minGapMs: 0, maxPerTurn: 0 })
  assert.equal(await director.play('Idle', 1), true)
  assert.deepEqual(port.calls.at(-1), ['Idle', 1, false])
  await director.play('Idle')
  await director.play('Idle')
  assert.deepEqual(port.calls.slice(-2), [['Idle', 0, false], ['Idle', 1, false]], 'an omitted index round-robins the group')
  port.isBusy = true
  assert.equal(await director.play('Idle', 2), false)
  assert.equal(last().code, 'busy')
  setReduced(true)
  port.isBusy = false
  assert.equal(await director.play('Idle', 2), false)
  assert.equal(last().code, 'reduced')
  port.isBusy = true
  assert.equal(await director.play('Idle', 2, { force: true }), true)
  assert.deepEqual(port.calls.at(-1), ['Idle', 2, true])
  assert.equal(await director.play('Nope'), false)
  assert.equal(last().code, 'unmapped')
  assert.equal(await director.play('Idle', -1, { force: true }), false)
  port.results.push(false)
  assert.equal(await director.play('Idle', 0, { force: true }), false)
  assert.equal(last().code, 'refused', 'the library still refuses the clip that is playing')
})

test('ignoring gates (debug) keeps unmapped, reduced and busy', async () => {
  const { director, port, last, setReduced } = rig({ minGapMs: 60_000, maxPerTurn: 1, acts: { laugh: gesture(0, { chance: 0, cooldownMs: 60_000 }) } })
  director.setOverrides({ ignoreGates: true })
  assert.equal(await director.offerAct('laugh'), true)
  assert.equal(await director.offerAct('laugh'), true)
  port.isBusy = true
  assert.equal(await director.offerAct('laugh'), false)
  assert.equal(last().code, 'busy')
  setReduced(true)
  assert.equal(await director.offerAct('laugh'), false)
  assert.equal(last().code, 'reduced')
  assert.equal(director.inspect().ignoreGates, true)
})

test('the decision log keeps the last 16 entries', async () => {
  const { director } = rig({ minGapMs: 0, maxPerTurn: 2 })
  for (let index = 0; index < 20; index++) await director.offerAct('laugh')
  assert.equal(director.inspect().decisions.length, 16)
})

test('pickIdleIndex follows the weights and never returns a weight-0, failed or active index', () => {
  const counts = [0, 0, 0]
  for (let draw = 0; draw < 400; draw++) {
    const index = pickIdleIndex({ weights: [3, 1, 0], count: 3, random: () => draw / 400 })
    counts[index]++
  }
  assert.deepEqual(counts, [300, 100, 0])
  for (const draw of [0, 0.5, 0.999999]) {
    const random = () => draw
    assert.equal(pickIdleIndex({ weights: [3, 1, 0], count: 3, random, failed: index => index === 0 }), 1)
    assert.equal(pickIdleIndex({ weights: [3, 1, 0], count: 3, random, active: index => index === 1 }), 0)
    assert.equal(pickIdleIndex({ weights: [3, 1, 2], count: 2, random }) !== 2, true, 'only indices of the group')
  }
  assert.equal(pickIdleIndex({ weights: [0, 0, 0], count: 3, random: () => 0 }), null)
  assert.equal(pickIdleIndex({ weights: [3, 1], count: 3, random: () => 0.99, failed: index => index < 2 }), null, 'a missing weight is 0')
  assert.equal(pickIdleIndex({ weights: [1], count: 0, random: () => 0 }), null)
})

test('Idle is weighted only while thinking or speaking, and a weight-0 Idle is calmed as she gets busy', () => {
  const { director, port, last } = rig({ minGapMs: 0, maxPerTurn: 2, idle: { group: 'Idle', busyWeights: [3, 1, 0], calmOnBusy: true } })
  assert.equal(director.idleIndex('Idle', 3), null, 'idle: the library picks')
  port.playing = { group: 'Idle', index: 2, priority: MOTION_PRIORITY.IDLE }
  director.setActivity('thinking')
  assert.deepEqual(port.calls, [['stop']])
  assert.equal(last().code, 'calm')
  director.setActivity('speaking')
  assert.equal(port.calls.length, 1, 'only on the change into a busy activity')
  assert.equal(director.idleIndex('Idle', 3), 0)
  assert.equal(director.idleIndex('Tap', 1), null)
  port.playing = { group: 'Idle', index: 0, priority: MOTION_PRIORITY.IDLE }
  assert.equal(director.idleIndex('Idle', 3), 1, 'never the active index')
  director.setActivity('idle')
  director.setActivity('speaking')
  assert.equal(port.calls.length, 1, 'a weighted Idle keeps playing')
  port.playing = { group: 'Idle', index: 2, priority: MOTION_PRIORITY.IDLE }
  port.isBusy = true
  director.setActivity('idle')
  director.setActivity('thinking')
  assert.equal(port.calls.length, 1, 'never with a gesture reserved')
  const calm = rig({ minGapMs: 0, maxPerTurn: 2, idle: { group: 'Idle', busyWeights: [3, 1, 0], calmOnBusy: false } })
  calm.port.playing = { group: 'Idle', index: 2, priority: MOTION_PRIORITY.IDLE }
  calm.director.setActivity('speaking')
  assert.deepEqual(calm.port.calls, [])
})

test('an index the model does not have is never requested (the library would stay reserved)', async () => {
  const { director, port, last } = rig({ minGapMs: 0, maxPerTurn: 5, emotions: { happy: { motions: [{ group: 'Gesture', index: 7 }] } } })
  assert.equal(await director.play('Gesture', 3, { force: true }), false)
  assert.equal(last().code, 'unmapped')
  assert.equal(await director.play('Missing', undefined, { force: true }), false, 'a group with no motions')
  assert.equal(await director.offerTone('happy'), false)
  assert.equal(last().code, 'unmapped')
  assert.deepEqual(port.calls, [])
  assert.equal(await director.play('Gesture', 2, { force: true }), true, 'the last real index still plays')
})
