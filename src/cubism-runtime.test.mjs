import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CUBISM_RUNTIME_TIMEOUT_MS, CUBISM_RUNTIME_URL,
  createCubismRuntimeLoader, isCubismRuntimeReady, loadCubismRuntime, waitForAvatarWork,
} from './cubism-runtime.ts'

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function validCore() {
  const neverCall = () => assert.fail('shape checks must not execute native Core methods')
  return {
    Version: { csmGetVersion: neverCall },
    Logging: { csmGetLogFunction: neverCall, csmSetLogFunction: neverCall },
    Moc: { fromArrayBuffer: neverCall },
    Model: { fromMoc: neverCall },
    Utils: Object.fromEntries([
      'hasBlendAdditiveBit', 'hasBlendMultiplicativeBit', 'hasIsDoubleSidedBit',
      'hasIsInvertedMaskBit', 'hasIsVisibleBit', 'hasOpacityDidChangeBit',
      'hasRenderOrderDidChangeBit', 'hasVertexPositionsDidChangeBit',
      'hasVisibilityDidChangeBit',
    ].map(name => [name, neverCall])),
  }
}

function trackedSignal(controller = new AbortController()) {
  const listeners = new Set()
  return {
    controller, listeners,
    signal: {
      get aborted() { return controller.signal.aborted },
      addEventListener(event, callback, options) {
        listeners.add(callback)
        controller.signal.addEventListener(event, callback, options)
      },
      removeEventListener(event, callback) {
        listeners.delete(callback)
        controller.signal.removeEventListener(event, callback)
      },
    },
  }
}

function harness(initialCore) {
  let core = initialCore, nextTimer = 0
  const scripts = [], appended = [], timers = new Map(), cleared = []
  const dependencies = {
    createScript() {
      const listeners = new Map([['load', new Set()], ['error', new Set()]])
      const script = {
        src: '', async: false, listeners, removals: 0,
        addEventListener(event, callback) { listeners.get(event).add(callback) },
        removeEventListener(event, callback) { listeners.get(event).delete(callback) },
        remove() { this.removals++ },
        emit(event) { for (const callback of [...listeners.get(event)]) callback() },
      }
      scripts.push(script)
      return script
    },
    appendScript(script) {
      assert.equal(script.listeners.get('load').size, 1, 'listeners installed before append')
      assert.equal(script.listeners.get('error').size, 1)
      appended.push(script)
    },
    readCore: () => core,
    scheduleTimeout(callback, milliseconds) {
      const id = ++nextTimer
      timers.set(id, { callback, milliseconds })
      return () => { cleared.push(id); timers.delete(id) }
    },
  }
  return {
    dependencies, scripts, appended, timers, cleared,
    load: createCubismRuntimeLoader(dependencies),
    setCore(value) { core = value },
    timeout() {
      const [id, timer] = timers.entries().next().value
      timers.delete(id)
      timer.callback()
    },
  }
}

function assertScriptClean(script) {
  assert.equal(script.listeners.get('load').size, 0)
  assert.equal(script.listeners.get('error').size, 0)
}

test('Node import and pre-aborted default call do not need browser globals', async () => {
  assert.equal(typeof loadCubismRuntime, 'function')
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(loadCubismRuntime({ signal: controller.signal }), { name: 'AbortError' })
})

test('Core readiness checks the actual required methods without calling them', () => {
  assert.equal(isCubismRuntimeReady(validCore()), true)
  for (const bad of [undefined, null, true, 'loaded', {}, { Moc: {} }]) {
    assert.equal(isCubismRuntimeReady(bad), false)
  }
  const missing = validCore()
  delete missing.Utils.hasOpacityDidChangeBit
  assert.equal(isCubismRuntimeReady(missing), false)
  const broken = validCore()
  broken.Logging.csmSetLogFunction = 1
  assert.equal(isCubismRuntimeReady(broken), false)
  const hostile = { get Version() { throw new Error('getter failed') } }
  assert.equal(isCubismRuntimeReady(hostile), false)
})

test('already-aborted waits never call their work or create a runtime script', async () => {
  const { signal, controller, listeners } = trackedSignal()
  controller.abort()
  let starts = 0
  await assert.rejects(waitForAvatarWork(async () => { starts++ }, signal), { name: 'AbortError' })
  const h = harness()
  await assert.rejects(h.load({ signal }), { name: 'AbortError' })
  assert.equal(starts, 0)
  assert.equal(h.scripts.length, 0)
  assert.equal(h.timers.size, 0)
  assert.equal(listeners.size, 0)
})

test('an existing usable Core skips scripts and deadlines', async () => {
  const h = harness(validCore())
  const { signal, listeners } = trackedSignal()
  await h.load({ signal })
  assert.equal(h.scripts.length, 0)
  assert.equal(h.timers.size, 0)
  assert.equal(listeners.size, 0)
})

test('runtime uses only the fixed official URL and 15-second deadline', async () => {
  const h = harness()
  const loading = h.load({ url: 'https://not-allowed.example/runtime.js' })
  assert.equal(h.scripts.length, 1)
  assert.equal(h.appended.length, 1)
  assert.equal(h.scripts[0].src, CUBISM_RUNTIME_URL)
  assert.equal(h.scripts[0].async, true)
  assert.equal([...h.timers.values()][0].milliseconds, 15_000)
  assert.equal(CUBISM_RUNTIME_TIMEOUT_MS, 15_000)
  h.setCore(validCore())
  h.scripts[0].emit('load')
  await loading
  assertScriptClean(h.scripts[0])
  assert.equal(h.timers.size, 0)
  assert.equal(h.scripts[0].removals, 0, 'retain the successful script, not its listeners')
  await h.load()
  assert.equal(h.scripts.length, 1)
})

test('two consumers share one script and one abort cannot cancel the other', async () => {
  const h = harness()
  const a = trackedSignal(), b = trackedSignal()
  const first = h.load({ signal: a.signal })
  const second = h.load({ signal: b.signal })
  const firstRejected = assert.rejects(first, { name: 'AbortError' })
  a.controller.abort()
  await firstRejected
  assert.equal(h.scripts.length, 1)
  assert.equal(h.scripts[0].removals, 0)
  assert.equal(h.scripts[0].listeners.get('load').size, 1)
  assert.equal(h.timers.size, 1)
  assert.equal(a.listeners.size, 0)
  assert.equal(b.listeners.size, 1)
  h.setCore(validCore())
  h.scripts[0].emit('load')
  await second
  assert.equal(b.listeners.size, 0)
  assert.equal(h.timers.size, 0)
  assertScriptClean(h.scripts[0])
})

test('all consumers can leave without abandoning the bounded shared request', async () => {
  const h = harness()
  const a = trackedSignal(), b = trackedSignal()
  const first = h.load({ signal: a.signal }), second = h.load({ signal: b.signal })
  const failures = Promise.all([
    assert.rejects(first, { name: 'AbortError' }), assert.rejects(second, { name: 'AbortError' }),
  ])
  a.controller.abort()
  b.controller.abort()
  await failures
  const third = h.load()
  assert.equal(h.scripts.length, 1)
  h.setCore(validCore())
  h.scripts[0].emit('load')
  await third
  assert.equal(h.timers.size, 0)
  assertScriptClean(h.scripts[0])
})

test('script errors detach both listeners, clear the timer and permit retry', async () => {
  const h = harness()
  const tracked = trackedSignal()
  const first = h.load({ signal: tracked.signal })
  h.scripts[0].emit('error')
  await assert.rejects(first, { name: 'CubismRuntimeError', code: 'CUBISM_LOAD_FAILED' })
  assert.equal(tracked.listeners.size, 0)
  assert.equal(h.scripts[0].removals, 1)
  assertScriptClean(h.scripts[0])
  assert.equal(h.timers.size, 0)
  const second = h.load()
  assert.equal(h.scripts.length, 2)
  h.setCore(validCore())
  h.scripts[1].emit('load')
  await second
})

test('script load with absent or incomplete Core fails closed and retries', async () => {
  for (const bad of [undefined, {}, { Moc: { fromArrayBuffer() {} } }]) {
    const h = harness(bad)
    const loading = h.load()
    h.scripts[0].emit('load')
    await assert.rejects(loading, { code: 'CUBISM_INVALID_CORE' })
    assertScriptClean(h.scripts[0])
    assert.equal(h.scripts[0].removals, 1)
    assert.equal(h.timers.size, 0)
    const retry = h.load()
    h.setCore(validCore())
    h.scripts[1].emit('load')
    await retry
  }
})

test('deadline rejects every active consumer and permits a fresh attempt', async () => {
  const h = harness()
  const a = trackedSignal(), b = trackedSignal()
  const first = h.load({ signal: a.signal }), second = h.load({ signal: b.signal })
  h.timeout()
  await Promise.all([
    assert.rejects(first, { code: 'CUBISM_LOAD_TIMEOUT' }),
    assert.rejects(second, { code: 'CUBISM_LOAD_TIMEOUT' }),
  ])
  assert.equal(a.listeners.size, 0)
  assert.equal(b.listeners.size, 0)
  assertScriptClean(h.scripts[0])
  assert.equal(h.scripts[0].removals, 1)
  assert.equal(h.timers.size, 0)
  const retry = h.load()
  h.setCore(validCore())
  h.scripts[1].emit('load')
  await retry
})

test('stale callbacks cannot settle or clear the newer retry', async () => {
  const h = harness()
  const first = h.load()
  const oldLoad = [...h.scripts[0].listeners.get('load')][0]
  const oldError = [...h.scripts[0].listeners.get('error')][0]
  const oldDeadline = [...h.timers.values()][0].callback
  h.timeout()
  await assert.rejects(first, { code: 'CUBISM_LOAD_TIMEOUT' })
  const retry = h.load()
  let completed = false
  void retry.then(() => { completed = true })
  h.setCore(validCore())
  oldLoad()
  oldError()
  oldDeadline()
  await Promise.resolve()
  assert.equal(completed, false)
  assert.equal(h.timers.size, 1)
  assert.equal(h.scripts[1].listeners.get('load').size, 1)
  h.scripts[1].emit('load')
  await retry
  assert.equal(h.timers.size, 0)
})

test('a usable late Core after timeout is adopted without adding another script', async () => {
  const h = harness()
  const first = h.load()
  h.timeout()
  await assert.rejects(first, { code: 'CUBISM_LOAD_TIMEOUT' })
  h.setCore(validCore())
  await h.load()
  assert.equal(h.scripts.length, 1)
  assert.equal(h.timers.size, 0)
})

test('synchronous append failures clean up and can be retried', async () => {
  const h = harness()
  const append = h.dependencies.appendScript
  h.dependencies.appendScript = () => { throw new Error('DOM failed') }
  await assert.rejects(h.load(), { code: 'CUBISM_LOAD_FAILED' })
  assertScriptClean(h.scripts[0])
  assert.equal(h.scripts[0].removals, 1)
  assert.equal(h.timers.size, 0)
  h.dependencies.appendScript = append
  const retry = h.load()
  h.setCore(validCore())
  h.scripts[1].emit('load')
  await retry
})

test('a synchronous controlled deadline does not append or retain a timer', async () => {
  const h = harness()
  let disposed = 0
  h.dependencies.scheduleTimeout = callback => { callback(); return () => { disposed++ } }
  await assert.rejects(h.load(), { code: 'CUBISM_LOAD_TIMEOUT' })
  assert.equal(h.appended.length, 0)
  assert.equal(disposed, 1)
  assertScriptClean(h.scripts[0])
  assert.equal(h.scripts[0].removals, 1)
})

test('aborting in the settlement microtask never exposes work or runtime success', async () => {
  const work = deferred(), tracked = trackedSignal()
  const waiting = waitForAvatarWork(() => work.promise, tracked.signal)
  work.resolve('late module')
  tracked.controller.abort()
  await assert.rejects(waiting, { name: 'AbortError' })
  assert.equal(tracked.listeners.size, 0)

  const h = harness(), consumer = trackedSignal()
  const loading = h.load({ signal: consumer.signal })
  h.setCore(validCore())
  h.scripts[0].emit('load')
  consumer.controller.abort()
  await assert.rejects(loading, { name: 'AbortError' })
  assert.equal(consumer.listeners.size, 0)
  assertScriptClean(h.scripts[0])
  assert.equal(h.timers.size, 0)
  await h.load()
  assert.equal(h.scripts.length, 1)
})

test('normal work fulfillment and rejection both remove the consumer listener', async () => {
  const a = trackedSignal()
  assert.equal(await waitForAvatarWork(async () => 'module', a.signal), 'module')
  assert.equal(a.listeners.size, 0)
  const b = trackedSignal(), original = new Error('import failed')
  await assert.rejects(waitForAvatarWork(async () => { throw original }, b.signal), error => error === original)
  assert.equal(b.listeners.size, 0)
  const c = trackedSignal()
  await assert.rejects(waitForAvatarWork(() => { throw original }, c.signal), error => error === original)
  assert.equal(c.listeners.size, 0)
})

test('undefined rejection and undefined fulfillment remain distinct results', async () => {
  let rejected = false
  await waitForAvatarWork(() => Promise.reject(undefined)).then(
    () => assert.fail('must not turn an undefined rejection into success'),
    reason => { rejected = true; assert.equal(reason, undefined) },
  )
  assert.equal(rejected, true)
  assert.equal(await waitForAvatarWork(() => Promise.resolve(undefined)), undefined)
})

test('a synchronous undefined throw remains a rejection and releases its listener', async () => {
  const tracked = trackedSignal()
  let rejected = false
  await waitForAvatarWork(() => { throw undefined }, tracked.signal).then(
    () => assert.fail('must not turn an undefined throw into success'),
    reason => { rejected = true; assert.equal(reason, undefined) },
  )
  assert.equal(rejected, true)
  assert.equal(tracked.listeners.size, 0)
})

test('abort during start still observes the promise returned by that work', async () => {
  const tracked = trackedSignal(), original = new Error('late import failure')
  const waiting = waitForAvatarWork(() => {
    tracked.controller.abort()
    return Promise.reject(original)
  }, tracked.signal)
  await assert.rejects(waiting, { name: 'AbortError' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(tracked.listeners.size, 0)
})

test('canceled work safely observes a much later rejection', async () => {
  const tracked = trackedSignal(), work = deferred()
  const waiting = waitForAvatarWork(() => work.promise, tracked.signal)
  tracked.controller.abort()
  await assert.rejects(waiting, { name: 'AbortError' })
  work.reject(new Error('late module failure'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(tracked.listeners.size, 0)
})

test('an abandoned runtime error or timeout is observed and still resets retry state', async () => {
  for (const outcome of ['error', 'timeout']) {
    const h = harness(), tracked = trackedSignal()
    const waiting = h.load({ signal: tracked.signal })
    tracked.controller.abort()
    await assert.rejects(waiting, { name: 'AbortError' })
    if (outcome === 'error') h.scripts[0].emit('error')
    else h.timeout()
    await new Promise(resolve => setImmediate(resolve))
    assertScriptClean(h.scripts[0])
    assert.equal(h.timers.size, 0)
    const retry = h.load()
    assert.equal(h.scripts.length, 2)
    h.setCore(validCore())
    h.scripts[1].emit('load')
    await retry
  }
})
