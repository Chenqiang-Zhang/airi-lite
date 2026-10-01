import assert from 'node:assert/strict'
import test from 'node:test'
import { attachAvatarRenderLoop, resolveAvatarRenderBudget } from './avatar-rendering.ts'

function fixture({ hidden = false, interactionEnabled = true, budget, priority = 0 } = {}) {
  const events = []
  const callbacks = []
  const visibilityListeners = new Set()
  const frames = []
  const visibility = {
    hidden,
    addEventListener(type, listener) {
      assert.equal(type, 'visibilitychange')
      visibilityListeners.add(listener)
    },
    removeEventListener(type, listener) {
      assert.equal(type, 'visibilitychange')
      visibilityListeners.delete(listener)
    },
  }
  let started = true
  let interactionValue = interactionEnabled
  let maxFPS = 0
  let minFPS = 10
  const interaction = {
    get useSystemTicker() { return interactionValue },
    set useSystemTicker(value) { interactionValue = value; events.push(['interaction', value]) },
  }
  const app = {
    ticker: {
      deltaMS: 16,
      // PIXI6's setters are interdependent. In particular, minFPS=10 while
      // maxFPS is the unlimited sentinel 0 would set the actual minimum to 0.
      get minFPS() { return minFPS },
      set minFPS(value) { minFPS = Math.min(maxFPS, value) },
      get maxFPS() { return maxFPS },
      set maxFPS(value) { maxFPS = value === 0 ? 0 : Math.max(minFPS, value) },
      add(callback, context, priority) {
        callbacks.push({ callback, context, priority })
        events.push(['add', priority])
      },
      remove(callback, context) {
        const index = callbacks.findIndex(entry => entry.callback === callback && entry.context === context)
        assert.notEqual(index, -1)
        callbacks.splice(index, 1)
        events.push(['remove'])
      },
    },
    start() { started = true; events.push(['start']) },
    stop() { started = false; events.push(['stop']) },
    renderer: { plugins: { interaction } },
  }
  const model = {
    update(delta) { frames.push(delta); events.push(['model', delta]) },
  }
  // Same priority contract as PIXI6: Application renders at LOW (-25).
  callbacks.push({ callback: () => events.push(['render']), context: app, priority: -25 })
  const loop = attachAvatarRenderLoop(app, model, { visibility, updatePriority: priority, budget })
  const tick = (delta = 16) => {
    app.ticker.deltaMS = delta
    if (started)
      for (const { callback, context } of [...callbacks].sort((a, b) => b.priority - a.priority))
        callback.call(context)
  }
  const changeVisibility = hidden => {
    visibility.hidden = hidden
    for (const listener of [...visibilityListeners]) listener()
  }
  return { app, model, loop, events, callbacks, visibility, visibilityListeners, frames, tick, changeVisibility,
    started: () => started, interactionEnabled: () => interactionValue }
}

test('render budgets reduce only explicit weak-device or saving hints', () => {
  assert.deepEqual(resolveAvatarRenderBudget({}, 3), { maxFPS: 60, resolution: 2, antialias: true })
  assert.deepEqual(resolveAvatarRenderBudget({ hasWebGPU: false }, 2), {
    maxFPS: 60, resolution: 2, antialias: true,
  })
  for (const hints of [{ memoryGB: 4 }, { memoryGB: 0.5 }, { cores: 2 }, { saveData: true }]) {
    assert.deepEqual(resolveAvatarRenderBudget(hints, 3), { maxFPS: 30, resolution: 1.25, antialias: false })
    assert.equal(resolveAvatarRenderBudget(hints, 1).resolution, 1)
  }
  assert.equal(resolveAvatarRenderBudget({ memoryGB: 8, cores: 8, saveData: false }, 1.5).resolution, 1.5)
  assert.equal(resolveAvatarRenderBudget({}, 0.75).resolution, 0.75)
})

test('invalid hints and DPR never manufacture weak hardware or a broken resolution', () => {
  for (const value of [0, -1, NaN, Infinity, -Infinity, '2', true, false, null, {}, []]) {
    assert.deepEqual(resolveAvatarRenderBudget({ memoryGB: value, cores: value, saveData: false }, value), {
      maxFPS: 60, resolution: 1, antialias: true,
    })
  }
  for (const saveData of [0, 1, 'true', 'false', null, {}, []])
    assert.equal(resolveAvatarRenderBudget({ saveData }).maxFPS, 60)
  for (const hints of [null, undefined, 0, 'slow', false])
    assert.deepEqual(resolveAvatarRenderBudget(hints), { maxFPS: 60, resolution: 1, antialias: true })
  assert.deepEqual(resolveAvatarRenderBudget({
    get memoryGB() { throw new Error('denied') },
    cores: 2,
    get saveData() { throw new Error('denied') },
  }, 2), { maxFPS: 30, resolution: 1.25, antialias: false })
})

test('own ticker updates the model before rendering and enforces a bounded delta', () => {
  const f = fixture({ budget: resolveAvatarRenderBudget({ memoryGB: 4 }, 2), priority: 25 })
  assert.equal(f.app.ticker.minFPS, 10)
  assert.equal(f.app.ticker.maxFPS, 30)
  assert.equal(f.callbacks.find(entry => entry.priority === 25).context, f.app)
  f.events.length = 0
  f.tick(33.3)
  assert.deepEqual(f.events, [['model', 33.3], ['render']])
  f.tick(9000)
  assert.deepEqual(f.frames, [33.3, 100])
  f.loop.destroy()
})

test('invalid or nonpositive ticker delta cannot reach the model', () => {
  const f = fixture()
  const update = f.callbacks.find(entry => entry.priority === 0).callback
  for (const delta of [0, -16, NaN, Infinity, -Infinity, '16', undefined, null]) {
    f.app.ticker.deltaMS = delta
    update()
  }
  assert.deepEqual(f.frames, [])
  f.tick(16)
  assert.deepEqual(f.frames, [16])
  f.loop.destroy()
})

test('initially hidden app never starts; repeated visibility changes are idempotent', () => {
  const f = fixture({ hidden: true })
  assert.equal(f.started(), false)
  assert.equal(f.interactionEnabled(), false)
  assert.equal(f.events.filter(([name]) => name === 'start').length, 0)
  f.tick()
  assert.deepEqual(f.frames, [])
  const hiddenEvents = f.events.length
  f.changeVisibility(true)
  assert.equal(f.events.length, hiddenEvents)
  f.changeVisibility(false)
  assert.equal(f.started(), true)
  assert.equal(f.interactionEnabled(), true)
  const visibleEvents = f.events.length
  f.changeVisibility(false)
  assert.equal(f.events.length, visibleEvents)
  f.tick(16)
  assert.deepEqual(f.frames, [16])
  f.loop.destroy()
})

test('pause and resume stop only own scheduling and never replay a hidden gap', () => {
  const f = fixture()
  const retainedCallback = f.callbacks.find(entry => entry.priority === 0).callback
  f.tick(16)
  f.changeVisibility(true)
  f.tick(10000)
  retainedCallback()
  assert.deepEqual(f.frames, [16])
  f.changeVisibility(false)
  f.tick(20)
  assert.deepEqual(f.frames, [16, 20])
  assert.equal(f.app.ticker.maxFPS, 60)
  f.loop.destroy()
})

test('manual interaction policy stays disabled after resume and destroy', () => {
  const f = fixture({ interactionEnabled: false })
  f.changeVisibility(true)
  f.changeVisibility(false)
  assert.equal(f.interactionEnabled(), false)
  assert.ok(!f.events.some(([name, value]) => name === 'interaction' && value === true))
  f.loop.destroy()
  assert.equal(f.interactionEnabled(), false)
})

test('destroy removes only own subscriptions, restores original policy, and cannot revive', () => {
  const f = fixture()
  const retainedCallback = f.callbacks.find(entry => entry.priority === 0).callback
  const retainedVisibility = [...f.visibilityListeners][0]
  f.changeVisibility(true)
  f.loop.destroy()
  assert.equal(f.started(), false)
  assert.equal(f.interactionEnabled(), true)
  assert.equal(f.visibilityListeners.size, 0)
  assert.equal(f.callbacks.length, 1, 'the pre-existing render subscription belongs to the app owner')
  assert.equal(f.callbacks[0].priority, -25)
  const afterDestroy = f.events.length
  f.loop.destroy()
  f.visibility.hidden = false
  retainedVisibility()
  retainedCallback()
  f.tick()
  assert.equal(f.events.length, afterDestroy)
  assert.deepEqual(f.frames, [])
})

test('missing interaction plugin is allowed and unsafe priority defaults before render', () => {
  const events = []
  const callbacks = []
  const app = {
    ticker: {
      deltaMS: 16, minFPS: 0, maxFPS: 0,
      add(callback, context, priority) { callbacks.push({ callback, priority }); events.push(['add', priority]) },
      remove(callback) { callbacks.splice(callbacks.findIndex(entry => entry.callback === callback), 1) },
    },
    start() {}, stop() {},
  }
  const visibility = { hidden: false, addEventListener() {}, removeEventListener() {} }
  for (const updatePriority of [-50, NaN, Infinity, '25']) {
    const loop = attachAvatarRenderLoop(app, { update() {} }, { visibility, updatePriority })
    assert.equal(callbacks[0].priority, 0)
    loop.destroy()
    assert.equal(callbacks.length, 0)
  }
})
