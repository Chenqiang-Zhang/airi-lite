import assert from 'node:assert/strict'
import test from 'node:test'
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

function fixture(loadModel) {
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
  }, { loadModel })
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

test('nonspoken replies never load a model or use fallback, in stream and replay', async () => {
  let loads = 0
  const f = fixture(async () => { loads++; throw new Error('should not load') })
  try {
    for (const text of ['```python\n[x * 2 for x in [1,2,3]]\n```', '😊✨！！！', '😊'.repeat(89) + '1️⃣', '![日和](https://example.invalid/image.png)']) {
      const input = f.controller.beginStream('', 'bright')
      for (const char of text) input.push(char)
      input.setDelivery('soft')
      input.finish()
      await settle()
      await f.controller.speak(text, 'bright')
      assert.equal(loads, 0)
      assert.equal(f.audio.src, '')
      assert.equal(f.utterances.length, 0)
      assert.equal(f.events.preparing.at(-1), false)
      assert.equal(f.events.ready.at(-1), false)
      assert.match(f.events.problem.at(-1), /没有可朗读/)
      assert.deepEqual(f.events.state, [])
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
