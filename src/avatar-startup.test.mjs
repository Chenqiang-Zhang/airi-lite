import assert from 'node:assert/strict'
import test from 'node:test'
import { createAvatarModuleLoader } from './avatar-startup.ts'

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const avatarModule = { mountHiyori() { throw new Error('loader must not create a renderer') } }

test('avatar import only starts after Core readiness and does not mount by itself', async () => {
  const core = deferred(), events = []
  const load = createAvatarModuleLoader({
    loadCore: () => { events.push('core'); return core.promise },
    importAvatar: async () => { events.push('import'); return avatarModule },
  })
  const pending = load()
  assert.deepEqual(events, ['core'])
  core.resolve()
  assert.equal(await pending, avatarModule)
  assert.deepEqual(events, ['core', 'import'])
})

test('Core failure never evaluates the avatar module', async () => {
  const original = new Error('Core unavailable')
  let imports = 0
  const load = createAvatarModuleLoader({
    loadCore: async () => { throw original },
    importAvatar: async () => { imports++; return avatarModule },
  })
  await assert.rejects(load(), error => error === original)
  assert.equal(imports, 0)
})

test('pre-aborted view starts neither Core nor import', async () => {
  const controller = new AbortController()
  controller.abort()
  let starts = 0
  const load = createAvatarModuleLoader({
    loadCore: async () => { starts++ },
    importAvatar: async () => { starts++; return avatarModule },
  })
  await assert.rejects(load({ signal: controller.signal }), { name: 'AbortError' })
  assert.equal(starts, 0)
})

test('abort during Core waiting exits now and never imports after a late rejection', async () => {
  const core = deferred(), controller = new AbortController()
  let imports = 0
  const load = createAvatarModuleLoader({
    loadCore: () => core.promise,
    importAvatar: async () => { imports++; return avatarModule },
  })
  const pending = load({ signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  core.reject(new Error('late CDN failure'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(imports, 0)
})

for (const outcome of ['resolve', 'reject']) {
  test(`abort during non-abortable import safely observes late ${outcome}`, async () => {
    const imported = deferred(), started = deferred(), controller = new AbortController()
    const load = createAvatarModuleLoader({
      loadCore: async () => {},
      importAvatar: () => { started.resolve(); return imported.promise },
    })
    const pending = load({ signal: controller.signal })
    await started.promise
    controller.abort()
    await assert.rejects(pending, { name: 'AbortError' })
    if (outcome === 'resolve') imported.resolve(avatarModule)
    else imported.reject(new Error('late chunk failure'))
    await new Promise(resolve => setImmediate(resolve))
  })
}

test('same-turn import resolution and abort cannot deliver a module to the unmounted view', async () => {
  const imported = deferred(), started = deferred(), controller = new AbortController()
  const load = createAvatarModuleLoader({
    loadCore: async () => {},
    importAvatar: () => { started.resolve(); return imported.promise },
  })
  const pending = load({ signal: controller.signal })
  await started.promise
  imported.resolve(avatarModule)
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
})

test('uncanceled chunk failure preserves the original diagnostic', async () => {
  const original = new Error('chunk unavailable')
  const load = createAvatarModuleLoader({
    loadCore: async () => {},
    importAvatar: () => { throw original },
  })
  await assert.rejects(load(), error => error === original)
})
