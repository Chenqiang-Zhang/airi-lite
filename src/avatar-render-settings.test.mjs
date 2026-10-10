import assert from 'node:assert/strict'
import test from 'node:test'
import { AVATAR_RENDER_STORAGE_KEY, isAvatarRenderProfile, loadAvatarRenderProfile, saveAvatarRenderProfile } from './avatar-render-settings.ts'

const storage = (value = null) => {
  const values = new Map([[AVATAR_RENDER_STORAGE_KEY, value], ['airi-lite:speech-mode:v1', 'cloud']])
  const writes = []
  return { values, writes, getItem(key) { return values.get(key) ?? null }, setItem(key, value) { writes.push([key, value]); values.set(key, value) } }
}

test('render preference defaults to auto and only explicit saves touch its own key', () => {
  const local = storage()
  assert.equal(loadAvatarRenderProfile(local), 'auto')
  assert.equal(local.writes.length, 0)
  for (const profile of ['economy', 'auto']) {
    assert.equal(saveAvatarRenderProfile(profile, local), profile)
    assert.equal(loadAvatarRenderProfile(local), profile)
  }
  assert.deepEqual(local.writes, [[AVATAR_RENDER_STORAGE_KEY, 'economy'], [AVATAR_RENDER_STORAGE_KEY, 'auto']])
  assert.equal(local.values.get('airi-lite:speech-mode:v1'), 'cloud', 'render saving never changes voice/provider settings')
})

test('unknown render profiles cannot restore or overwrite a valid choice', () => {
  for (const value of ['', 'Auto', ' economy', 'static', 'cloud', 30, true, {}, [], null, undefined]) {
    assert.equal(isAvatarRenderProfile(value), false)
    assert.equal(loadAvatarRenderProfile(storage(value)), 'auto')
    const local = storage('economy')
    assert.throws(() => saveAvatarRenderProfile(value, local), TypeError)
    assert.equal(local.writes.length, 0)
    assert.equal(loadAvatarRenderProfile(local), 'economy')
  }
})

test('absent or denied storage loads safely but cannot claim a successful save', () => {
  assert.equal(loadAvatarRenderProfile(null), 'auto')
  assert.throws(() => saveAvatarRenderProfile('economy', null), /不能保存/)
  const denied = new Error('storage denied')
  const broken = { getItem() { throw denied }, setItem() { throw denied } }
  assert.equal(loadAvatarRenderProfile(broken), 'auto')
  assert.throws(() => saveAvatarRenderProfile('auto', broken), error => error === denied)
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'window')
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { get localStorage() { throw denied } } })
    assert.equal(loadAvatarRenderProfile(), 'auto')
    assert.throws(() => saveAvatarRenderProfile('economy'), error => error === denied)
    Object.defineProperty(globalThis, 'window', { configurable: true, value: undefined })
    assert.equal(loadAvatarRenderProfile(), 'auto')
    assert.throws(() => saveAvatarRenderProfile('economy'), /不能保存/)
  }
  finally {
    if (prior) Object.defineProperty(globalThis, 'window', prior)
    else delete globalThis.window
  }
})
