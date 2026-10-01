import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_SPEECH_MODE,
  SPEECH_MODE_STORAGE_KEY,
  isSpeechMode,
  loadSpeechMode,
  readDeviceHints,
  resolveSpeechMode,
  saveSpeechMode,
} from './speech-mode.ts'

function storage(entries = []) {
  const values = new Map(entries)
  const reads = []
  const writes = []
  return {
    values,
    reads,
    writes,
    getItem(key) { reads.push(key); return values.get(key) ?? null },
    setItem(key, value) { writes.push([key, value]); values.set(key, value) },
  }
}

function withGlobal(key, descriptor, run) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, key)
  Object.defineProperty(globalThis, key, { configurable: true, ...descriptor })
  try { return run() }
  finally {
    if (previous) Object.defineProperty(globalThis, key, previous)
    else delete globalThis[key]
  }
}

test('auto is the default, and only explicit saves persist the new mode key', () => {
  const local = storage([['airi-lite:voice:v1', 'zf_002']])
  assert.equal(DEFAULT_SPEECH_MODE, 'auto')
  assert.equal(SPEECH_MODE_STORAGE_KEY, 'airi-lite:speech-mode:v1')
  assert.equal(loadSpeechMode(local), 'auto')
  assert.equal(local.writes.length, 0)
  for (const mode of ['auto', 'local', 'browser', 'cloud']) {
    assert.equal(saveSpeechMode(mode, local), mode)
    assert.equal(loadSpeechMode(local), mode)
  }
  assert.equal(local.values.get('airi-lite:voice:v1'), 'zf_002')
  assert.ok(local.reads.every(key => key === SPEECH_MODE_STORAGE_KEY))
  assert.ok(local.writes.every(([key]) => key === SPEECH_MODE_STORAGE_KEY))
})

test('invalid modes neither restore nor overwrite a stored user choice', () => {
  for (const value of ['', 'Auto', ' local', 'zf_001', '../model', '{}', null, 0, true, {}, ['cloud']]) {
    const local = storage([[SPEECH_MODE_STORAGE_KEY, value]])
    assert.equal(isSpeechMode(value), false)
    assert.equal(loadSpeechMode(local), 'auto')
    assert.throws(() => saveSpeechMode(value, local), /未知语音模式/)
    assert.equal(local.writes.length, 0)
  }
  const local = storage([[SPEECH_MODE_STORAGE_KEY, 'local']])
  assert.throws(() => saveSpeechMode('invalid', local), TypeError)
  assert.equal(loadSpeechMode(local), 'local')
})

test('read failures fall back to auto, while write failures remain visible to the caller', () => {
  const denied = new Error('storage denied')
  const unavailable = {
    getItem() { throw denied },
    setItem() { throw denied },
  }
  assert.equal(loadSpeechMode(unavailable), 'auto')
  assert.throws(() => saveSpeechMode('cloud', unavailable), error => error === denied)
  withGlobal('window', { value: { get localStorage() { throw denied } } }, () => {
    assert.equal(loadSpeechMode(), 'auto')
    assert.throws(() => saveSpeechMode('cloud'), error => error === denied)
  })
})

test('absent window/storage is safe to load and cannot pretend to save', () => {
  withGlobal('window', { value: undefined }, () => {
    assert.equal(loadSpeechMode(), 'auto')
    assert.throws(() => saveSpeechMode('browser'), /不能保存/)
  })
  assert.equal(loadSpeechMode(null), 'auto')
  assert.throws(() => saveSpeechMode('local', null), /不能保存/)
})

test('the default browser storage is read only until the user saves', () => {
  const local = storage([[SPEECH_MODE_STORAGE_KEY, 'cloud']])
  withGlobal('window', { value: { localStorage: local } }, () => {
    assert.equal(loadSpeechMode(), 'cloud')
    assert.equal(local.writes.length, 0)
    assert.equal(saveSpeechMode('browser'), 'browser')
    assert.deepEqual(local.writes, [[SPEECH_MODE_STORAGE_KEY, 'browser']])
  })
})

test('device hints use only valid positive numbers and real boolean saveData', () => {
  assert.deepEqual(readDeviceHints({
    deviceMemory: 8,
    hardwareConcurrency: 6,
    connection: { saveData: false },
    gpu: {},
  }), { memoryGB: 8, cores: 6, saveData: false, hasWebGPU: true })
  assert.deepEqual(readDeviceHints({ connection: { saveData: true }, gpu: null }), {
    saveData: true,
    hasWebGPU: false,
  })
  for (const invalid of [0, -1, NaN, Infinity, -Infinity, '4', true, false, null, {}, []]) {
    assert.deepEqual(readDeviceHints({ deviceMemory: invalid, hardwareConcurrency: invalid, gpu: {} }), {
      hasWebGPU: true,
    })
  }
  for (const invalid of [0, 1, 'true', 'false', null, {}, []]) {
    assert.deepEqual(readDeviceHints({ connection: { saveData: invalid }, gpu: {} }), { hasWebGPU: true })
  }
  assert.deepEqual(readDeviceHints({ gpu: 'yes' }), {})
})

test('absent or unreadable navigator is unknown, not a low-performance device', () => {
  for (const absent of [null, 0, '', false]) assert.deepEqual(readDeviceHints(absent), {})
  withGlobal('navigator', { value: undefined }, () => assert.deepEqual(readDeviceHints(), {}))
  withGlobal('navigator', { get() { throw new Error('restricted') } }, () => assert.deepEqual(readDeviceHints(), {}))
  assert.deepEqual(readDeviceHints({}), { hasWebGPU: false })
})

test('each throwing device getter leaves other hints usable', () => {
  const broken = {
    get deviceMemory() { throw new Error('memory denied') },
    hardwareConcurrency: 8,
    get connection() { throw new Error('connection denied') },
    get gpu() { throw new Error('gpu denied') },
  }
  assert.deepEqual(readDeviceHints(broken), { cores: 8 })
  assert.deepEqual(readDeviceHints({
    deviceMemory: 8,
    get hardwareConcurrency() { throw new Error('cores denied') },
    connection: { get saveData() { throw new Error('saveData denied') } },
    gpu: {},
  }), { memoryGB: 8, hasWebGPU: true })
  withGlobal('navigator', { value: { deviceMemory: 4, hardwareConcurrency: 2 } }, () => {
    assert.deepEqual(readDeviceHints(), { memoryGB: 4, cores: 2, hasWebGPU: false })
  })
})

test('explicit local/browser choices take priority over all device hints and cloud availability', () => {
  const weak = { memoryGB: 2, cores: 1, saveData: true, hasWebGPU: false }
  const capable = { memoryGB: 16, cores: 12, saveData: false, hasWebGPU: true }
  for (const hints of [weak, capable, {}]) {
    for (const cloudAvailable of [false, true]) {
      assert.equal(resolveSpeechMode('local', hints, cloudAvailable).engine, 'local')
      assert.equal(resolveSpeechMode('browser', hints, cloudAvailable).engine, 'browser')
    }
  }
  assert.match(resolveSpeechMode('local', weak).notice, /固定声线/)
  assert.match(resolveSpeechMode('browser', capable).notice, /音色因设备而异/)
  assert.match(resolveSpeechMode('browser', capable).notice, /情绪自然度无法保证/)
})

test('cloud requires an explicit choice and an enabled service; unavailable cloud stays lightweight', () => {
  const enabled = resolveSpeechMode('cloud', {}, true)
  assert.equal(enabled.engine, 'cloud')
  assert.match(enabled.notice, /文字会发送到已配置的云服务/)
  for (const availability of [false, undefined, null, 'true', 1]) {
    const disabled = resolveSpeechMode('cloud', {}, availability)
    assert.equal(disabled.engine, 'browser')
    assert.match(disabled.notice, /云端语音服务尚未启用/)
    assert.match(disabled.notice, /不会调用云端接口或下载本地大模型/)
  }
})

test('auto never chooses cloud, even if a cloud service is available', () => {
  for (const hints of [{}, { saveData: true }, { memoryGB: 4 }, { cores: 2 }, { hasWebGPU: false }, {
    memoryGB: 16, cores: 12, saveData: false, hasWebGPU: true,
  }]) {
    assert.notEqual(resolveSpeechMode('auto', hints, true).engine, 'cloud')
  }
})

test('each lightweight trigger includes a comprehensible reason, not a benchmark claim', () => {
  for (const [hints, reason] of [
    [{ saveData: true }, /节省流量/],
    [{ memoryGB: 4 }, /内存不超过 4 GB/],
    [{ memoryGB: 0.5 }, /内存不超过 4 GB/],
    [{ cores: 2 }, /核心数不超过 2/],
    [{ cores: 1 }, /核心数不超过 2/],
    [{ hasWebGPU: false }, /未提供 WebGPU/],
  ]) {
    const resolved = resolveSpeechMode('auto', hints)
    assert.equal(resolved.engine, 'browser')
    assert.match(resolved.notice, reason)
    assert.match(resolved.notice, /启发式选择，不是真实测速/)
  }
  const combined = resolveSpeechMode('auto', { saveData: true, memoryGB: 2, cores: 1, hasWebGPU: false })
  assert.match(combined.notice, /节省流量/)
  assert.match(combined.notice, /内存不超过/)
  assert.match(combined.notice, /核心数不超过/)
  assert.match(combined.notice, /WebGPU/)
})

test('unknown, invalid and non-triggering hints retain local without inventing weak-device evidence', () => {
  for (const hints of [{}, { memoryGB: 8 }, { cores: 4 }, { saveData: false }, { hasWebGPU: true }, {
    memoryGB: NaN, cores: Infinity,
  }, { memoryGB: -1, cores: 0 }]) {
    const resolved = resolveSpeechMode('auto', hints, true)
    assert.equal(resolved.engine, 'local')
    assert.doesNotMatch(resolved.notice, /低性能|性能较低|弱设备|内存不超过|核心数不超过/)
    assert.match(resolved.notice, /实际速度取决于设备/)
    assert.match(resolved.notice, /启发式选择，不是真实测速/)
  }
})

test('detection and resolution do not mutate inputs or write inferred decisions to storage', () => {
  const local = storage()
  const device = Object.freeze({ deviceMemory: 2, hardwareConcurrency: 2, gpu: {} })
  const hints = Object.freeze(readDeviceHints(device))
  withGlobal('window', { value: { localStorage: local } }, () => {
    assert.equal(resolveSpeechMode(loadSpeechMode(), hints, true).engine, 'browser')
    assert.equal(local.writes.length, 0)
    assert.deepEqual(local.reads, [SPEECH_MODE_STORAGE_KEY])
  })
  assert.deepEqual(hints, { memoryGB: 2, cores: 2, hasWebGPU: true })
})
