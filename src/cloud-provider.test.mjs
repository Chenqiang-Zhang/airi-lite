import assert from 'node:assert/strict'
import test from 'node:test'
import { CLOUD_PROVIDER_CONSENT_KEY, LEGACY_CLOUD_PROVIDER_CONSENT_KEY, loadCloudProviderConsent, readCloudSpeechService,
  resolveConsentedSpeechMode, saveCloudProviderConsent } from './cloud-provider.ts'

test('only known provider/model pairs enable cloud; labels are fixed rather than server markup', () => {
  for (const [provider, model, label, region, scope] of [
    ['minimax', 'speech-2.8-hd', 'MiniMax · 国内', 'cn', 'minimax:cn'],
    ['minimax', 'speech-2.8-turbo', 'MiniMax · 国内', 'cn', 'minimax:cn'],
    ['minimax', 'speech-2.8-hd', 'MiniMax · 国际', 'global', 'minimax:global'],
    ['elevenlabs', 'eleven_v4', 'ElevenLabs', null, 'elevenlabs'],
  ]) {
    assert.deepEqual(readCloudSpeechService({ configured: true, provider, model, region, label: 'untrusted' }),
      { configured: true, provider, model, label, region, scope })
    assert.equal(readCloudSpeechService({ configured: false, provider, model }).configured, false)
    assert.equal(readCloudSpeechService({ configured: 'true', provider, model }).configured, false)
  }
})

test('unknown, missing, mismatched and unsupported Turbo health fails closed without coercion', () => {
  for (const value of [null, undefined, [], 'minimax', {}, { configured: true },
    { configured: true, provider: 'elevenlabs', model: 'eleven_v4_turbo' },
    { configured: true, provider: 'elevenlabs', model: 'speech-2.8-hd' },
    { configured: true, provider: 'minimax', model: 'eleven_v4' },
    { configured: true, provider: 'unknown', model: 'eleven_v4' },
    { configured: true, provider: 'minimax', model: { toString() { throw new Error('no coercion') } } }]) {
    assert.deepEqual(readCloudSpeechService(value),
      { configured: false, provider: 'unavailable', label: '云端语音', model: '', region: null, scope: null })
  }
})

test('consent is explicit and scoped to one provider; legacy cloud does not silently switch vendors', () => {
  const values = new Map()
  const writes = []
  const storage = { getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); writes.push([key, value]) } }
  const mini = readCloudSpeechService({ configured: true, provider: 'minimax', model: 'speech-2.8-hd' })
  const eleven = readCloudSpeechService({ configured: true, provider: 'elevenlabs', model: 'eleven_v4' })
  assert.equal(loadCloudProviderConsent(storage), null)
  assert.equal(resolveConsentedSpeechMode('cloud', {}, mini, null).engine, 'browser')
  assert.equal(writes.length, 0)
  saveCloudProviderConsent('minimax:cn', storage)
  assert.equal(resolveConsentedSpeechMode('cloud', {}, mini, loadCloudProviderConsent(storage)).engine, 'cloud')
  assert.equal(resolveConsentedSpeechMode('cloud', {}, eleven, loadCloudProviderConsent(storage)).engine, 'browser')
  assert.match(resolveConsentedSpeechMode('cloud', {}, eleven, 'minimax:cn').notice, /重新选择/)
  saveCloudProviderConsent('elevenlabs', storage)
  assert.equal(resolveConsentedSpeechMode('cloud', {}, eleven, loadCloudProviderConsent(storage)).engine, 'cloud')
  assert.equal(resolveConsentedSpeechMode('cloud', {}, mini, loadCloudProviderConsent(storage)).engine, 'browser')
  for (const service of [mini, eleven]) {
    assert.equal(resolveConsentedSpeechMode('auto', {}, service, 'elevenlabs').engine, 'local')
    assert.equal(resolveConsentedSpeechMode('auto', { hasWebGPU: false }, service, 'elevenlabs').engine, 'browser')
    assert.equal(resolveConsentedSpeechMode('cloud', {}, { ...service, configured: false }, 'elevenlabs').engine, 'browser')
  }
  saveCloudProviderConsent(null, storage)
  assert.equal(loadCloudProviderConsent(storage), null)
  assert.ok(writes.every(([key]) => key === CLOUD_PROVIDER_CONSENT_KEY))
})

test('malformed or unavailable consent storage is fail-closed; explicit write errors remain visible', () => {
  for (const value of ['', 'minimax', 'cloud', 'ElevenLabs', 'unknown', 'eleven_v4', null, true])
    assert.equal(loadCloudProviderConsent({ getItem: () => value }), null)
  assert.equal(loadCloudProviderConsent(null), null)
  const denied = new Error('storage denied')
  const storage = { getItem() { throw denied }, setItem() { throw denied } }
  assert.equal(loadCloudProviderConsent(storage), null)
  assert.throws(() => saveCloudProviderConsent('elevenlabs', storage), error => error === denied)
  assert.throws(() => saveCloudProviderConsent('cloud', storage), TypeError)
  assert.throws(() => saveCloudProviderConsent('minimax', storage), TypeError)
  assert.throws(() => saveCloudProviderConsent('elevenlabs', null))
})

test('global requires its own explicit consent; a region change never silently reuses the cn grant', () => {
  const global = readCloudSpeechService({ configured: true, provider: 'minimax', model: 'speech-2.8-hd', region: 'global' })
  const cn = readCloudSpeechService({ configured: true, provider: 'minimax', model: 'speech-2.8-hd', region: 'cn' })
  assert.equal(resolveConsentedSpeechMode('cloud', {}, global, 'minimax:cn').engine, 'browser')
  assert.equal(resolveConsentedSpeechMode('cloud', {}, cn, 'minimax:global').engine, 'browser')
  assert.match(resolveConsentedSpeechMode('cloud', {}, global, 'minimax:cn').notice, /地区.*重新选择/)
  assert.equal(resolveConsentedSpeechMode('cloud', {}, global, 'minimax:global').engine, 'cloud')
  assert.equal(resolveConsentedSpeechMode('auto', {}, global, 'minimax:global').engine, 'local')
  assert.equal(resolveConsentedSpeechMode('cloud', {}, { ...global, configured: false }, 'minimax:global').engine, 'browser')
})

test('legacy MiniMax consent and missing health region mean only cn; v2 clear never resurrects it', () => {
  const values = new Map([[LEGACY_CLOUD_PROVIDER_CONSENT_KEY, 'minimax']])
  const writes = []
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); writes.push([key, value]) },
  }
  assert.equal(loadCloudProviderConsent(storage), 'minimax:cn')
  assert.equal(readCloudSpeechService({ configured: true, provider: 'minimax', model: 'speech-2.8-hd' }).scope, 'minimax:cn')
  assert.equal(writes.length, 0, 'reading a migration cannot grant consent')
  saveCloudProviderConsent('minimax:global', storage)
  assert.equal(loadCloudProviderConsent(storage), 'minimax:global')
  saveCloudProviderConsent(null, storage)
  assert.equal(loadCloudProviderConsent(storage), null)
  values.set(CLOUD_PROVIDER_CONSENT_KEY, 'bad')
  assert.equal(loadCloudProviderConsent(storage), null)
  assert.equal(values.get(LEGACY_CLOUD_PROVIDER_CONSENT_KEY), 'minimax')
  assert.ok(writes.every(([key]) => key === CLOUD_PROVIDER_CONSENT_KEY))
})

test('unexpected MiniMax regions fail closed instead of inventing a cn/global disclosure', () => {
  for (const region of [null, '', 'intl', 'international', 'GLOBAL', ' global ', 'https://evil.invalid', 123, {}, []]) {
    const status = readCloudSpeechService({ configured: true, provider: 'minimax', model: 'speech-2.8-hd', region })
    assert.equal(status.configured, false)
    assert.equal(status.scope, null)
  }
})
