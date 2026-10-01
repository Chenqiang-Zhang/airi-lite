import assert from 'node:assert/strict'
import test from 'node:test'
import { createAvatarMountScope, loadAvatarResource, releaseAvatarModel, releaseAvatarRendererTextures } from './avatar-mount.ts'

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('already aborted mount never starts model loading', async () => {
  const controller = new AbortController()
  controller.abort()
  const scope = createAvatarMountScope(controller.signal)
  let loads = 0, releases = 0
  await assert.rejects(loadAvatarResource(scope, () => { loads++; return {} }, async () => {}, () => releases++), { name: 'AbortError' })
  assert.equal(scope.disposed, true)
  assert.equal(loads, 0)
  scope.own(() => releases++)
  scope.dispose()
  assert.equal(releases, 1)
})

test('abort releases the canvas now and the late model exactly once', async () => {
  const controller = new AbortController()
  const scope = createAvatarMountScope(controller.signal)
  const pending = deferred()
  const events = []
  scope.own(() => events.push('canvas'))
  const mounted = loadAvatarResource(scope, () => ({ name: 'late model' }), () => pending.promise, model => events.push(model.name))
  controller.abort()
  assert.deepEqual(events, ['canvas'], 'does not wait for the loader to settle')
  pending.resolve({ name: 'late model' })
  await assert.rejects(mounted, { name: 'AbortError' })
  scope.dispose()
  assert.deepEqual(events, ['canvas', 'late model'])
})

test('normal destroy releases resources in reverse order and detaches abort listener', async () => {
  const listeners = new Set()
  const signal = { aborted: false, addEventListener(_event, listener) { listeners.add(listener) }, removeEventListener(_event, listener) { listeners.delete(listener) } }
  const scope = createAvatarMountScope(signal)
  const events = []
  scope.own(() => events.push('app'))
  const model = await loadAvatarResource(scope, () => ({ name: 'model' }), async () => {}, value => events.push(value.name))
  assert.equal(model.name, 'model')
  scope.own(() => events.push('observer'))
  scope.own(() => events.push('actor'))
  scope.own(() => events.push('render loop'))
  scope.dispose()
  scope.dispose()
  assert.deepEqual(events, ['render loop', 'actor', 'observer', 'model', 'app'])
  assert.equal(listeners.size, 0)
})

test('load rejection preserves the original error and existing resources release', async () => {
  const scope = createAvatarMountScope()
  const original = new Error('model unavailable')
  let canvasReleases = 0
  let modelReleases = 0
  scope.own(() => canvasReleases++)
  await assert.rejects(loadAvatarResource(scope, () => ({}), async () => { throw original }, () => modelReleases++), error => error === original)
  assert.equal(canvasReleases, 1)
  assert.equal(modelReleases, 1, 'the partially initialized object is still owned')
})

test('cleanup errors cannot strand later resources or mask loading failure', () => {
  const errors = [], events = []
  const broken = new Error('observer cleanup')
  const scope = createAvatarMountScope(undefined, error => errors.push(error))
  scope.own(() => events.push('canvas'))
  scope.own(() => { events.push('observer'); throw broken })
  scope.own(() => events.push('actor'))
  scope.dispose()
  assert.deepEqual(events, ['actor', 'observer', 'canvas'])
  assert.deepEqual(errors, [broken])
})

test('abort between model settlement and the await continuation never exposes the model', async () => {
  const controller = new AbortController()
  const scope = createAvatarMountScope(controller.signal)
  const pending = deferred()
  let releases = 0
  const mounted = loadAvatarResource(scope, () => ({}), () => pending.promise, () => releases++)
  pending.resolve({})
  controller.abort()
  await assert.rejects(mounted, { name: 'AbortError' })
  assert.equal(releases, 1)
})

test('adoption and dispose are reentrant-safe even if cleanup enrolls another resource', () => {
  const events = []
  const scope = createAvatarMountScope(undefined, () => { throw new Error('diagnostic failure') })
  scope.own(() => events.push('app'))
  scope.own(() => { scope.dispose(); scope.own(() => events.push('late')); throw new Error('cleanup failure') })
  scope.dispose()
  assert.deepEqual(events, ['late', 'app'])
})

test('canceled initialization is not destroyed mid-load, including a later rejection', async () => {
  const controller = new AbortController()
  const scope = createAvatarMountScope(controller.signal)
  const pending = deferred()
  let releases = 0
  const original = new Error('texture unavailable')
  const mounted = loadAvatarResource(scope, () => ({}), () => pending.promise, () => releases++)
  controller.abort()
  assert.equal(releases, 0)
  pending.reject(original)
  await assert.rejects(mounted, error => error === original)
  scope.dispose()
  assert.equal(releases, 1)
})

test('early JSON/moc failure destroys the container without dereferencing a missing core', () => {
  const events = []
  const model = { autoUpdate: true, emit(event) { events.push(event) }, unregisterInteraction() { events.push('interaction') }, destroy() { assert.fail('unsafe dependency destroy') } }
  releaseAvatarModel(model, () => events.push('container'))
  assert.equal(model.autoUpdate, false)
  assert.deepEqual(events, ['destroy', 'interaction', 'container'])
})

test('initialized or texture-failed model releases its core without destroying shared textures', () => {
  const sharedTexture = { valid: true }
  let releases = 0
  const a = { internalModel: {}, autoUpdate: false, emit() {}, unregisterInteraction() {}, destroy(options) {
    releases++
    if (options?.texture || options?.baseTexture) sharedTexture.valid = false
  } }
  const b = { texture: sharedTexture }
  releaseAvatarModel(a, () => assert.fail('must release its initialized core'))
  assert.equal(releases, 1)
  assert.equal(b.texture.valid, true, 'late old cleanup cannot invalidate the new model URL cache')
})

test('renderer texture cleanup removes only its context and handles a mutating managed list', () => {
  const images = [0, 1, 2].map(() => ({ contexts: new Set(['old', 'new']), cpuValid: true }))
  const system = { managedTextures: [...images], destroyTexture(texture) {
    texture.contexts.delete('old')
    this.managedTextures.splice(this.managedTextures.indexOf(texture), 1)
  } }
  releaseAvatarRendererTextures(system)
  assert.equal(system.managedTextures.length, 0)
  for (const image of images) { assert.equal(image.cpuValid, true); assert.deepEqual([...image.contexts], ['new']) }
})

test('one GPU cleanup error does not skip the remaining context textures', () => {
  const events = []
  assert.throws(() => releaseAvatarRendererTextures({ managedTextures: [1, 2, 3], destroyTexture(texture) {
    events.push(texture)
    if (texture === 2) throw new Error('lost GL context')
  } }), { name: 'AggregateError' })
  assert.deepEqual(events, [1, 2, 3])
})
