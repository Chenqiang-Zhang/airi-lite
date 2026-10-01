import assert from 'node:assert/strict'
import test from 'node:test'
import { SpeechApiError } from './cloud-speech.ts'
import { createSpeechController } from './speech.ts'

class AudioStub extends EventTarget {
  paused = true
  currentTime = 0
  src = ''
  ended = false
  error = null
  get currentSrc() { return this.src }
  load() { this.currentTime = 0; this.ended = false; this.error = null }
  removeAttribute(name) { if (name === 'src') this.src = '' }
  pause() {
    if (this.paused) return
    this.paused = true
    this.dispatchEvent(new Event('pause'))
  }
  async play() {
    this.paused = false
    this.ended = false
    this.dispatchEvent(new Event('playing'))
  }
  end() {
    this.paused = true
    this.ended = true
    this.dispatchEvent(new Event('ended'))
  }
}

const settle = () => new Promise(resolve => setImmediate(resolve))
const clip = () => ({ audio: {
  data: Float32Array.from({ length: 2400 }, (_, i) => Math.sin(i * 0.08) * 0.2),
  sampling_rate: 24000,
} })
const cloudClip = () => ({ samples: clip().audio.data, sampleRate: 24000, words: [] })
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((accept, refuse) => { resolve = accept; reject = refuse })
  return { promise, resolve, reject }
}

function fixture(loadModel, dependencies = {}) {
  const previous = Object.fromEntries(['window', 'SpeechSynthesisUtterance', 'requestAnimationFrame', 'cancelAnimationFrame'].map(key => [key, globalThis[key]]))
  const utterances = []
  globalThis.window = { speechSynthesis: { speak: utterance => utterances.push(utterance), cancel() {} } }
  globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text } }
  let nextFrame = 0
  const frames = new Map()
  globalThis.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame }
  globalThis.cancelAnimationFrame = id => frames.delete(id)
  const audio = new AudioStub()
  const events = { delivery: [], problem: [], playing: [], preparing: [], mouth: [], ready: [], state: [] }
  const controller = createSpeechController(audio, {
    onState: value => events.state.push(value),
    onAudioReady: value => events.ready.push(value),
    onDelivery: value => events.delivery.push(value),
    onProblem: value => events.problem.push(value),
    onPlaying: value => events.playing.push(value),
    onPreparing: value => events.preparing.push(value),
    onMouth: (open, form) => events.mouth.push([open, form]),
  }, { loadModel, ...dependencies })
  return {
    audio, events, controller, utterances,
    tick(time) {
      audio.currentTime = time
      const callbacks = [...frames.values()]
      frames.clear()
      for (const callback of callbacks) callback()
    },
    close() {
      controller.dispose()
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete globalThis[key]
        else globalThis[key] = value
      }
    },
  }
}

test('sentence rates and expressions follow actual chunks, full replay and seeking', async () => {
  const calls = []
  const f = fixture(async () => ({ async *stream(text, options) {
    calls.push({ text, speed: options.speed })
    yield clip()
  } }))
  try {
    const input = f.controller.beginStream('', 'bright')
    input.push('好耶！')
    input.setDelivery('soft')
    input.push('先歇一下。')
    input.setDelivery('curious')
    input.push('明天呢？')
    input.finish()
    await settle()
    assert.deepEqual(calls.map(call => call.speed), [1.04, 0.93, 0.99])
    assert.deepEqual(f.events.delivery, ['bright']) // Later chunks were synthesized, not played.
    f.audio.end()
    assert.deepEqual(f.events.delivery, ['bright', 'soft'])
    f.audio.end()
    assert.deepEqual(f.events.delivery, ['bright', 'soft', 'curious'])
    f.audio.end()
    const wav = await (await fetch(f.audio.src)).arrayBuffer()
    assert.equal(wav.byteLength, 44 + 2400 * 3 * 2)
    await f.audio.play()
    f.tick(0.15)
    f.tick(0.25)
    f.tick(0.01)
    assert.deepEqual(f.events.delivery.slice(-4), ['bright', 'soft', 'curious', 'bright'])
  }
  finally { f.close() }
})

test('canceling a waiting stream cannot enqueue old speech into the next turn', async () => {
  const calls = []
  const f = fixture(async () => ({ async *stream(text) { calls.push(text); yield clip() } }))
  try {
    const old = f.controller.beginStream('', 'bright')
    old.push('还没有句号')
    await settle()
    f.controller.cancel()
    old.cancel() // Controller-level cancellation already invalidated this token.
    old.push('旧内容。')
    const fresh = f.controller.beginStream('', 'soft')
    fresh.push('新回复。')
    fresh.finish()
    await settle()
    assert.deepEqual(calls, ['新回复。'])
    assert.deepEqual(f.events.delivery, ['soft'])
    assert.equal(f.utterances.length, 0)
  }
  finally { f.close() }
})

test('late canceled browser-voice events cannot stop or change the new voice', async () => {
  const f = fixture(async () => { throw new Error('test: model unavailable') })
  try {
    const oldSpeaking = f.controller.speak('旧回复。', 'bright')
    await settle()
    const old = f.utterances[0]
    assert.ok(old)
    f.controller.cancel() // The stub deliberately sends no browser cancel event.
    await oldSpeaking
    const newSpeaking = f.controller.speak('新回复。', 'soft')
    await settle()
    const fresh = f.utterances[1]
    fresh.onstart()
    const before = structuredClone(f.events)
    old.onstart()
    old.onend()
    old.onerror()
    assert.deepEqual(f.events, before)
    fresh.onend()
    await newSpeaking
    assert.equal(f.events.playing.at(-1), false)
    assert.deepEqual(f.events.delivery, ['soft'])
  }
  finally { f.close() }
})

test('a failure after valid audio preserves the clip without fallback duplication', async () => {
  let call = 0
  const f = fixture(async () => ({ async *stream() {
    if (++call === 2) throw new Error('test: second sentence failed')
    yield clip()
  } }))
  try {
    const input = f.controller.beginStream('', 'bright')
    input.push('第一句。第二句。')
    input.finish()
    await settle()
    assert.equal(f.utterances.length, 0)
    assert.match(f.events.problem.at(-1), /后续语音生成中断/)
    f.audio.end()
    const wav = await (await fetch(f.audio.src)).arrayBuffer()
    assert.equal(wav.byteLength, 44 + 2400 * 2)
  }
  finally { f.close() }
})

test('stale media events cannot reopen silence, advance or cancel the new source', async () => {
  const f = fixture(async () => ({ async *stream() { yield clip() } }))
  try {
    const first = f.controller.beginStream('', 'bright')
    first.push('旧回复。')
    first.finish()
    await settle()
    f.controller.cancel()
    const idleEvents = structuredClone(f.events)
    for (const event of ['playing', 'pause', 'ended', 'error']) f.audio.dispatchEvent(new Event(event))
    assert.deepEqual(f.events, idleEvents)
    const fresh = f.controller.beginStream('', 'soft')
    fresh.push('新回复。')
    fresh.finish()
    await settle()
    const source = f.audio.src
    const activeEvents = structuredClone(f.events)
    for (const event of ['pause', 'ended', 'error']) f.audio.dispatchEvent(new Event(event))
    assert.equal(f.audio.src, source)
    assert.deepEqual(f.events, activeEvents)
    assert.equal(f.events.playing.at(-1), true)
  }
  finally { f.close() }
})

test('nonspoken replies never load a model, call cloud or use browser speech in any engine', async () => {
  let loads = 0
  let cloudCalls = 0
  const f = fixture(async () => { loads++; throw new Error('should not load') }, {
    async synthesizeCloud() { cloudCalls++; throw new Error('should not call cloud') },
  })
  try {
    for (const engine of ['local', 'browser', 'cloud']) {
      for (const text of ['```python\n[x * 2 for x in [1,2,3]]\n```', '😊✨！！！', '😊'.repeat(89) + '1️⃣', '![日和](https://example.invalid/image.png)']) {
        const input = f.controller.beginStream('', 'bright', undefined, engine)
        for (const char of text) input.push(char)
        input.setDelivery('soft')
        input.finish()
        await settle()
        await f.controller.speak(text, 'bright', undefined, [], engine)
        assert.equal(loads, 0)
        assert.equal(cloudCalls, 0)
        assert.equal(f.audio.src, '')
        assert.equal(f.utterances.length, 0)
        assert.equal(f.events.preparing.at(-1), false)
        assert.equal(f.events.ready.at(-1), false)
        assert.match(f.events.problem.at(-1), /没有可朗读/)
        assert.deepEqual(f.events.state, [])
      }
    }
  }
  finally { f.close() }
})

test('a canceled code block cannot leak its pending text into a new voice turn', async () => {
  const calls = []
  const f = fixture(async () => ({ async *stream(text) { calls.push(text); yield clip() } }))
  try {
    const old = f.controller.beginStream('', 'bright')
    old.push('```python\nprint("旧正文。")')
    await settle()
    f.controller.cancel()
    old.finish()
    const fresh = f.controller.beginStream('', 'soft')
    fresh.push('新正文。')
    fresh.finish()
    await settle()
    assert.deepEqual(calls, ['新正文。'])
    assert.equal(f.events.playing.at(-1), true)
    assert.equal(f.utterances.length, 0)
  }
  finally { f.close() }
})

test('fallback keeps the first sentence but skips code and link destinations', async () => {
  const f = fixture(async () => { throw new Error('test: no local model') })
  try {
    const speaking = f.controller.speak('**第一句。**\n```python\nprint("秘密。")\n```\n[第二句。](https://example.invalid/path)', 'soft')
    await settle()
    assert.equal(f.utterances[0].text, '第一句。')
    f.utterances[0].onstart()
    f.utterances[0].onend()
    await settle()
    assert.equal(f.utterances[1].text, '第二句。')
    f.utterances[1].onend()
    await speaking
    assert.equal(f.utterances.length, 2)
    assert.deepEqual(f.events.state, ['loading', 'fallback', 'fallback'])
  }
  finally { f.close() }
})

test('actual silence for a readable sentence is still a synthesis failure', async () => {
  const f = fixture(async () => ({ async *stream() {
    yield { audio: { data: new Float32Array(2400), sampling_rate: 24000 } }
  } }))
  try {
    const speaking = f.controller.speak('这句需要出声。')
    await settle()
    assert.equal(f.utterances[0].text, '这句需要出声。')
    assert.match(f.events.problem.at(-1), /本地声线不可用/)
    f.utterances[0].onend()
    await speaking
  }
  finally { f.close() }
})

test('direct browser stream and replay never load Kokoro or call cloud synthesis', async () => {
  let loads = 0
  let cloudCalls = 0
  const f = fixture(async () => { loads++; throw new Error('browser must not load Kokoro') }, {
    async synthesizeCloud() { cloudCalls++; throw new Error('browser must not call cloud') },
  })
  try {
    const speaking = f.controller.speak('Hello Hiyori!', 'soft', undefined, [], 'browser')
    await settle()
    assert.equal(f.utterances[0].text, 'Hello Hiyori!')
    assert.equal(f.utterances[0].rate, 0.93)
    assert.deepEqual(f.events.delivery, [])
    f.utterances[0].onstart()
    assert.deepEqual(f.events.delivery, ['soft'])
    f.utterances[0].onend()
    await speaking

    const input = f.controller.beginStream('', 'bright', undefined, 'browser')
    input.push('轻量回复。')
    input.finish()
    await settle()
    assert.equal(f.utterances[1].text, '轻量回复。')
    assert.deepEqual(f.events.delivery, ['soft'])
    f.utterances[1].onstart()
    f.utterances[1].onend()
    await settle()
    assert.deepEqual(f.events.delivery, ['soft', 'bright'])
    assert.deepEqual(f.events.state, ['browser', 'browser'])
    assert.equal(loads, 0)
    assert.equal(cloudCalls, 0)
    assert.equal(f.audio.src, '')
    assert.equal(f.events.preparing.at(-1), false)
    assert.equal(f.events.ready.at(-1), false)
  }
  finally { f.close() }
})

test('cloud stream/replay preserve English, omit Markdown secrets and apply cues only on playback', async () => {
  const first = '**Hello Hiyori!**\n'
  const middle = '```js\nconsole.log("secret.");\n```\n[Rest with DeepSeek.](https://example.invalid/a_(b))\n'
  const last = '明天用 API Key?'
  const text = first + middle + last
  const cues = [
    { start: 0, delivery: 'bright' },
    { start: first.length, delivery: 'soft' },
    { start: first.length + middle.length, delivery: 'curious' },
  ]
  for (const playback of ['stream', 'replay']) {
    let loads = 0
    const calls = []
    const f = fixture(async () => { loads++; throw new Error('cloud must not load Kokoro') }, {
      async synthesizeCloud(sentence, signal) {
        calls.push({ ...sentence, signal })
        return cloudClip()
      },
    })
    try {
      if (playback === 'stream') {
        const input = f.controller.beginStream('', 'bright', undefined, 'cloud')
        input.push(first)
        input.setDelivery('soft')
        input.push(middle)
        input.setDelivery('curious')
        input.push(last)
        input.finish()
      }
      else {
        await f.controller.speak(text, 'bright', undefined, cues, 'cloud')
      }
      await settle()
      assert.deepEqual(calls.map(({ text, delivery }) => ({ text, delivery })), [
        { text: 'Hello Hiyori!', delivery: 'bright' },
        { text: 'Rest with DeepSeek.', delivery: 'soft' },
        { text: '明天用 API Key?', delivery: 'curious' },
      ])
      assert.ok(calls.every(call => call.signal instanceof AbortSignal && !call.signal.aborted))
      assert.equal(new Set(calls.map(call => call.signal)).size, 1)
      assert.equal(loads, 0)
      assert.equal(f.utterances.length, 0)
      assert.deepEqual(f.events.delivery, ['bright'])
      f.audio.end()
      assert.deepEqual(f.events.delivery, ['bright', 'soft'])
      f.audio.end()
      assert.deepEqual(f.events.delivery, ['bright', 'soft', 'curious'])
      f.audio.end()
      const wav = await (await fetch(f.audio.src)).arrayBuffer()
      assert.equal(wav.byteLength, 44 + 2400 * 3 * 2)
      await f.audio.play()
      f.tick(0.15)
      f.tick(0.25)
      f.tick(0.01)
      assert.deepEqual(f.events.delivery.slice(-4), ['bright', 'soft', 'curious', 'bright'])
      assert.ok(f.events.state.every(state => state === 'cloud'))
    }
    finally { f.close() }
  }
})

test('late canceled cloud promises cannot change a newer run or clear its abort controller', async () => {
  for (const completion of ['resolve', 'reject']) {
    const requests = []
    const f = fixture(async () => { throw new Error('cloud must not load Kokoro') }, {
      synthesizeCloud(sentence, signal) {
        const pending = deferred()
        requests.push({ ...pending, sentence, signal })
        return pending.promise
      },
    })
    try {
      const oldSpeaking = f.controller.speak('旧云端回复。', 'bright', undefined, [], 'cloud')
      await settle()
      assert.equal(requests.length, 1)
      assert.equal(requests[0].signal.aborted, false)
      const newSpeaking = f.controller.speak('新云端回复。', 'soft', undefined, [], 'cloud')
      await settle()
      assert.equal(requests.length, 2)
      assert.equal(requests[0].signal.aborted, true)
      assert.equal(requests[1].signal.aborted, false)
      const before = structuredClone(f.events)
      if (completion === 'resolve') requests[0].resolve(cloudClip())
      else requests[0].reject(new Error('late private provider failure'))
      await oldSpeaking
      await settle()
      assert.deepEqual(f.events, before)
      assert.equal(f.audio.src, '')
      assert.equal(f.utterances.length, 0)

      f.controller.cancel()
      assert.equal(requests[1].signal.aborted, true, 'old finally must retain the new abort controller')
      const canceled = structuredClone(f.events)
      requests[1].reject(new DOMException('canceled', 'AbortError'))
      await newSpeaking
      assert.deepEqual(f.events, canceled)
    }
    finally { f.close() }
  }
})

test('late local prepare success/failure cannot relabel or replace a newer cloud run', async () => {
  for (const completion of ['resolve', 'reject']) {
    const loading = deferred()
    let loads = 0
    let localCalls = 0
    let cloudCalls = 0
    const f = fixture(() => { loads++; return loading.promise }, {
      async synthesizeCloud() { cloudCalls++; return cloudClip() },
    })
    try {
      const oldSpeaking = f.controller.speak('旧本地回复。', 'bright')
      await settle()
      assert.deepEqual(f.events.state, ['loading'])
      await f.controller.speak('新云端回复。', 'soft', undefined, [], 'cloud')
      assert.equal(f.events.state.at(-1), 'cloud')
      assert.deepEqual(f.events.delivery, ['soft'])
      const source = f.audio.src
      const before = structuredClone(f.events)
      if (completion === 'resolve') {
        loading.resolve({ async *stream() { localCalls++; yield clip() } })
      }
      else loading.reject(new Error('late local preparation failure'))
      await oldSpeaking
      await settle()
      assert.deepEqual(f.events, before)
      assert.equal(f.audio.src, source)
      assert.equal(f.events.playing.at(-1), true)
      assert.equal(loads, 1)
      assert.equal(localCalls, 0)
      assert.equal(cloudCalls, 1)
      assert.equal(f.utterances.length, 0)
    }
    finally { f.close() }
  }
})

test('public prepare captures its run and cannot relabel newer cloud or browser speech', async () => {
  for (const engine of ['cloud', 'browser']) {
    for (const completion of ['resolve', 'reject']) {
      const loading = deferred()
      let loads = 0
      let localCalls = 0
      let cloudCalls = 0
      const f = fixture(() => { loads++; return loading.promise }, {
        async synthesizeCloud() { cloudCalls++; return cloudClip() },
      })
      try {
        const prepared = f.controller.prepare().then(() => true, () => false)
        assert.deepEqual(f.events.state, ['loading'])
        const speaking = f.controller.speak('新模式回复。', 'soft', undefined, [], engine)
        await settle()
        if (engine === 'browser') f.utterances[0].onstart()
        assert.equal(f.events.state.at(-1), engine)
        assert.deepEqual(f.events.delivery, ['soft'])
        const source = f.audio.src
        const before = structuredClone(f.events)
        if (completion === 'resolve') {
          loading.resolve({ async *stream() { localCalls++; yield clip() } })
        }
        else loading.reject(new Error('late public preparation failure'))
        assert.equal(await prepared, completion === 'resolve')
        await settle()
        assert.deepEqual(f.events, before)
        assert.equal(f.audio.src, source)
        assert.equal(f.events.playing.at(-1), true)
        assert.equal(loads, 1)
        assert.equal(localCalls, 0)
        assert.equal(cloudCalls, engine === 'cloud' ? 1 : 0)
        assert.equal(f.utterances.length, engine === 'browser' ? 1 : 0)
        if (engine === 'browser') f.utterances[0].onend()
        await speaking
      }
      finally { f.close() }
    }
  }
})

test('cloud failure before audio uses browser fallback without Kokoro or paid-request retries', async () => {
  for (const playback of ['stream', 'replay']) {
    let loads = 0
    let cloudCalls = 0
    const f = fixture(async () => { loads++; throw new Error('fallback must not load Kokoro') }, {
      async synthesizeCloud() { cloudCalls++; throw new SpeechApiError('rate_limited', 429) },
    })
    try {
      const text = '**第一句。**\n```js\nsecret();\n```\n[第二句。](https://example.invalid/private)'
      let speaking
      if (playback === 'replay') {
        speaking = f.controller.speak(text, 'soft', undefined, [], 'cloud')
      }
      else {
        const input = f.controller.beginStream('', 'soft', undefined, 'cloud')
        input.push('**第一句。**\n')
        await settle()
        assert.equal(cloudCalls, 1)
        assert.equal(f.utterances.length, 0, 'stream fallback waits for the full visible reply')
        input.push('```js\nsecret();\n```\n[第二句。](https://example.invalid/private)')
        input.finish()
      }
      await settle()
      assert.equal(f.utterances[0].text, '第一句。')
      assert.match(f.events.problem.at(-1), /语音额度已用完/)
      assert.match(f.events.problem.at(-1), /不会下载本地大模型/)
      assert.deepEqual(f.events.delivery, [])
      f.utterances[0].onstart()
      f.utterances[0].onend()
      await settle()
      assert.equal(f.utterances[1].text, '第二句。')
      f.utterances[1].onend()
      await speaking
      await settle()
      assert.equal(f.utterances.length, 2)
      assert.equal(cloudCalls, 1)
      assert.equal(loads, 0)
      assert.equal(f.audio.src, '')
      assert.deepEqual(f.events.state, ['cloud', 'fallback'])
    }
    finally { f.close() }
  }
})

test('unconfigured cloud falls back to browser speech without starting the local model', async () => {
  let loads = 0
  const f = fixture(async () => { loads++; throw new Error('unconfigured cloud must remain lightweight') })
  try {
    const speaking = f.controller.speak('没启用云服务。', 'neutral', undefined, [], 'cloud')
    await settle()
    assert.equal(f.utterances[0].text, '没启用云服务。')
    assert.match(f.events.problem.at(-1), /云端语音生成失败/)
    assert.match(f.events.problem.at(-1), /不会下载本地大模型/)
    assert.doesNotMatch(f.events.problem.at(-1), /Cloud voice is not configured/)
    f.utterances[0].onend()
    await speaking
    assert.equal(loads, 0)
    assert.deepEqual(f.events.state, ['cloud', 'fallback'])
  }
  finally { f.close() }
})

test('partial cloud failure keeps valid audio without fallback duplication or retrying remaining sentences', async () => {
  for (const playback of ['stream', 'replay']) {
    let loads = 0
    const calls = []
    const f = fixture(async () => { loads++; throw new Error('cloud must not load Kokoro') }, {
      async synthesizeCloud(sentence) {
        calls.push(sentence.text)
        if (calls.length === 2) throw new Error('private provider partial failure')
        return cloudClip()
      },
    })
    try {
      if (playback === 'stream') {
        const input = f.controller.beginStream('', 'bright', undefined, 'cloud')
        input.push('第一句。第二句。第三句。')
        input.finish()
      }
      else await f.controller.speak('第一句。第二句。第三句。', 'bright', undefined, [], 'cloud')
      await settle()
      assert.deepEqual(calls, ['第一句。', '第二句。'])
      assert.equal(f.utterances.length, 0)
      assert.equal(loads, 0)
      assert.match(f.events.problem.at(-1), /后续语音生成中断/)
      assert.doesNotMatch(f.events.problem.at(-1), /private provider/)
      assert.deepEqual(f.events.delivery, ['bright'])
      f.audio.end()
      const wav = await (await fetch(f.audio.src)).arrayBuffer()
      assert.equal(wav.byteLength, 44 + 2400 * 2)
      assert.equal(f.events.ready.at(-1), true)
      assert.equal(f.events.playing.at(-1), false)
      assert.ok(f.events.state.every(state => state === 'cloud'))
      assert.deepEqual(calls, ['第一句。', '第二句。'])
      assert.equal(f.utterances.length, 0)
    }
    finally { f.close() }
  }
})
