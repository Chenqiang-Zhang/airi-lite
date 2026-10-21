import assert from 'node:assert/strict'
import test from 'node:test'
import { SpeechApiError, fetchCloudSpeech } from './cloud-speech.ts'
import { mouthAtTime, mouthFrames } from './mouth.ts'
import { speechBeats, speechBeatAtTime } from './speech-beats.ts'
import { BROWSER_SPEECH_START_DEADLINE_MS, createSpeechController } from './speech.ts'
import { groupSentences, replySentenceStream } from './speech-sentences.ts'
import { collectMinimaxStream } from '../server/minimax.mjs'
import { ACT_PAUSE_SECONDS } from '../shared/performance-cues.mjs'

class AudioStub extends EventTarget {
  paused = true
  currentTime = 0
  src = ''
  ended = false
  error = null
  readyState = 4
  seeking = false
  loads = 0
  plays = 0
  get currentSrc() { return this.src }
  load() { this.loads++; this.currentTime = 0; this.ended = false; this.error = null; this.readyState = 4; this.seeking = false }
  removeAttribute(name) { if (name === 'src') this.src = '' }
  pause() {
    if (this.paused) return
    this.paused = true
    this.dispatchEvent(new Event('pause'))
  }
  async play() {
    this.plays++
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
const shapedClip = (amplitude, sampleCount, sampleRate = 44100) => ({
  samples: Float32Array.from({ length: sampleCount }, (_, index) => {
    const time = index / sampleRate
    const duration = sampleCount / sampleRate
    if (time < 0.035 || time > duration - 0.065) return 0
    const gain = time < 0.08 ? 0.4 : 1
    return amplitude * gain * (Math.sin(time * 2 * Math.PI * 210) + 0.12 * Math.sin(time * 2 * Math.PI * 1900))
  }),
  sampleRate,
  words: [],
})
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((accept, refuse) => { resolve = accept; reject = refuse })
  return { promise, resolve, reject }
}

function startDeadlineClock() {
  const entries = []
  return {
    entries,
    schedule(expired, milliseconds) {
      const entry = { expired, milliseconds, active: true, cleared: 0 }
      entries.push(entry)
      return () => { entry.active = false; entry.cleared++ }
    },
    fire(index = 0, force = false) {
      const entry = entries[index]
      if (!entry || (!force && !entry.active)) return
      entry.active = false
      entry.expired()
    },
    active() { return entries.filter(entry => entry.active).length },
  }
}

function fixture(loadModel, dependencies = {}, callbackOverrides = {}) {
  const previous = Object.fromEntries(['window', 'SpeechSynthesisUtterance', 'requestAnimationFrame', 'cancelAnimationFrame'].map(key => [key, globalThis[key]]))
  const utterances = []
  globalThis.window = { speechSynthesis: { speak: utterance => utterances.push(utterance), cancel() {} } }
  globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text } }
  let nextFrame = 0
  const frames = new Map()
  globalThis.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame }
  globalThis.cancelAnimationFrame = id => frames.delete(id)
  const audio = new AudioStub()
  const events = { delivery: [], problem: [], playing: [], preparing: [], mouth: [], beats: [], ready: [], state: [] }
  const controller = createSpeechController(audio, {
    onState: value => events.state.push(value),
    onAudioReady: value => events.ready.push(value),
    onDelivery: value => events.delivery.push(value),
    onProblem: value => events.problem.push(value),
    onPlaying: value => events.playing.push(value),
    onPreparing: value => events.preparing.push(value),
    onMouth: (open, form, beat) => { events.mouth.push([open, form]); events.beats.push(beat) },
    ...callbackOverrides,
  // Most tests here pin per-sentence buying (capacity, lookahead, outcomes);
  // the joining tests opt in with joinCloudSentences: true or speak({ join }).
  }, { loadModel, joinCloudSentences: false, ...dependencies })
  return {
    audio, events, controller, utterances,
    tick(time, timestamp = performance.now()) {
      audio.currentTime = time
      const callbacks = [...frames.values()]
      frames.clear()
      for (const callback of callbacks) callback(timestamp)
    },
    queuedFrames() { return frames.size },
    frameCallbacks() { return [...frames.values()] },
    close() {
      controller.dispose()
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete globalThis[key]
        else globalThis[key] = value
      }
    },
  }
}

function stallAt(f, time = 0.12, baseline = 100_000) {
  for (const elapsed of [0, 500, 1000, 1500]) f.tick(time, baseline + elapsed)
  return baseline + 1500
}

test('cloud alignment survives segment two, full cache, backward seek and playback interruption', async () => {
  const sampleRate = 24000, duration = 1.317
  const clips = [.09, .012].map(amplitude => ({ sampleRate,
    samples: Float32Array.from({ length: sampleRate * duration }, (_, index) => {
      const time = index / sampleRate
      const envelope = Math.max(0, 1 - Math.abs(time - .25) / .08, 1 - Math.abs(time - .95) / .09)
      return amplitude * envelope * Math.sin(time * Math.PI * 2 * 230)
    }), words: [], characters: [{ text: '你', start: .12, end: .42 },
      { text: '，', start: .42, end: .6 }, { text: '好', start: .8, end: 1.17 }] }))
  let previousPeak = -Infinity
  const tracks = clips.map((clip, index) => {
    const events = speechBeats(clip, mouthFrames(clip.samples, sampleRate), duration, previousPeak - index * duration)
    if (events?.length) previousPeak = index * duration + events.at(-1).peak
    return { time: 0, duration, events }
  })
  assert.ok(tracks.every(track => track.events.length > 0), 'fixture has measured audible peaks')
  let calls = 0
  const f = fixture(async () => { throw new Error('local model must not load') }, {
    async synthesizeCloud() { return clips[calls++] },
  })
  const snapshots = []
  const times = [...tracks[0].events.map(event => event.peak), .55, .72]
  try {
    const speaking = f.controller.speak('第一句。第二句。', 'happy', undefined, [{ start: 4, delivery: 'soft' }], 'cloud')
    await settle()
    assert.equal(calls, 2)
    for (const track of tracks) {
      const values = []
      for (const time of times) {
        f.tick(time)
        values.push(f.events.beats.at(-1))
        assert.ok(Math.abs(values.at(-1) - speechBeatAtTime([track], time)) < 1e-12)
      }
      snapshots.push(values)
      f.audio.end()
      await settle()
    }
    await speaking
    assert.equal(f.audio.paused, true)
    assert.equal(f.events.beats.at(-1), null)
    await f.audio.play()
    for (const clipIndex of [1, 0, 1, 0]) {
      for (const [index, time] of times.entries()) {
        f.tick(clipIndex * duration + time)
        assert.ok(Math.abs(f.events.beats.at(-1) - snapshots[clipIndex][index]) < 1e-12,
          'full-cache second-clip offset and backward seek preserve the measured envelope')
      }
    }
    f.audio.pause()
    assert.equal(f.events.beats.at(-1), null)
    await f.audio.play()
    f.tick(tracks[0].events[0].peak)
    assert.ok(f.events.beats.at(-1) > .1)
    stallAt(f, tracks[0].events[0].peak)
    assert.equal(f.events.beats.at(-1), null, 'stalled media cannot hold an aligned beat')
    f.controller.cancel()
    assert.equal(f.events.beats.at(-1), null)
    assert.equal(calls, 2, 'no provider calls for replay, seek or recovery')
  }
  finally { f.close() }
})

test('wire-missing character alignment retains fallback, while explicit empty or punctuation suppresses it', async () => {
  for (const characters of [undefined, [], [{ text: '，', start: 0, end: 1 }]]) {
    let calls = 0
    const f = fixture(async () => { throw new Error('must not load local model') }, {
      synthesizeCloud: () => fetchCloudSpeech({ text: '你好。', delivery: 'neutral', endpoint: '/api/speech' }, {
        fetch: async () => {
          calls++
          return new Response(JSON.stringify({ audio: Buffer.from('ID3-fake-mp3').toString('base64'),
            format: 'mp3', sampleRate: 32000, words: [], ...(characters === undefined ? {} : { characters }) }))
        }, decodeAudio: async () => shapedClip(.02, 32000, 32000),
      }),
    })
    try {
      await f.controller.speak('你好。', 'neutral', undefined, [], 'cloud')
      f.tick(.1)
      assert.ok(f.events.mouth.at(-1)[0] > .1)
      assert.equal(f.events.beats.at(-1), characters === undefined ? null : 0)
      f.audio.end()
      await f.audio.play()
      f.tick(.1)
      assert.equal(f.events.beats.at(-1), characters === undefined ? null : 0,
        'full replay preserves wire missing-versus-empty distinction')
      assert.equal(calls, 1)
    }
    finally { f.close() }
  }
})

test('accepted MiniMax empty/all-zero metadata suppresses strong-mouth fallback through parse, decode and cache', async () => {
  // Structural fake MPEG frames and injected PCM, not provider/codec evidence.
  const mp3 = Buffer.alloc(576 * 28)
  for (let offset = 0; offset < mp3.length; offset += 576)
    Buffer.from([0xff, 0xfb, 0x98, 0xc0]).copy(mp3, offset)
  const providerWord = end => ({ word: '你', word_begin: 0, word_end: 1, time_begin: 0, time_end: end })
  for (const timestampedWords of [undefined, [], [providerWord(0)], [providerWord(900)]]) {
    let calls = 0
    const pcm = { sampleRate: 32000, samples: Float32Array.from({ length: 32000 }, (_, index) => {
      const time = index / 32000, pulse = Math.max(0, 1 - Math.abs(time - .25) / .1)
      return .12 * pulse * Math.sin(time * Math.PI * 2 * 230)
    }) }
    const f = fixture(async () => { throw new Error('must not load local model') }, {
      synthesizeCloud: async () => {
        const subtitle = { text: '你', text_begin: 0, text_end: 1, time_begin: 0, time_end: 900,
          ...(timestampedWords === undefined ? {} : { timestamped_words: timestampedWords }) }
        const event = { base_resp: { status_code: 0 }, data: { audio: mp3.toString('hex'), status: 2, subtitle },
          extra_info: { audio_format: 'mp3', audio_sample_rate: 32000, audio_channel: 1, audio_size: mp3.length, audio_length: 1000 } }
        const source = new ReadableStream({ start(controller) {
          controller.enqueue(Buffer.from(`data: ${JSON.stringify(event)}\n\n`)); controller.close()
        } })
        const parsed = await collectMinimaxStream(source, { textLength: 1 })
        assert.equal(Object.hasOwn(parsed, 'wordAlignmentAvailable'), timestampedWords !== undefined)
        return fetchCloudSpeech({ text: '你。', delivery: 'neutral', endpoint: '/api/speech' }, {
          fetch: async () => { calls++; return new Response(JSON.stringify(parsed)) }, decodeAudio: async () => pcm,
        })
      },
    })
    try {
      await f.controller.speak('你。', 'neutral', undefined, [], 'cloud')
      f.tick(.25)
      assert.ok(f.events.mouth.at(-1)[0] > .3, 'known empty alignment cannot be hidden by a closed mouth')
      const original = f.events.beats.at(-1)
      if (timestampedWords === undefined) assert.equal(original, null)
      else if (timestampedWords.length === 0 || timestampedWords[0].time_end === 0) assert.equal(original, 0)
      else assert.ok(original > .1, 'nonempty accepted word intervals retain measured beats')
      f.audio.end()
      await f.audio.play()
      f.tick(.25)
      assert.equal(f.events.beats.at(-1), original, 'full cache preserves provider availability fact')
      f.tick(.72); f.tick(.25)
      assert.equal(f.events.beats.at(-1), original, 'backward seek does not reinterpret alignment presence')
      assert.equal(calls, 1)
    }
    finally { f.close() }
  }
})

test('sentence rates and expressions follow actual chunks, full replay and seeking', async () => {
  const calls = []
  const f = fixture(async () => ({ async *stream(text, options) {
    calls.push({ text, speed: options.speed })
    yield clip()
  } }))
  try {
    const input = f.controller.beginStream('', 'happy')
    input.push('好耶！')
    input.setDelivery('soft')
    input.push('先歇一下。')
    input.setDelivery('curious')
    input.push('明天呢？')
    input.finish()
    await settle()
    assert.deepEqual(calls.map(call => call.speed), [1.04, 0.93, 0.99])
    assert.deepEqual(f.events.delivery, ['happy']) // Later chunks were synthesized, not played.
    f.audio.end()
    assert.deepEqual(f.events.delivery, ['happy', 'soft'])
    f.audio.end()
    assert.deepEqual(f.events.delivery, ['happy', 'soft', 'curious'])
    f.audio.end()
    const wav = await (await fetch(f.audio.src)).arrayBuffer()
    assert.equal(wav.byteLength, 44 + 2400 * 3 * 2)
    await f.audio.play()
    f.tick(0.15)
    f.tick(0.25)
    f.tick(0.01)
    assert.deepEqual(f.events.delivery.slice(-4), ['happy', 'soft', 'curious', 'happy'])
  }
  finally { f.close() }
})

test('a redundant streamed cue cannot add a local, cloud or browser utterance', async () => {
  for (const engine of ['local', 'cloud', 'browser']) {
    const calls = []
    const f = fixture(async () => ({ async *stream(text) {
      calls.push(text)
      yield clip()
    } }), { async synthesizeCloud(sentence) { calls.push(sentence.text); return cloudClip() } })
    try {
      const input = f.controller.beginStream('', 'happy', undefined, engine)
      input.push('我刚才还')
      input.setDelivery('happy')
      input.push('在想，要不要换个话题。')
      input.finish()
      await settle()
      if (engine === 'browser') {
        assert.deepEqual(f.utterances.map(u => u.text), ['我刚才还在想，要不要换个话题。'])
        f.utterances[0].onstart()
        f.utterances[0].onend()
        await settle()
        assert.equal(f.utterances.length, 1)
        assert.equal(calls.length, 0)
      }
      else {
        assert.deepEqual(calls, ['我刚才还在想，要不要换个话题。'])
        assert.equal(f.audio.plays, 1)
      }
    }
    finally { f.close() }
  }
})

test('a native start deadline ends no-event speech in every engine and entry path without retrying or advancing', async () => {
  for (const engine of ['browser', 'local', 'cloud']) {
    for (const entry of ['stream', 'replay']) {
      const clock = startDeadlineClock()
      let loads = 0, cloudCalls = 0, nativeCancels = 0
      const f = fixture(async () => { loads++; throw new Error('test: unavailable local voice') }, {
        scheduleBrowserStartDeadline: clock.schedule,
        async synthesizeCloud() { cloudCalls++; throw new Error('test: unavailable cloud voice') },
      })
      window.speechSynthesis.cancel = () => { nativeCancels++ }
      try {
        let speaking
        if (entry === 'stream') {
          const input = f.controller.beginStream('', 'happy', undefined, engine)
          input.push('第一句。不能自动继续。')
          input.finish()
        }
        else speaking = f.controller.speak('第一句。不能自动继续。', 'happy', undefined, [], engine)
        await settle()
        assert.equal(f.utterances.length, 1)
        assert.equal(clock.active(), 1)
        assert.equal(clock.entries[0].milliseconds, BROWSER_SPEECH_START_DEADLINE_MS)
        assert.equal(f.events.preparing.at(-1), true)
        const beforeCancel = nativeCancels
        clock.fire()
        await settle()
        if (speaking) await speaking
        assert.equal(clock.active(), 0)
        assert.equal(nativeCancels, beforeCancel + 1)
        assert.equal(f.utterances.length, 1)
        assert.equal(loads, engine === 'local' ? 1 : 0)
        assert.equal(cloudCalls, engine === 'cloud' ? 1 : 0)
        assert.equal(f.events.preparing.at(-1), false)
        assert.equal(f.events.playing.at(-1), false)
        assert.deepEqual(f.events.mouth.at(-1), [0, 0])
        assert.deepEqual(f.events.delivery, [])
        assert.match(f.events.problem.at(-1), /迟迟未确认开始/)
        const stopped = structuredClone(f.events)
        clock.fire(0, true)
        for (const type of ['onstart', 'onpause', 'onresume', 'onend', 'onerror']) f.utterances[0][type]()
        await settle()
        assert.deepEqual(f.events, stopped, 'late events cannot overwrite the timeout or reopen the mouth')
        assert.equal(nativeCancels, beforeCancel + 1)
        assert.equal(f.utterances.length, 1)
      }
      finally { f.close() }
    }
  }
})

test('a real native start retires its deadline for long playback, pause and resume', async () => {
  const clock = startDeadlineClock()
  const f = fixture(undefined, { scheduleBrowserStartDeadline: clock.schedule })
  let nativeCancels = 0
  window.speechSynthesis.cancel = () => { nativeCancels++ }
  try {
    const speaking = f.controller.speak('可以正常读完的长句。', 'soft', undefined, [], 'browser')
    await settle()
    const utterance = f.utterances[0], beforeCancel = nativeCancels
    utterance.onstart()
    assert.equal(clock.active(), 0)
    assert.equal(clock.entries[0].cleared, 1)
    clock.fire(0, true)
    assert.equal(f.events.playing.at(-1), true)
    utterance.onpause()
    clock.fire(0, true)
    assert.equal(f.events.playing.at(-1), false)
    assert.deepEqual(f.events.mouth.at(-1), [0, 0])
    utterance.onresume()
    assert.equal(f.events.playing.at(-1), true)
    assert.deepEqual(f.events.mouth.at(-1), [null, 0])
    assert.equal(nativeCancels, beforeCancel)
    assert.equal(clock.entries.length, 1, 'resume is not a new start deadline')
    utterance.onend()
    await speaking
    assert.equal(clock.entries[0].cleared, 1)
    assert.equal(f.events.problem.at(-1), '')
  }
  finally { f.close() }
})

test('synchronous native completion or speak failure clears the installed start deadline', async () => {
  for (const scenario of ['start-end', 'end-without-start', 'error-without-start', 'speak-throws']) {
    const clock = startDeadlineClock()
    const f = fixture(undefined, { scheduleBrowserStartDeadline: clock.schedule })
    window.speechSynthesis.speak = utterance => {
      f.utterances.push(utterance)
      assert.equal(clock.active(), 1, 'deadline is installed before native speak')
      if (scenario === 'speak-throws') throw new Error('test: native speak rejected')
      if (scenario === 'start-end') utterance.onstart()
      if (scenario === 'error-without-start') utterance.onerror()
      else utterance.onend()
    }
    try {
      await f.controller.speak('同步测试。', 'happy', undefined, [], 'browser')
      assert.equal(clock.active(), 0)
      assert.equal(clock.entries[0].cleared, 1)
      const before = structuredClone(f.events)
      clock.fire(0, true)
      assert.deepEqual(f.events, before)
      assert.equal(f.events.preparing.at(-1), false)
      if (scenario === 'start-end') assert.equal(f.events.problem.at(-1), '')
      else if (scenario === 'end-without-start') assert.match(f.events.problem.at(-1), /未确认开始播放/)
      else assert.match(f.events.problem.at(-1), /语音播放失败/)
    }
    finally { f.close() }
  }
})

test('a synchronously expired native scheduler clears once without submitting an utterance or the next sentence', async () => {
  let scheduled = 0, cleared = 0
  const f = fixture(undefined, { scheduleBrowserStartDeadline(expired, milliseconds) {
    scheduled++
    assert.equal(milliseconds, BROWSER_SPEECH_START_DEADLINE_MS)
    expired()
    return () => { cleared++ }
  } })
  try {
    await f.controller.speak('一句。不能继续。', 'neutral', undefined, [], 'browser')
    assert.equal(scheduled, 1)
    assert.equal(cleared, 1)
    assert.equal(f.utterances.length, 0)
    assert.equal(f.events.preparing.at(-1), false)
    assert.equal(f.events.playing.at(-1), false)
    assert.deepEqual(f.events.mouth.at(-1), [0, 0])
    assert.match(f.events.problem.at(-1), /停止等待/)
    f.controller.cancel()
    assert.equal(cleared, 1, 'completed ownership was already retired')
  }
  finally { f.close() }
})

test('a failed native scheduler releases preparation and keeps the specific speech failure without speaking', async () => {
  let scheduled = 0
  const f = fixture(undefined, { scheduleBrowserStartDeadline() {
    scheduled++
    throw new Error('test: scheduler unavailable')
  } })
  try {
    await f.controller.speak('一句。不能继续。', 'neutral', undefined, [], 'browser')
    assert.equal(scheduled, 1)
    assert.equal(f.utterances.length, 0)
    assert.equal(f.events.preparing.at(-1), false)
    assert.equal(f.events.playing.at(-1), false)
    assert.deepEqual(f.events.mouth.at(-1), [0, 0])
    assert.match(f.events.problem.at(-1), /浏览器语音播放失败/)
    assert.doesNotMatch(f.events.problem.at(-1), /迟迟未确认开始/)
  }
  finally { f.close() }
})

test('cancel and dispose retire a pending native deadline, including an already-queued callback', async () => {
  for (const operation of ['cancel', 'dispose']) {
    const clock = startDeadlineClock()
    const f = fixture(undefined, { scheduleBrowserStartDeadline: clock.schedule })
    let nativeCancels = 0
    window.speechSynthesis.cancel = () => { nativeCancels++ }
    try {
      const speaking = f.controller.speak('旧句。', 'happy', undefined, [], 'browser')
      await settle()
      f.controller[operation]()
      await speaking
      assert.equal(clock.active(), 0)
      const stopped = structuredClone(f.events), beforeCancel = nativeCancels
      clock.fire(0, true)
      for (const type of ['onstart', 'onend', 'onerror', 'onpause', 'onresume']) f.utterances[0][type]()
      assert.deepEqual(f.events, stopped)
      assert.equal(nativeCancels, beforeCancel)
    }
    finally { f.close() }
  }
})

test('a replaced native start cannot cancel or change the fresh turn through its stale deadline or events', async () => {
  const clock = startDeadlineClock()
  const f = fixture(undefined, { scheduleBrowserStartDeadline: clock.schedule })
  let nativeCancels = 0
  window.speechSynthesis.cancel = () => { nativeCancels++ }
  try {
    const old = f.controller.speak('旧句。', 'happy', undefined, [], 'browser')
    await settle()
    const fresh = f.controller.speak('新句。', 'soft', undefined, [], 'browser')
    await old
    await settle()
    assert.equal(clock.active(), 1)
    f.utterances[1].onstart()
    const current = structuredClone(f.events), beforeCancel = nativeCancels
    clock.fire(0, true)
    for (const type of ['onstart', 'onend', 'onerror', 'onpause', 'onresume']) f.utterances[0][type]()
    assert.deepEqual(f.events, current)
    assert.equal(nativeCancels, beforeCancel)
    f.utterances[1].onend()
    await fresh
    assert.deepEqual(f.events.delivery, ['soft'])
  }
  finally { f.close() }
})

test('native cancellation at the start deadline may synchronously end/error or throw without retaining ownership', async () => {
  for (const behavior of ['old-events', 'throws']) {
    const clock = startDeadlineClock()
    const f = fixture(undefined, { scheduleBrowserStartDeadline: clock.schedule })
    try {
      const speaking = f.controller.speak('不返回事件的句子。', 'happy', undefined, [], 'browser')
      await settle()
      window.speechSynthesis.cancel = () => {
        if (behavior === 'throws') throw new Error('test: native cancel unavailable')
        f.utterances[0].onend()
        f.utterances[0].onerror()
        f.utterances[0].onstart()
      }
      clock.fire()
      await speaking
      assert.equal(clock.active(), 0)
      assert.deepEqual(f.events.delivery, [])
      assert.equal(f.events.playing.at(-1), false)
      assert.equal(f.events.preparing.at(-1), false)
      assert.match(f.events.problem.at(-1), /迟迟未确认开始/)
    }
    finally { window.speechSynthesis.cancel = () => {}; f.close() }
  }
})

test('a native cancel listener can start a fresh turn before deadline UI cleanup without stale state writes', async () => {
  const clock = startDeadlineClock()
  const f = fixture(undefined, { scheduleBrowserStartDeadline: clock.schedule })
  let fresh, nativeCancels = 0, replaceOnCancel = false
  window.speechSynthesis.cancel = () => {
    nativeCancels++
    if (!replaceOnCancel) return
    replaceOnCancel = false
    fresh = f.controller.speak('新句。', 'soft', undefined, [], 'browser')
  }
  try {
    const old = f.controller.speak('旧句。', 'happy', undefined, [], 'browser')
    await settle()
    replaceOnCancel = true
    clock.fire()
    await old
    await settle()
    assert.equal(f.utterances.length, 2)
    assert.equal(f.events.preparing.at(-1), true)
    assert.equal(f.events.problem.at(-1), '')
    const beforeCancel = nativeCancels
    clock.fire(0, true)
    assert.equal(nativeCancels, beforeCancel)
    f.utterances[1].onstart()
    f.utterances[1].onend()
    await fresh
  }
  finally { f.close() }
})

test('each deadline cleanup callback may start a fresh turn without later old cleanup or native cancellation', async () => {
  for (const trigger of ['onPreparing', 'onPlaying', 'onMouth', 'onProblem']) {
    const clock = startDeadlineClock()
    let f, fresh, armed = false, nativeCancels = 0
    const entries = { onPreparing: 'preparing', onPlaying: 'playing', onMouth: 'mouth', onProblem: 'problem' }
    f = fixture(undefined, { scheduleBrowserStartDeadline: clock.schedule }, {
      [trigger](...args) {
        f.events[entries[trigger]].push(trigger === 'onMouth' ? args : args[0])
        if (!armed) return
        armed = false
        fresh = f.controller.speak('新句。', 'soft', undefined, [], 'browser')
      },
    })
    window.speechSynthesis.cancel = () => { nativeCancels++ }
    try {
      const old = f.controller.speak('旧句。', 'happy', undefined, [], 'browser')
      await settle()
      armed = true
      clock.fire()
      await old
      await settle()
      assert.equal(f.utterances.length, 2)
      assert.equal(f.events.preparing.at(-1), true)
      assert.equal(f.events.problem.at(-1), '')
      const current = structuredClone(f.events), beforeCancel = nativeCancels
      clock.fire(0, true)
      assert.deepEqual(f.events, current)
      assert.equal(nativeCancels, beforeCancel)
      f.utterances[1].onstart()
      f.utterances[1].onend()
      await fresh
      assert.deepEqual(f.events.delivery, ['soft'])
    }
    finally { f.close() }
  }
})

test('fragmented terminal punctuation and closing quotes reach every speech engine with the original tone', async () => {
  for (const engine of ['local', 'cloud', 'browser']) {
    const calls = []
    const f = fixture(async () => ({ async *stream(text) { calls.push(text); yield clip() } }), {
      async synthesizeCloud(sentence) { calls.push(sentence.text); return cloudClip() },
    })
    try {
      const input = f.controller.beginStream('', 'happy', undefined, engine)
      for (const fragment of ['“真的', '吗？', '！', '”']) {
        input.push(fragment)
        await settle()
        assert.equal(calls.length + f.utterances.length, 0, 'the terminal suffix is not submitted prematurely')
      }
      input.setDelivery('soft')
      await settle()
      const submitted = () => engine === 'browser' ? f.utterances.map(u => u.text) : calls
      assert.deepEqual(submitted(), ['“真的吗？！”'])
      input.push('嗯，先缓一下。')
      input.finish()
      await settle()
      if (engine === 'browser') {
        assert.deepEqual(f.events.delivery, [])
        f.utterances[0].onstart()
        assert.deepEqual(f.events.delivery, ['happy'])
        f.utterances[0].onend()
        await settle()
        assert.deepEqual(submitted(), ['“真的吗？！”', '嗯，先缓一下。'])
        f.utterances[1].onstart()
        assert.deepEqual(f.events.delivery, ['happy', 'soft'])
        f.utterances[1].onend()
      }
      else {
        assert.deepEqual(submitted(), ['“真的吗？！”', '嗯，先缓一下。'])
        assert.deepEqual(f.events.delivery, ['happy'], 'preparing the next sentence cannot change the current expression')
        f.audio.end()
        assert.deepEqual(f.events.delivery, ['happy', 'soft'])
        f.audio.end()
      }
    }
    finally { f.close() }
  }
})

test('canceling a pending terminal suffix cannot submit old speech or block the next newline-committed sentence', async () => {
  for (const engine of ['local', 'cloud', 'browser']) {
    const calls = []
    const f = fixture(async () => ({ async *stream(text) { calls.push(text); yield clip() } }), {
      async synthesizeCloud(sentence) { calls.push(sentence.text); return cloudClip() },
    })
    try {
      const old = f.controller.beginStream('', 'happy', undefined, engine)
      old.push('旧句？！')
      await settle()
      assert.equal(calls.length + f.utterances.length, 0)
      old.cancel()
      old.finish()
      old.push('不能泄漏。\n')
      const fresh = f.controller.beginStream('', 'soft', undefined, engine)
      fresh.push('新句。\n')
      await settle()
      assert.deepEqual(engine === 'browser' ? f.utterances.map(u => u.text) : calls, ['新句。'])
      fresh.finish()
      if (engine === 'browser') {
        f.utterances[0].onstart()
        f.utterances[0].onend()
      }
      else f.audio.end()
      await settle()
      assert.equal(calls.length + f.utterances.length, 1)
      assert.deepEqual(f.events.delivery, ['soft'])
      assert.deepEqual(f.events.mouth.at(-1), [0, 0])
    }
    finally { f.close() }
  }
})

test('already-ready same-tone clips share playback without altering PCM, pauses or per-clip mouth calibration', async () => {
  const clips = [shapedClip(0.05, 6615), shapedClip(0.006, 8260), shapedClip(0.34, 10438)]
  const calls = []
  const f = fixture(async () => ({ async *stream(text) {
    calls.push(text)
    const c = clips[calls.length - 1]
    yield { audio: { data: c.samples, sampling_rate: c.sampleRate } }
  } }))
  const assertPcm = (wav, expected) => {
    assert.equal(wav.byteLength, 44 + expected.length * 2)
    const view = new DataView(wav)
    for (let i = 0; i < expected.length; i++) {
      const value = Math.max(-1, Math.min(1, expected[i]))
      assert.equal(view.getInt16(44 + i * 2, true), Math.trunc(value < 0 ? value * 0x8000 : value * 0x7fff) || 0)
    }
  }
  try {
    await f.controller.speak('一。二。三。', 'happy')
    assert.deepEqual(calls, ['一。', '二。', '三。'], 'synthesis text/context is intentionally unchanged')
    assert.equal(f.audio.plays, 1, 'the initial clip does not wait for a batch')
    const secondDuration = clips[1].samples.length / clips[1].sampleRate
    f.audio.end()
    assert.equal(f.audio.plays, 2, 'both queued clips use one source startup')
    const joined = Float32Array.from([...clips[1].samples, ...clips[2].samples])
    assertPcm(await (await fetch(f.audio.src)).arrayBuffer(), joined)
    const track = clips.slice(1).map(c => ({ time: 0, duration: c.samples.length / c.sampleRate, frames: mouthFrames(c.samples, c.sampleRate) }))
    for (const time of [0, 0.08, secondDuration - 0.02, secondDuration + 0.09, 0.09]) {
      f.tick(time)
      const c = time >= secondDuration ? 1 : 0
      const expected = mouthAtTime([track[c]], time - (c ? secondDuration : 0))
      assert.deepEqual(f.events.mouth.at(-1), [expected.open, expected.form])
    }
    f.audio.pause()
    const count = f.events.mouth.length
    f.tick(secondDuration + 0.09)
    assert.equal(f.events.mouth.length, count, 'a paused joined clip cannot animate its mouth')
    await f.audio.play()
    f.audio.end()
    assert.equal(f.audio.plays, 3, 'full-reply replacement does not automatically replay')
    assertPcm(await (await fetch(f.audio.src)).arrayBuffer(), Float32Array.from(clips.flatMap(c => [...c.samples])))
    assert.equal(calls.length, 3, 'replay preparation never resynthesizes')
  }
  finally { f.close() }
})

test('controller full-cache replacement constructs only a 44-byte header and preserves exact queued PCM', async () => {
  const clips = [shapedClip(0.05, 6615), shapedClip(0.006, 8260), shapedClip(0.34, 10438)]
  const calls = []
  const f = fixture(async () => ({ async *stream(text) {
    calls.push(text)
    const current = clips[calls.length - 1]
    yield { audio: { data: current.samples, sampling_rate: current.sampleRate } }
  } }))
  const OriginalBuffer = globalThis.ArrayBuffer
  const OriginalFloat32 = globalThis.Float32Array
  const buffers = [], floats = []
  try {
    await f.controller.speak('一。二。三。', 'happy')
    assert.deepEqual(calls, ['一。', '二。', '三。'])
    assert.equal(f.audio.plays, 1)
    f.audio.end()
    assert.equal(f.audio.plays, 2, 'the two ready same-tone successors play as one queued batch')
    const queuedSource = f.audio.src
    const beforeLoads = f.audio.loads

    // Observe only the synchronous ended -> advance -> full-cache composition
    // path. Restore constructors before fetch/blob readers or any await, whose
    // own allocations are outside this production-path assertion.
    try {
      globalThis.ArrayBuffer = new Proxy(OriginalBuffer, { construct(target, args) {
        buffers.push(args[0]); return Reflect.construct(target, args)
      } })
      globalThis.Float32Array = new Proxy(OriginalFloat32, { construct(target, args) {
        floats.push(typeof args[0] === 'number' ? args[0] : 'non-length input')
        return Reflect.construct(target, args)
      } })
      f.audio.end()
    }
    finally {
      globalThis.ArrayBuffer = OriginalBuffer
      globalThis.Float32Array = OriginalFloat32
    }

    assert.deepEqual(buffers, [44], 'the real controller allocates only an explicit WAV header')
    assert.deepEqual(floats, [], 'complete replay does not concatenate a full-length Float32 buffer')
    assert.notEqual(f.audio.src, queuedSource)
    assert.equal(f.audio.loads, beforeLoads + 1)
    assert.equal(f.audio.paused, true, 'replacing a finished batch prepares cache, not playback intent')
    assert.equal(f.audio.plays, 2, 'full-cache installation does not automatically replay')
    assert.equal(f.events.playing.at(-1), false)
    assert.equal(f.events.preparing.at(-1), false)
    assert.equal(f.events.ready.at(-1), true)
    assert.deepEqual(f.events.mouth.at(-1), [0, 0])
    assert.deepEqual(calls, ['一。', '二。', '三。'], 'cache preparation starts no additional inference')

    const wav = await (await fetch(f.audio.src)).arrayBuffer()
    const total = clips.reduce((count, current) => count + current.samples.length, 0)
    const view = new DataView(wav)
    assert.equal(wav.byteLength, 44 + total * 2)
    assert.equal(view.getUint32(24, true), 44100)
    assert.equal(view.getUint32(40, true), total * 2)
    let index = 0
    for (const current of clips) {
      for (const sample of current.samples) {
        const value = Math.max(-1, Math.min(1, sample))
        const expected = Math.trunc(value < 0 ? value * 0x8000 : value * 0x7fff) || 0
        assert.equal(view.getInt16(44 + index++ * 2, true), expected)
      }
    }
    await f.audio.play()
    assert.equal(f.audio.plays, 3)
    assert.equal(calls.length, 3, 'explicit replay also reuses completed cache without inference')
  }
  finally {
    globalThis.ArrayBuffer = OriginalBuffer
    globalThis.Float32Array = OriginalFloat32
    f.close()
  }
})

test('ready playback joining is bounded by clip count, duration and tone changes', async () => {
  for (const sample of [
    { text: '一。二。三。四。五。', counts: [2400, 2400, 2400, 2400, 2400], cues: [], expected: 7200 },
    { text: '一。二。三。', counts: [2400, 168000, 144000], cues: [], expected: 168000 },
    { text: '一。二。三。', counts: [2400, 2400, 2400], cues: [{ start: 4, delivery: 'soft' }], expected: 2400 },
  ]) {
    let generated = 0
    const f = fixture(async () => ({ async *stream() {
      const c = shapedClip(0.02, sample.counts[generated++], 24000)
      yield { audio: { data: c.samples, sampling_rate: c.sampleRate } }
    } }))
    try {
      const speaking = f.controller.speak(sample.text, 'happy', undefined, sample.cues)
      await settle()
      assert.equal(generated, Math.min(sample.counts.length, 4))
      f.audio.end()
      await settle()
      await speaking
      assert.equal(generated, sample.counts.length)
      const wav = await (await fetch(f.audio.src)).arrayBuffer()
      assert.equal(wav.byteLength, 44 + sample.expected * 2)
      assert.equal(f.events.delivery.at(-1), 'happy', 'a queued new tone cannot leak into the joined source')
      f.controller.cancel()
      assert.equal(f.audio.src, '')
      assert.deepEqual(f.events.mouth.at(-1), [0, 0])
    }
    finally { f.close() }
  }
})

test('local autoplay blocking starts only the first computation and cancel closes its iterator', { timeout: 1000 }, async () => {
  let computed = 0, closed = false
  const f = fixture(async () => ({ async *stream() {
    try { for (let index = 0; index < 40; index++) { computed++; yield clip() } }
    finally { closed = true }
  } }))
  try {
    f.audio.play = async () => { throw new DOMException('test: blocked', 'NotAllowedError') }
    const speaking = f.controller.speak('一次输入也可能产出很多片段。')
    await settle()
    assert.equal(computed, 1)
    assert.equal(f.audio.paused, true)
    assert.equal(closed, false)
    f.audio.dispatchEvent(new Event('playing'))
    await settle()
    assert.equal(computed, 1, 'a spurious playing event cannot grant local capacity')
    f.controller.cancel()
    await speaking
    assert.equal(computed, 1)
    assert.equal(closed, true)
    assert.equal(f.audio.src, '')
  }
  finally { f.close() }
})

test('local lookahead is bounded within one multi-clip input, resumes without skipping, and yields to a real task', { timeout: 1000 }, async () => {
  let computed = 0, inputs = 0
  const f = fixture(async () => ({ async *stream() {
    inputs++
    for (let index = 0; index < 9; index++) { computed++; yield clip() }
  } }))
  try {
    const speaking = f.controller.speak('这是一个输入。')
    const observedFromTask = await new Promise(resolve => setTimeout(() => resolve(computed), 0))
    assert.equal(observedFromTask, 4, 'one current clip plus at most three ready successors')
    f.audio.pause()
    for (let index = 0; index < 3; index++) await settle()
    assert.equal(computed, 4)
    await f.audio.play()
    await settle()
    assert.equal(computed, 4, 'resume cannot overfill an already-full queue')
    f.audio.end()
    await settle()
    assert.equal(computed, 7)
    f.audio.end()
    await settle()
    await speaking
    assert.equal(computed, 9)
    assert.equal(inputs, 1)
    f.audio.end()
    f.audio.end()
    const wav = await (await fetch(f.audio.src)).arrayBuffer()
    assert.equal(wav.byteLength, 44 + 9 * 2400 * 2)
    await f.audio.play()
    assert.equal(computed, 9, 'full replay never starts more local inference')
  }
  finally { f.close() }
})

test('pausing an in-flight local result accepts it but cannot start the next computation', { timeout: 1000 }, async () => {
  const second = deferred()
  let computed = 0
  const f = fixture(async () => ({ async *stream() {
    for (let index = 0; index < 3; index++) {
      computed++
      yield index === 1 ? await second.promise : clip()
    }
  } }))
  try {
    const speaking = f.controller.speak('一次输入三段。')
    await settle()
    assert.equal(computed, 2)
    f.audio.pause()
    second.resolve(clip())
    await settle()
    assert.equal(computed, 2)
    assert.deepEqual(f.events.mouth.at(-1), [0, 0])
    await f.audio.play()
    await settle()
    await speaking
    assert.equal(computed, 3)
    f.audio.end()
    f.audio.end()
  }
  finally { f.close() }
})

test('cancel, dispose and media errors release a local capacity wait without later computation', { timeout: 1000 }, async () => {
  for (const action of ['cancel', 'dispose', 'error']) {
    let computed = 0, closed = false
    const f = fixture(async () => ({ async *stream() {
      try { for (let index = 0; index < 40; index++) { computed++; yield clip() } }
      finally { closed = true }
    } }))
    try {
      const speaking = f.controller.speak('很多段，但不应提前全部生成。')
      await settle()
      assert.equal(computed, 4)
      if (action === 'error') {
        f.audio.error = { code: 3 }
        f.audio.dispatchEvent(new Event('error'))
      }
      else f.controller[action]()
      const stopped = structuredClone(f.events)
      await speaking
      await settle()
      assert.equal(computed, 4)
      assert.equal(closed, true)
      assert.deepEqual(f.events, stopped)
      assert.equal(f.audio.src, '')
    }
    finally { f.close() }
  }
})

test('a newer turn cannot inherit an old local waiter or iterator', { timeout: 1000 }, async () => {
  const calls = [], closed = []
  const f = fixture(async () => ({ async *stream(text) {
    try { for (let index = 0; index < 10; index++) { calls.push(text); yield clip() } }
    finally { closed.push(text) }
  } }))
  try {
    const old = f.controller.speak('旧回复。', 'happy')
    await settle()
    assert.equal(calls.length, 4)
    const fresh = f.controller.speak('新回复。', 'soft')
    await old
    await settle()
    assert.deepEqual(calls, [...Array(4).fill('旧回复。'), ...Array(4).fill('新回复。')])
    assert.deepEqual(closed, ['旧回复。'])
    assert.equal(f.events.delivery.at(-1), 'soft')
    f.controller.cancel()
    await fresh
    assert.deepEqual(closed, ['旧回复。', '新回复。'])
  }
  finally { f.close() }
})

test('local generation can fill an underrun when later streamed text finally arrives', { timeout: 1000 }, async () => {
  const calls = []
  const f = fixture(async () => ({ async *stream(text) { calls.push(text); yield clip() } }))
  try {
    const input = f.controller.beginStream('', 'neutral')
    input.push('先说一句。后')
    await settle()
    f.audio.end()
    await settle()
    assert.equal(f.events.preparing.at(-1), true)
    input.push('来这句也要出声。')
    input.finish()
    await settle()
    assert.deepEqual(calls, ['先说一句。', '后来这句也要出声。'])
    assert.equal(f.audio.paused, false)
    assert.equal(f.events.preparing.at(-1), false)
    f.audio.end()
  }
  finally { f.close() }
})

test('preparing full replay explicitly pauses an ended source that retained playing intent', async () => {
  const f = fixture(async () => ({ async *stream() { yield clip() } }))
  let inheritedPlaying = 0
  const load = f.audio.load.bind(f.audio)
  f.audio.load = () => {
    load()
    if (!f.audio.paused) { inheritedPlaying++; f.audio.dispatchEvent(new Event('playing')) }
  }
  const endWithoutPausing = () => { f.audio.ended = true; f.audio.dispatchEvent(new Event('ended')) }
  try {
    await f.controller.speak('第一句。第二句。', 'happy', undefined, [{start:4,delivery:'soft'}])
    endWithoutPausing()
    assert.equal(f.audio.paused, false, 'advance explicitly plays a real next clip')
    assert.equal(f.audio.plays, 2)
    const eventsBefore = f.events.playing.filter(Boolean).length
    endWithoutPausing()
    assert.equal(inheritedPlaying, 0)
    assert.equal(f.audio.plays, 2, 'preparing the complete WAV cannot request playback')
    assert.equal(f.events.playing.filter(Boolean).length, eventsBefore)
    assert.equal(f.audio.paused, true)
    assert.deepEqual(f.events.mouth.at(-1), [0, 0])
    const wav = await (await fetch(f.audio.src)).arrayBuffer()
    assert.equal(wav.byteLength, 44 + 2 * 2400 * 2)
    await f.audio.play()
    f.tick(0.15)
    assert.equal(f.events.delivery.at(-1), 'soft')
  }
  finally { f.close() }
})

test('quiet and loud clips keep their original mouth tracks through merged replay and backward seeks', async () => {
  for (const engine of ['local', 'cloud']) {
    // Neither clip ends on a 25 ms mouth-frame boundary. The second clip is
    // over 50 times louder, so recalibrating the combined reply is observable.
    const clips = [shapedClip(0.006, 8260), shapedClip(0.34, 10438)]
    let nextClip = 0
    const f = fixture(async () => ({ async *stream() {
      const current = clips[nextClip++]
      yield { audio: { data: current.samples, sampling_rate: current.sampleRate } }
    } }), {
      async synthesizeCloud() { return clips[nextClip++] },
    })
    try {
      await f.controller.speak('小声的第一句。响亮的第二句。', 'happy', undefined, [
        { start: '小声的第一句。'.length, delivery: 'soft' },
      ], engine)
      await settle()
      assert.equal(nextClip, 2)
      const originalTracks = []
      const originalPcm = []
      const times = [0.01, 0.04, 0.061, 0.087, 0.112]
      for (const current of clips) {
        const duration = current.samples.length / current.sampleRate
        const track = times.map(time => {
          f.tick(time)
          return f.events.mouth.at(-1)
        })
        originalTracks.push(track)
        const expectedFrames = mouthFrames(current.samples, current.sampleRate)
        assert.deepEqual(track, times.map(time => {
          const mouth = mouthAtTime([{ time: 0, duration, frames: expectedFrames }], time)
          return [mouth.open, mouth.form]
        }))
        assert.deepEqual(track[0], [0, 0], 'leading silence is closed')
        assert.ok(track.slice(1).some(([open]) => open > 0.1), 'quiet speech still has a visible mouth')
        f.tick(duration - 0.005)
        assert.deepEqual(f.events.mouth.at(-1), [0, 0], 'trailing silence is closed')
        originalPcm.push(new Uint8Array(await (await fetch(f.audio.src)).arrayBuffer()).slice(44))
        f.audio.end()
      }
      assert.deepEqual(f.events.mouth.at(-1), [0, 0])

      const mergedPcm = new Uint8Array(await (await fetch(f.audio.src)).arrayBuffer()).slice(44)
      const expectedPcm = new Uint8Array(originalPcm.reduce((total, part) => total + part.length, 0))
      let sampleOffset = 0
      for (const part of originalPcm) {
        expectedPcm.set(part, sampleOffset)
        sampleOffset += part.length
      }
      assert.deepEqual(mergedPcm, expectedPcm, 'lip-sync calibration does not modify playback PCM or gain')

      await f.audio.play()
      const secondStart = clips[0].samples.length / clips[0].sampleRate
      for (const clipIndex of [0, 1, 0, 1, 0]) {
        const start = clipIndex === 0 ? 0 : secondStart
        for (const [timeIndex, time] of times.entries()) {
          f.tick(start + time)
          assert.deepEqual(f.events.mouth.at(-1), originalTracks[clipIndex][timeIndex],
            `${engine}: seek to clip ${clipIndex + 1} at ${time}s preserves its original frame`)
        }
      }
      f.tick(secondStart - 0.005)
      assert.deepEqual(f.events.mouth.at(-1), [0, 0], 'silence before the non-frame-aligned join stays closed')
      f.tick(secondStart)
      assert.deepEqual(f.events.mouth.at(-1), [0, 0], 'the next clip does not inherit the previous mouth state')
      f.tick(secondStart + clips[1].samples.length / clips[1].sampleRate)
      assert.deepEqual(f.events.mouth.at(-1), [0, 0], 'exact merged end is closed')
      assert.equal(nextClip, 2, 'player replay and seeking never synthesize another clip')
      assert.equal(f.utterances.length, 0)
    }
    finally { f.close() }
  }
})

test('pause, resume and cancellation keep the cached mouth track closed while stopped', async () => {
  const current = shapedClip(0.006, 8260)
  const f = fixture(async () => ({ async *stream() {
    yield { audio: { data: current.samples, sampling_rate: current.sampleRate } }
  } }))
  try {
    await f.controller.speak('小声说一句。')
    f.tick(0.087)
    const activeMouth = f.events.mouth.at(-1)
    assert.ok(activeMouth[0] > 0.1)
    f.audio.pause()
    assert.deepEqual(f.events.mouth.at(-1), [0, 0])
    const paused = structuredClone(f.events)
    f.tick(0.061)
    assert.deepEqual(f.events, paused, 'a paused seek cannot reopen the mouth')
    await f.audio.play()
    assert.notDeepEqual(f.events.mouth.at(-1), [0, 0], 'resume uses the real current time')
    f.tick(0.087)
    assert.deepEqual(f.events.mouth.at(-1), activeMouth)
    f.controller.cancel()
    assert.deepEqual(f.events.mouth.at(-1), [0, 0])
    const canceled = structuredClone(f.events)
    f.tick(0.087)
    for (const event of ['playing', 'pause', 'ended', 'error']) f.audio.dispatchEvent(new Event(event))
    assert.deepEqual(f.events, canceled, 'late frames and media events cannot reuse canceled tracks')
    assert.equal(f.audio.src, '')
  }
  finally { f.close() }
})

test('a stationary playable media clock closes speaking once and resumes from real advancement without replay', async () => {
  let generated = 0
  const current = shapedClip(0.006, 24000 * 6, 24000)
  const f = fixture(undefined, { async synthesizeCloud() { generated++; return current } })
  try {
    await f.controller.speak('已经缓存的一句。', 'happy', undefined, [], 'cloud')
    f.audio.end()
    await f.audio.play()
    const source = f.audio.src, loads = f.audio.loads, plays = f.audio.plays
    const baseline = 100_000
    for (const elapsed of [0, 500, 1000, 1499]) {
      f.tick(0.12, baseline + elapsed)
      assert.equal(f.events.playing.at(-1), true)
      assert.ok(f.events.mouth.at(-1)[0] > 0.1)
    }
    f.tick(0.12, baseline + 1500)
    assert.equal(f.audio.paused, false)
    assert.equal(f.audio.readyState, 4)
    assert.equal(f.audio.seeking, false)
    assert.equal(f.events.playing.at(-1), false)
    assert.equal(f.events.preparing.at(-1), true)
    assert.deepEqual(f.events.mouth.at(-1), [0, 0])
    assert.equal(f.queuedFrames(), 1, 'keep one observer, not a dead stopped animation')
    const stalled = structuredClone(f.events)
    f.tick(0.12, baseline + 2000)
    f.tick(0.12, baseline + 2500)
    assert.deepEqual(f.events, stalled, 'stationary observations do not repeatedly write UI')
    for (const event of ['playing', 'timeupdate', 'canplay', 'seeked'])
      f.audio.dispatchEvent(new Event(event))
    assert.deepEqual(f.events, stalled, 'native events alone cannot reopen a clock-stalled source')
    assert.equal(f.queuedFrames(), 1)
    // A fresh baseline after a long RAF gap, even at a different media time,
    // cannot claim recovery; a subsequently observed forward step can.
    f.tick(0.2, baseline + 5000)
    assert.deepEqual(f.events, stalled)
    f.tick(0.3, baseline + 5500)
    assert.equal(f.events.playing.at(-1), true)
    assert.equal(f.events.preparing.at(-1), false)
    assert.ok(f.events.mouth.at(-1)[0] > 0.1)
    assert.equal(f.audio.src, source)
    assert.equal(f.audio.loads, loads)
    assert.equal(f.audio.plays, plays)
    assert.equal(generated, 1, 'clock recovery never resynthesizes the cache')
    assert.equal(f.queuedFrames(), 1)
  }
  finally { f.close() }
})

test('quantized advancing playback at low FPS and long healthy RAF gaps never manufacture a stall', async () => {
  const current = shapedClip(0.006, 24000 * 12, 24000)
  const f = fixture(undefined, { async synthesizeCloud() { return current } })
  try {
    await f.controller.speak('正常在播放。', 'neutral', undefined, [], 'cloud')
    const baseline = 100_000
    for (let frame = 0; frame <= 18; frame++) {
      const timestamp = frame * 500
      f.tick(Math.floor(timestamp / 100) / 10, baseline + timestamp)
      assert.equal(f.events.playing.at(-1), true, '2 FPS with 100 ms quantization')
      assert.equal(f.events.preparing.at(-1), false)
      assert.equal(f.queuedFrames(), 1)
    }
    f.tick(10, baseline + 20_000)
    f.tick(10.1, baseline + 20_500)
    assert.equal(f.events.playing.at(-1), true, 'background return establishes a healthy baseline')
    assert.equal(f.events.preparing.at(-1), false)
  }
  finally { f.close() }
})

test('a clock stall revokes local and cloud generation permission without skipping the waiting sentence', { timeout: 1000 }, async () => {
  for (const engine of ['local', 'cloud']) {
    const calls = []
    const f = fixture(async () => ({ async *stream(text) { calls.push(text); yield clip() } }), {
      async synthesizeCloud(sentence) { calls.push(sentence.text); return cloudClip() },
    })
    try {
      f.audio.addEventListener('playing', () => { stallAt(f, 0.05) }, { once: true })
      const speaking = f.controller.speak('一。二。三。', 'neutral', undefined, [], engine)
      await settle()
      assert.deepEqual(calls, ['一。'])
      assert.equal(f.events.playing.at(-1), false)
      for (let index = 0; index < 3; index++) await settle()
      assert.equal(calls.length, 1, 'do not busy-loop or compute/fetch after stalled permission')
      f.tick(0.06, 102_000)
      await settle()
      assert.deepEqual(calls, engine === 'cloud' ? ['一。', '二。'] : ['一。', '二。', '三。'])
      assert.equal(f.events.playing.at(-1), true)
      f.audio.end()
      await settle()
      await speaking
      assert.deepEqual(calls, ['一。', '二。', '三。'], 'retain the exact original sentence order')
    }
    finally { f.close() }
  }
})

test('an in-flight result may finish at a clock stall but cannot start another local computation', { timeout: 1000 }, async () => {
  const second = deferred()
  let computed = 0
  const f = fixture(async () => ({ async *stream() {
    for (let index = 0; index < 3; index++) {
      computed++
      yield index === 1 ? await second.promise : clip()
    }
  } }))
  try {
    const speaking = f.controller.speak('一个输入，三段。')
    await settle()
    assert.equal(computed, 2)
    stallAt(f, 0.05)
    second.resolve(clip())
    for (let index = 0; index < 3; index++) await settle()
    assert.equal(computed, 2)
    assert.equal(f.events.playing.at(-1), false)
    f.tick(0.06, 102_000)
    await speaking
    assert.equal(computed, 3)
  }
  finally { f.close() }
})

test('pause, wait and seek retire the stalled observer and reset its baseline for verified playback intent', async () => {
  for (const method of ['pause', 'waiting', 'seeking']) {
    const f = fixture(undefined, { async synthesizeCloud() { return cloudClip() } })
    try {
      await f.controller.speak('一。', 'neutral', undefined, [], 'cloud')
      stallAt(f, 0.05)
      const oldFrame = f.frameCallbacks()[0]
      if (method === 'pause') f.audio.pause()
      else {
        if (method === 'waiting') f.audio.readyState = 2
        else f.audio.seeking = true
        f.audio.dispatchEvent(new Event(method))
      }
      assert.equal(f.queuedFrames(), 0)
      const stopped = structuredClone(f.events)
      oldFrame(102_000)
      assert.deepEqual(f.events, stopped)
      assert.equal(f.queuedFrames(), 0)
      if (method === 'pause') await f.audio.play()
      else {
        f.audio.readyState = 4
        f.audio.seeking = false
        f.audio.dispatchEvent(new Event(method === 'seeking' ? 'seeked' : 'playing'))
      }
      assert.equal(f.events.playing.at(-1), true)
      f.tick(0.05, 102_000)
      f.tick(0.05, 102_500)
      assert.equal(f.events.playing.at(-1), true, 'old stall duration cannot leak across interruption')
      assert.equal(f.queuedFrames(), 1)
    }
    finally { f.close() }
  }
})

test('cancel, dispose and media error release a clock-stalled local or cloud waiter and queued RAF', { timeout: 1000 }, async () => {
  for (const engine of ['local', 'cloud']) {
    for (const method of ['cancel', 'dispose', 'error']) {
      const calls = []
      const f = fixture(async () => ({ async *stream(text) { calls.push(text); yield clip() } }), {
        async synthesizeCloud(sentence) { calls.push(sentence.text); return cloudClip() },
      })
      try {
        f.audio.addEventListener('playing', () => { stallAt(f, 0.05) }, { once: true })
        const speaking = f.controller.speak('一。二。三。', 'neutral', undefined, [], engine)
        await settle()
        const oldFrames = f.frameCallbacks()
        if (method === 'error') {
          f.audio.error = { code: 3 }
          f.audio.dispatchEvent(new Event('error'))
        }
        else f.controller[method]()
        await speaking
        assert.deepEqual(calls, ['一。'])
        assert.equal(f.queuedFrames(), 0)
        assert.equal(f.audio.src, '')
        const canceled = structuredClone(f.events)
        for (const callback of oldFrames) callback(102_000)
        for (const event of ['playing', 'waiting', 'seeked', 'ended']) f.audio.dispatchEvent(new Event(event))
        assert.deepEqual(f.events, canceled)
        assert.equal(f.queuedFrames(), 0)
      }
      finally { f.close() }
    }
  }
})

test('already-queued RAF cannot touch replacement chunks, full cache or a newer turn', async () => {
  const f = fixture(async () => ({ async *stream() { yield clip() } }))
  try {
    await f.controller.speak('第一句。第二句。', 'happy', undefined, [{ start: 4, delivery: 'soft' }])
    const firstSource = f.audio.src, firstFrames = f.frameCallbacks()
    f.audio.end()
    assert.notEqual(f.audio.src, firstSource)
    f.tick(0.05, 100_000)
    const secondState = structuredClone(f.events), secondFrames = f.frameCallbacks()
    for (const callback of firstFrames) callback(102_000)
    assert.deepEqual(f.events, secondState)
    assert.equal(f.queuedFrames(), 1)
    f.audio.end()
    assert.equal(f.queuedFrames(), 0, 'full-cache replacement remains paused')
    const cacheState = structuredClone(f.events)
    for (const callback of secondFrames) callback(102_000)
    assert.deepEqual(f.events, cacheState)
    assert.equal(f.queuedFrames(), 0)
    await f.audio.play()
    const cacheFrames = f.frameCallbacks()
    await f.controller.speak('新的回复。', 'curious')
    f.tick(0.05, 100_000)
    const fresh = structuredClone(f.events)
    for (const callback of cacheFrames) callback(102_000)
    assert.deepEqual(f.events, fresh)
    assert.equal(f.queuedFrames(), 1)
    stallAt(f, 0.05, 101_000)
    assert.equal(f.events.playing.at(-1), false, 'an old callback cannot reset the new clock')
  }
  finally { f.close() }
})

test('stall and recovery UI callbacks can start a fresh turn without stale writes or a second RAF', async () => {
  for (const phase of ['stall', 'recovery']) {
    const callbackNames = phase === 'stall' ? ['mouth', 'playing', 'preparing'] : ['playing', 'preparing']
    for (const callbackName of callbackNames) {
      let f, armed = false, snapshot, replaced = false
      const override = (name, value) => {
        f.events[name].push(value)
        const trigger = phase === 'stall'
          ? (name === 'mouth' ? value[0] === 0 : value === (name === 'preparing'))
          : value === (name === 'playing')
        if (!armed || !trigger) return
        armed = false
        replaced = true
        void f.controller.speak('新的一轮。', 'curious', undefined, [], 'browser')
        snapshot = structuredClone(f.events)
      }
      f = fixture(undefined, { async synthesizeCloud() { return cloudClip() } }, {
        [`on${callbackName[0].toUpperCase()}${callbackName.slice(1)}`]: callbackName === 'mouth'
          ? (open, form) => override('mouth', [open, form])
          : value => override(callbackName, value),
      })
      try {
        await f.controller.speak('原来的一轮。', 'happy', undefined, [], 'cloud')
        if (phase === 'stall') { armed = true; stallAt(f, 0.05) }
        else { stallAt(f, 0.05); armed = true; f.tick(0.06, 102_000) }
        assert.equal(replaced, true, `${phase}/${callbackName}`)
        assert.deepEqual(f.events, snapshot, 'no remaining old callback may overwrite new preparation')
        assert.equal(f.queuedFrames(), 0, 'the retired observer cannot schedule another frame')
        await settle()
        assert.equal(f.utterances.length, 1)
        f.utterances[0].onstart()
        assert.equal(f.events.delivery.at(-1), 'curious')
        assert.equal(f.events.playing.at(-1), true)
        assert.deepEqual(f.events.mouth.at(-1), [null, 0])
      }
      finally { f.close() }
    }
  }
})

test('ended cleanup callbacks may restart the same source without an old ending advancing the reply', async () => {
  for (const callbackName of ['mouth', 'playing', 'preparing']) {
    let f, armed = false, restarted = false
    const override = (name, value) => {
      f.events[name].push(value)
      if (!armed) return
      armed = false
      restarted = true
      void f.audio.play()
    }
    f = fixture(async () => ({ async *stream() { yield clip() } }), {}, {
      [`on${callbackName[0].toUpperCase()}${callbackName.slice(1)}`]: callbackName === 'mouth'
        ? (open, form) => override('mouth', [open, form])
        : value => override(callbackName, value),
    })
    try {
      await f.controller.speak('第一句。第二句。', 'happy', undefined, [{ start: 4, delivery: 'soft' }])
      f.tick(0.05, 100_000)
      const source = f.audio.src, loads = f.audio.loads, plays = f.audio.plays
      const oldFrames = f.frameCallbacks()
      armed = true
      f.audio.end()
      assert.equal(restarted, true)
      assert.equal(f.audio.ended, false)
      assert.equal(f.audio.src, source, 'an old ended event must not steal a same-source restart')
      assert.equal(f.audio.loads, loads)
      assert.equal(f.audio.plays, plays + 1)
      assert.equal(f.events.playing.at(-1), true)
      assert.ok(f.events.mouth.at(-1)[0] > 0.1)
      assert.equal(f.queuedFrames(), 1)
      const restartedState = structuredClone(f.events)
      for (const callback of oldFrames) callback(102_000)
      assert.deepEqual(f.events, restartedState)
      f.audio.end()
      assert.notEqual(f.audio.src, source, 'a later genuine end still advances to the queued sentence')
      assert.equal(f.events.delivery.at(-1), 'soft')
    }
    finally { f.close() }
  }
})

test('mouth and delivery RAF callbacks cannot keep animating after replacing their source', async () => {
  for (const callbackName of ['mouth', 'delivery']) {
    let f, armed = false, snapshot
    const override = (name, value) => {
      f.events[name].push(value)
      if (!armed) return
      armed = false
      f.controller.cancel()
      snapshot = structuredClone(f.events)
    }
    f = fixture(async () => ({ async *stream() { yield clip() } }), {}, {
      [`on${callbackName[0].toUpperCase()}${callbackName.slice(1)}`]: callbackName === 'mouth'
        ? (open, form) => override('mouth', [open, form])
        : value => override('delivery', value),
    })
    try {
      await f.controller.speak('第一句。第二句。', 'happy', undefined, [{ start: 4, delivery: 'soft' }])
      f.audio.end()
      f.audio.end()
      await f.audio.play()
      armed = true
      f.tick(0.15, 100_000)
      assert.equal(armed, false)
      assert.deepEqual(f.events, snapshot)
      assert.equal(f.queuedFrames(), 0)
      assert.equal(f.audio.src, '')
    }
    finally { f.close() }
  }
})

test('media waiting closes the mouth and speaking state until current-source playback actually resumes', async () => {
  const f = fixture(async () => ({ async *stream() { yield clip() } }))
  try {
    await f.controller.speak('缓存里的语音。')
    f.tick(0.05)
    const opening = f.events.mouth.at(-1)
    assert.ok(opening[0] > 0.1)
    const source = f.audio.src
    const cached = await (await fetch(source)).arrayBuffer()
    const playRequests = f.audio.plays
    f.audio.readyState = 2
    f.audio.dispatchEvent(new Event('waiting'))
    assert.equal(f.audio.paused, false, 'waiting does not remove media playback intent')
    assert.deepEqual(f.events.mouth.at(-1), [0, 0])
    assert.equal(f.events.playing.at(-1), false)
    assert.equal(f.events.preparing.at(-1), true)
    const stopped = structuredClone(f.events)
    f.tick(0.05)
    f.audio.dispatchEvent(new Event('playing'))
    assert.deepEqual(f.events, stopped, 'an event without future media data cannot reopen the mouth')
    f.audio.readyState = 4
    f.audio.dispatchEvent(new Event('seeked'))
    assert.deepEqual(f.events, stopped, 'an unrelated seeked event cannot resume a wait')
    f.audio.dispatchEvent(new Event('playing'))
    assert.deepEqual(f.events.mouth.at(-1), opening)
    assert.equal(f.events.playing.at(-1), true)
    assert.equal(f.events.preparing.at(-1), false)
    assert.equal(f.audio.src, source)
    assert.equal(f.audio.plays, playRequests, 'recovery never starts a new source or requests replay')
    assert.deepEqual(await (await fetch(f.audio.src)).arrayBuffer(), cached, 'cached PCM stays exact')
  }
  finally { f.close() }
})

test('active buffered seeking suspends expression and mouth, then resumes from the actual cached time', async () => {
  let generated = 0
  const f = fixture(async () => ({ async *stream() { generated++; yield clip() } }))
  try {
    await f.controller.speak('第一句。第二句。', 'happy', undefined, [{ start: 4, delivery: 'soft' }])
    f.audio.end()
    f.audio.end()
    await f.audio.play()
    f.tick(0.15)
    assert.equal(f.events.delivery.at(-1), 'soft')
    const source = f.audio.src
    const loads = f.audio.loads
    const plays = f.audio.plays
    f.audio.seeking = true
    f.audio.currentTime = 0.05
    f.audio.dispatchEvent(new Event('seeking'))
    assert.deepEqual(f.events.mouth.at(-1), [0, 0])
    assert.equal(f.events.playing.at(-1), false)
    assert.equal(f.events.preparing.at(-1), true)
    const seeking = structuredClone(f.events)
    f.tick(0.05)
    f.audio.dispatchEvent(new Event('playing'))
    f.audio.dispatchEvent(new Event('seeked'))
    assert.deepEqual(f.events, seeking, 'a seek still decoding cannot restore speaking')
    f.audio.seeking = false
    f.audio.dispatchEvent(new Event('seeked'))
    assert.equal(f.events.delivery.at(-1), 'happy')
    assert.ok(f.events.mouth.at(-1)[0] > 0.1)
    assert.equal(f.events.playing.at(-1), true)
    assert.equal(f.events.preparing.at(-1), false)
    assert.equal(f.audio.src, source)
    assert.equal(f.audio.loads, loads)
    assert.equal(f.audio.plays, plays, 'buffered seeked recovery does not call play again')
    assert.equal(generated, 2, 'cached seeking never resynthesizes')

    f.audio.pause()
    f.audio.seeking = true
    f.audio.dispatchEvent(new Event('seeking'))
    f.audio.currentTime = 0.15
    f.audio.seeking = false
    f.audio.dispatchEvent(new Event('seeked'))
    assert.deepEqual(f.events.mouth.at(-1), [0, 0])
    assert.equal(f.events.playing.at(-1), false, 'paused seek cannot restore playback intent')
    assert.equal(f.events.preparing.at(-1), false)
    await f.audio.play()
    assert.equal(f.events.delivery.at(-1), 'soft')
    assert.ok(f.events.mouth.at(-1)[0] > 0.1)
  }
  finally { f.close() }
})

test('a seek with unavailable future data remains closed until a later verified playing event', async () => {
  const f = fixture(async () => ({ async *stream() { yield clip() } }))
  try {
    await f.controller.speak('这句还在缓冲。')
    f.tick(0.05)
    f.audio.seeking = true
    f.audio.dispatchEvent(new Event('seeking'))
    f.audio.readyState = 2
    f.audio.seeking = false
    f.audio.dispatchEvent(new Event('seeked'))
    assert.deepEqual(f.events.mouth.at(-1), [0, 0])
    assert.equal(f.events.playing.at(-1), false)
    f.audio.dispatchEvent(new Event('playing'))
    assert.equal(f.events.playing.at(-1), false)
    f.audio.readyState = 4
    f.audio.dispatchEvent(new Event('playing'))
    assert.ok(f.events.mouth.at(-1)[0] > 0.1)
    assert.equal(f.events.playing.at(-1), true)
  }
  finally { f.close() }
})

test('queued RAF reads seek and ready state before media events can freeze an open mouth', async () => {
  for (const interruption of ['waiting', 'seeking']) {
    const f = fixture(async () => ({ async *stream() { yield clip() } }))
    try {
      await f.controller.speak('一句语音。')
      f.tick(0.05)
      assert.ok(f.events.mouth.at(-1)[0] > 0.1)
      if (interruption === 'waiting') f.audio.readyState = 2
      else f.audio.seeking = true
      f.tick(0.05)
      assert.deepEqual(f.events.mouth.at(-1), [0, 0])
      assert.equal(f.events.playing.at(-1), false)
      const stopped = structuredClone(f.events)
      f.tick(0.06)
      assert.deepEqual(f.events, stopped, 'suspended RAF does not schedule further mouth updates')
      if (interruption === 'seeking') {
        // A short buffered seek can finish before its queued seeking task is
        // delivered. The RAF-observed current-source seek still pairs seeked.
        f.audio.seeking = false
        f.audio.dispatchEvent(new Event('seeking'))
        assert.deepEqual(f.events, stopped)
        f.audio.dispatchEvent(new Event('seeked'))
        assert.equal(f.events.playing.at(-1), true)
        assert.ok(f.events.mouth.at(-1)[0] > 0.1)
      }
    }
    finally { f.close() }
  }
})

test('waiting and seeking revoke a yielded local or cloud permit without skipping the same input', { timeout: 1000 }, async () => {
  for (const engine of ['local', 'cloud']) {
    for (const interruption of ['waiting', 'seeking']) {
      const calls = []
      const f = fixture(async () => ({ async *stream(text) { calls.push(text); yield clip() } }), {
        async synthesizeCloud(sentence) { calls.push(sentence.text); return cloudClip() },
      })
      try {
        f.audio.addEventListener('playing', () => {
          let microtasks = Promise.resolve()
          for (let index = 0; index < 4; index++) microtasks = microtasks.then(() => {})
          void microtasks.then(() => {
            if (interruption === 'waiting') f.audio.readyState = 2
            else f.audio.seeking = true
            f.audio.dispatchEvent(new Event(interruption))
          })
        }, { once: true })
        const speaking = f.controller.speak('一。二。三。', 'neutral', undefined, [], engine)
        await settle()
        assert.deepEqual(calls, ['一。'], `${engine}/${interruption}: cannot start after a revoked permit`)
        assert.equal(f.audio.paused, false)
        assert.equal(f.events.playing.at(-1), false)
        for (let index = 0; index < 3; index++) await settle()
        assert.equal(calls.length, 1, 'interruption cannot buy or compute ahead, or busy-loop')
        f.audio.readyState = 4
        f.audio.seeking = false
        f.audio.dispatchEvent(new Event(interruption === 'seeking' ? 'seeked' : 'playing'))
        await settle()
        assert.deepEqual(calls, engine === 'cloud' ? ['一。', '二。'] : ['一。', '二。', '三。'],
          'resuming keeps the exact sentence and original lookahead cap')
        f.audio.end()
        await settle()
        await speaking
        assert.deepEqual(calls, ['一。', '二。', '三。'])
      }
      finally { f.close() }
    }
  }
})

test('cancel, dispose and media errors release interrupted local and cloud waiters without further generation', { timeout: 1000 }, async () => {
  for (const engine of ['local', 'cloud']) {
    for (const method of ['cancel', 'dispose', 'error']) {
      const calls = []
      let iteratorClosed = false
      const f = fixture(async () => ({ async *stream(text) {
        try { calls.push({ text }); yield clip() }
        finally { iteratorClosed = true }
      } }), { async synthesizeCloud(sentence, signal) { calls.push({ text: sentence.text, signal }); return cloudClip() } })
      try {
        f.audio.addEventListener('playing', () => {
          f.audio.readyState = 2
          f.audio.dispatchEvent(new Event('waiting'))
        }, { once: true })
        const speaking = f.controller.speak('一。二。三。', 'neutral', undefined, [], engine)
        await settle()
        assert.equal(calls.length, 1)
        if (method === 'error') {
          f.audio.error = { code: 3 }
          f.audio.dispatchEvent(new Event('error'))
        }
        else f.controller[method]()
        await speaking
        assert.equal(calls.length, 1)
        if (engine === 'local') assert.equal(iteratorClosed, true)
        else assert.ok(calls[0].signal.aborted)
        assert.equal(f.audio.src, '')
        assert.deepEqual(f.events.mouth.at(-1), [0, 0])
        const stopped = structuredClone(f.events)
        f.audio.readyState = 4
        f.audio.seeking = false
        for (const event of ['playing', 'waiting', 'seeking', 'seeked', 'pause', 'ended', 'error'])
          f.audio.dispatchEvent(new Event(event))
        assert.deepEqual(f.events, stopped, 'late recovery events cannot reopen canceled audio')
      }
      finally { f.close() }
    }
  }
})

test('stale interruption and seek-completion events cannot disturb the new playable source', async () => {
  const f = fixture(async () => ({ async *stream() { yield clip() } }))
  try {
    await f.controller.speak('旧回复。', 'happy')
    f.audio.seeking = true
    f.audio.dispatchEvent(new Event('seeking'))
    await f.controller.speak('新回复。', 'soft')
    f.tick(0.05)
    const current = structuredClone(f.events)
    for (const event of ['waiting', 'seeking', 'seeked']) f.audio.dispatchEvent(new Event(event))
    assert.deepEqual(f.events, current, 'events are checked against current state and current seek source')
    f.controller.cancel()
    const canceled = structuredClone(f.events)
    f.audio.seeking = true
    f.audio.readyState = 2
    for (const event of ['waiting', 'seeking', 'seeked']) f.audio.dispatchEvent(new Event(event))
    assert.deepEqual(f.events, canceled)
  }
  finally { f.close() }
})

test('canceling a waiting stream cannot enqueue old speech into the next turn', async () => {
  const calls = []
  const f = fixture(async () => ({ async *stream(text) { calls.push(text); yield clip() } }))
  try {
    const old = f.controller.beginStream('', 'happy')
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
    const oldSpeaking = f.controller.speak('旧回复。', 'happy')
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
    const input = f.controller.beginStream('', 'happy')
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
    const first = f.controller.beginStream('', 'happy')
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
        const input = f.controller.beginStream('', 'happy', undefined, engine)
        for (const char of text) input.push(char)
        input.setDelivery('soft')
        input.finish()
        await settle()
        await f.controller.speak(text, 'happy', undefined, [], engine)
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
    const old = f.controller.beginStream('', 'happy')
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
    f.utterances[1].onstart()
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
    f.utterances[0].onstart()
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

    const input = f.controller.beginStream('', 'happy', undefined, 'browser')
    input.push('轻量回复。')
    input.finish()
    await settle()
    assert.equal(f.utterances[1].text, '轻量回复。')
    assert.deepEqual(f.events.delivery, ['soft'])
    f.utterances[1].onstart()
    f.utterances[1].onend()
    await settle()
    assert.deepEqual(f.events.delivery, ['soft', 'happy'])
    assert.deepEqual(f.events.state, ['browser', 'browser'])
    assert.equal(loads, 0)
    assert.equal(cloudCalls, 0)
    assert.equal(f.audio.src, '')
    assert.equal(f.events.preparing.at(-1), false)
    assert.equal(f.events.ready.at(-1), false)
  }
  finally { f.close() }
})

test('browser end without a start reports unconfirmed playback and stops direct/fallback queued speech', { timeout: 1000 }, async () => {
  for (const engine of ['browser', 'local', 'cloud']) {
    for (const playback of ['stream', 'replay']) {
      let loads = 0, cloudCalls = 0
      const f = fixture(async () => { loads++; throw new Error('test: local voice unavailable') }, {
        async synthesizeCloud() { cloudCalls++; throw new SpeechApiError('rate_limited', 429) },
      })
      try {
        let speaking
        if (playback === 'replay')
          speaking = f.controller.speak('第一句。不能自动继续。', 'happy', undefined, [], engine)
        else {
          const input = f.controller.beginStream('', 'happy', undefined, engine)
          input.push('第一句。不能自动继续。')
          input.finish()
        }
        await settle()
        const first = f.utterances[0]
        assert.ok(first)
        const work = { loads, cloudCalls }
        const pending = structuredClone(f.events)
        first.onresume()
        first.onpause()
        assert.deepEqual(f.events, pending, 'events before start cannot pretend audio has begun')
        first.onend()
        await settle()
        assert.equal(f.utterances.length, 1, 'end without start must not enqueue another sentence')
        await speaking
        assert.equal(f.events.playing.at(-1), false)
        assert.equal(f.events.preparing.at(-1), false)
        assert.deepEqual(f.events.mouth.at(-1), [0, 0])
        assert.deepEqual(f.events.delivery, [])
        assert.equal(f.events.problem.at(-1), '系统语音未确认开始播放，请更换语音模式或检查浏览器与系统声线。')
        assert.deepEqual({ loads, cloudCalls }, work, 'unconfirmed playback cannot retry providers or download a model')
        assert.equal(loads, engine === 'local' ? 1 : 0)
        assert.equal(cloudCalls, engine === 'cloud' ? 1 : 0)
        assert.equal(f.audio.src, '')
        assert.equal(f.audio.plays, 0)
        const stopped = structuredClone(f.events)
        first.onstart()
        first.onresume()
        first.onpause()
        first.onerror()
        first.onend()
        await settle()
        assert.deepEqual(f.events, stopped, 'finished no-start events cannot erase the warning or reopen the mouth')
        assert.equal(f.utterances.length, 1)
      }
      finally { f.close() }
    }
  }
})

test('browser resume before start is inert but a later genuine start enables pause/resume normally', async () => {
  let loads = 0, cloudCalls = 0
  const f = fixture(async () => { loads++; throw new Error('unexpected local model') }, {
    async synthesizeCloud() { cloudCalls++; throw new Error('unexpected cloud call') },
  })
  try {
    const speaking = f.controller.speak('先等开始，再继续。', 'soft', undefined, [], 'browser')
    await settle()
    const utterance = f.utterances[0]
    const pending = structuredClone(f.events)
    utterance.onresume()
    utterance.onpause()
    utterance.onresume()
    assert.deepEqual(f.events, pending)
    assert.equal(f.events.playing.at(-1), false)
    assert.deepEqual(f.events.mouth.at(-1), [0, 0])
    utterance.onstart()
    assert.equal(f.events.playing.at(-1), true)
    assert.deepEqual(f.events.mouth.at(-1), [null, 0])
    assert.equal(f.events.delivery.at(-1), 'soft')
    utterance.onpause()
    assert.deepEqual(f.events.mouth.at(-1), [0, 0])
    utterance.onresume()
    assert.deepEqual(f.events.mouth.at(-1), [null, 0])
    utterance.onend()
    await speaking
    assert.equal(f.events.playing.at(-1), false)
    assert.deepEqual(f.events.mouth.at(-1), [0, 0])
    assert.ok(f.events.problem.every(message => !message.includes('未确认开始播放')))
    assert.equal(loads, 0)
    assert.equal(cloudCalls, 0)
    assert.equal(f.utterances.length, 1)
  }
  finally { f.close() }
})

test('an unstarted old browser/fallback end cannot overwrite an active replacement turn', async () => {
  for (const engine of ['browser', 'local', 'cloud']) {
    let loads = 0, cloudCalls = 0
    const f = fixture(async () => { loads++; throw new Error('test: local voice unavailable') }, {
      async synthesizeCloud() { cloudCalls++; throw new SpeechApiError('rate_limited', 429) },
    })
    try {
      const oldSpeaking = f.controller.speak('旧句从未开始。', 'happy', undefined, [], engine)
      await settle()
      const old = f.utterances[0]
      const newSpeaking = f.controller.speak('新句已经开始。', 'soft', undefined, [], 'browser')
      await oldSpeaking
      await settle()
      const fresh = f.utterances[1]
      fresh.onstart()
      const before = structuredClone(f.events)
      const work = { loads, cloudCalls }
      old.onend()
      old.onresume()
      old.onpause()
      old.onerror()
      old.onstart()
      await settle()
      assert.deepEqual(f.events, before)
      assert.deepEqual({ loads, cloudCalls }, work)
      assert.equal(f.events.playing.at(-1), true)
      assert.equal(f.events.delivery.at(-1), 'soft')
      assert.deepEqual(f.events.mouth.at(-1), [null, 0])
      assert.ok(f.events.problem.every(message => !message.includes('未确认开始播放')))
      fresh.onend()
      await newSpeaking
    }
    finally { f.close() }
  }
})

test('browser error before start keeps its specific failure and late end/resume cannot replace it', async () => {
  let loads = 0, cloudCalls = 0
  const f = fixture(async () => { loads++; throw new Error('unexpected local model') }, {
    async synthesizeCloud() { cloudCalls++; throw new Error('unexpected cloud call') },
  })
  try {
    const speaking = f.controller.speak('失败一句。不要继续。', 'happy', undefined, [], 'browser')
    await settle()
    const first = f.utterances[0]
    first.onerror()
    const stopped = structuredClone(f.events)
    first.onend()
    first.onresume()
    first.onpause()
    first.onstart()
    assert.deepEqual(f.events, stopped)
    await speaking
    assert.equal(f.utterances.length, 1)
    assert.match(f.events.problem.at(-1), /浏览器语音播放失败/)
    assert.doesNotMatch(f.events.problem.at(-1), /未确认开始播放/)
    assert.equal(f.events.playing.at(-1), false)
    assert.equal(f.events.preparing.at(-1), false)
    assert.deepEqual(f.events.mouth.at(-1), [0, 0])
    assert.equal(loads, 0)
    assert.equal(cloudCalls, 0)
  }
  finally { f.close() }
})

test('browser pause/resume closes the mouth without completing a sentence or starting model/cloud work', async () => {
  let loads = 0, cloudCalls = 0
  const f = fixture(async () => { loads++; throw new Error('browser must remain lightweight') }, {
    async synthesizeCloud() { cloudCalls++; throw new Error('browser must not call cloud') },
  })
  try {
    const input = f.controller.beginStream('', 'happy', undefined, 'browser')
    input.push('第一句。')
    input.setDelivery('soft')
    input.push('第二句。')
    input.finish()
    await settle()
    const first = f.utterances[0]
    assert.ok(first)
    first.onstart()
    assert.equal(f.events.playing.at(-1), true)
    assert.deepEqual(f.events.mouth.at(-1), [null, 0])
    first.onpause()
    assert.equal(f.events.playing.at(-1), false)
    assert.equal(f.events.preparing.at(-1), false)
    assert.deepEqual(f.events.mouth.at(-1), [0, 0])
    await settle()
    assert.equal(f.utterances.length, 1, 'pause cannot complete the current sentence')
    first.onresume()
    assert.equal(f.events.playing.at(-1), true)
    assert.equal(f.events.preparing.at(-1), false)
    assert.deepEqual(f.events.mouth.at(-1), [null, 0])
    assert.equal(f.events.delivery.at(-1), 'happy', 'resume keeps the current audible cue')
    await settle()
    assert.equal(f.utterances.length, 1, 'resume cannot enqueue a second utterance')
    assert.equal(loads, 0)
    assert.equal(cloudCalls, 0)
    assert.equal(f.audio.plays, 0, 'browser events do not start the PCM player')
    first.onend()
    await settle()
    assert.equal(f.utterances.length, 2)
    assert.equal(f.events.delivery.at(-1), 'happy', 'the queued cue remains inaudible until its own start')
    const second = f.utterances[1]
    second.onstart()
    assert.equal(f.events.delivery.at(-1), 'soft')
    second.onpause()
    second.onresume()
    assert.equal(f.events.delivery.at(-1), 'soft')
    second.onend()
    await settle()
    assert.equal(f.events.playing.at(-1), false)
    assert.deepEqual(f.events.mouth.at(-1), [0, 0])
    assert.equal(f.events.preparing.at(-1), false)
    assert.equal(f.utterances.length, 2)
    assert.equal(loads, 0)
    assert.equal(cloudCalls, 0)
  }
  finally { f.close() }
})

test('local and cloud fallback pause/resume stays on its utterance without inference or request retries', async () => {
  for (const engine of ['local', 'cloud']) {
    for (const playback of ['stream', 'replay']) {
      let loads = 0, cloudCalls = 0
      const f = fixture(async () => { loads++; throw new Error('test: local voice unavailable') }, {
        async synthesizeCloud() { cloudCalls++; throw new SpeechApiError('rate_limited', 429) },
      })
      try {
        let speaking
        if (playback === 'replay')
          speaking = f.controller.speak('第一句。第二句。', 'soft', undefined, [], engine)
        else {
          const input = f.controller.beginStream('', 'soft', undefined, engine)
          input.push('第一句。第二句。')
          input.finish()
        }
        await settle()
        const first = f.utterances[0]
        assert.ok(first, `${engine} ${playback} must have entered browser fallback`)
        assert.equal(f.events.state.at(-1), 'fallback')
        assert.equal(loads, engine === 'local' ? 1 : 0)
        assert.equal(cloudCalls, engine === 'cloud' ? 1 : 0)
        const initialWork = { loads, cloudCalls }
        first.onstart()
        for (let cycle = 0; cycle < 2; cycle++) {
          first.onpause()
          assert.deepEqual(f.events.mouth.at(-1), [0, 0])
          assert.equal(f.events.playing.at(-1), false)
          assert.equal(f.events.preparing.at(-1), false)
          await settle()
          assert.equal(f.utterances.length, 1)
          first.onresume()
          assert.deepEqual(f.events.mouth.at(-1), [null, 0])
          assert.equal(f.events.playing.at(-1), true)
          assert.equal(f.events.delivery.at(-1), 'soft')
          assert.equal(f.events.preparing.at(-1), false)
          await settle()
          assert.equal(f.utterances.length, 1)
          assert.deepEqual({ loads, cloudCalls }, initialWork, 'pause/resume must not retry the unavailable provider')
        }
        assert.equal(f.audio.src, '')
        assert.equal(f.audio.plays, 0)
        first.onend()
        await settle()
        assert.equal(f.utterances.length, 2)
        f.utterances[1].onstart()
        f.utterances[1].onend()
        await speaking
        await settle()
        assert.deepEqual({ loads, cloudCalls }, initialWork)
        assert.equal(f.events.playing.at(-1), false)
        assert.deepEqual(f.events.mouth.at(-1), [0, 0])
      }
      finally { f.close() }
    }
  }
})

test('cancel/dispose makes late browser pause/resume callbacks inert without advancing queued sentences', async () => {
  for (const method of ['cancel', 'dispose']) {
    let loads = 0, cloudCalls = 0
    const f = fixture(async () => { loads++; throw new Error('unexpected model call') }, {
      async synthesizeCloud() { cloudCalls++; throw new Error('unexpected cloud call') },
    })
    try {
      const speaking = f.controller.speak('旧一。旧二。', 'happy', undefined, [], 'browser')
      await settle()
      const old = f.utterances[0]
      old.onstart()
      old.onpause()
      f.controller[method]()
      await speaking
      const stopped = structuredClone(f.events)
      old.onpause()
      old.onresume()
      old.onend()
      old.onerror()
      await settle()
      assert.deepEqual(f.events, stopped)
      assert.equal(f.utterances.length, 1)
      assert.equal(f.events.playing.at(-1), false)
      assert.deepEqual(f.events.mouth.at(-1), [0, 0])
      assert.equal(loads, 0)
      assert.equal(cloudCalls, 0)
    }
    finally { f.close() }
  }
})

test('old browser and fallback pause/resume cannot stop or relabel a replacement turn', async () => {
  for (const engine of ['browser', 'local', 'cloud']) {
    let loads = 0, cloudCalls = 0
    const f = fixture(async () => { loads++; throw new Error('test: no local voice') }, {
      async synthesizeCloud() { cloudCalls++; throw new SpeechApiError('rate_limited', 429) },
    })
    try {
      const oldSpeaking = f.controller.speak('旧回复。', 'happy', undefined, [], engine)
      await settle()
      const old = f.utterances[0]
      old.onstart()
      const newSpeaking = f.controller.speak('新回复。', 'soft', undefined, [], 'browser')
      await oldSpeaking
      await settle()
      const fresh = f.utterances[1]
      fresh.onstart()
      const before = structuredClone(f.events)
      const beforeWork = { loads, cloudCalls }
      old.onpause()
      old.onresume()
      await settle()
      assert.deepEqual(f.events, before)
      assert.deepEqual({ loads, cloudCalls }, beforeWork)
      assert.equal(f.events.delivery.at(-1), 'soft')
      assert.equal(f.events.playing.at(-1), true)
      assert.deepEqual(f.events.mouth.at(-1), [null, 0])
      fresh.onpause()
      assert.equal(f.events.playing.at(-1), false)
      fresh.onresume()
      assert.equal(f.events.playing.at(-1), true)
      assert.equal(f.events.delivery.at(-1), 'soft')
      fresh.onend()
      await newSpeaking
    }
    finally { f.close() }
  }
})

test('completed browser utterance pause/resume is inert before and during the next sentence of the same run', async () => {
  for (const engine of ['browser', 'local', 'cloud']) {
    const f = fixture(async () => { throw new Error('test: local voice unavailable') }, {
      async synthesizeCloud() { throw new SpeechApiError('rate_limited', 429) },
    })
    try {
      const speaking = f.controller.speak('一。二。', 'happy', undefined, [{ start: 2, delivery: 'soft' }], engine)
      await settle()
      const first = f.utterances[0]
      first.onstart()
      first.onend()
      const finished = structuredClone(f.events)
      first.onpause()
      first.onresume()
      assert.deepEqual(f.events, finished, 'completed events are inert before the next microtask')
      await settle()
      const second = f.utterances[1]
      second.onstart()
      const fresh = structuredClone(f.events)
      first.onpause()
      first.onresume()
      assert.deepEqual(f.events, fresh, 'same-run old events cannot alter the newer utterance')
      assert.equal(f.events.delivery.at(-1), 'soft')
      assert.equal(f.events.playing.at(-1), true)
      second.onend()
      await speaking
      const allFinished = structuredClone(f.events)
      second.onpause()
      second.onresume()
      await settle()
      assert.deepEqual(f.events, allFinished, 'the final completed utterance cannot reopen its mouth')
    }
    finally { f.close() }
  }
})

test('failed browser utterance ignores late pause/resume and never starts its next sentence', async () => {
  for (const engine of ['browser', 'local', 'cloud']) {
    let loads = 0, cloudCalls = 0
    const f = fixture(async () => { loads++; throw new Error('test: local voice unavailable') }, {
      async synthesizeCloud() { cloudCalls++; throw new SpeechApiError('rate_limited', 429) },
    })
    try {
      const speaking = f.controller.speak('失败一句。不能继续。', 'happy', undefined, [], engine)
      await settle()
      const failed = f.utterances[0]
      failed.onstart()
      failed.onpause()
      failed.onerror()
      const stopped = structuredClone(f.events)
      const beforeWork = { loads, cloudCalls }
      failed.onpause()
      failed.onresume()
      assert.deepEqual(f.events, stopped)
      await speaking
      const done = structuredClone(f.events)
      failed.onresume()
      failed.onpause()
      await settle()
      assert.deepEqual(f.events, done)
      assert.deepEqual({ loads, cloudCalls }, beforeWork)
      assert.equal(f.utterances.length, 1)
      assert.equal(f.events.playing.at(-1), false)
      assert.equal(f.events.preparing.at(-1), false)
      assert.deepEqual(f.events.mouth.at(-1), [0, 0])
      assert.match(f.events.problem.at(-1), /浏览器语音播放失败/)
    }
    finally { f.close() }
  }
})

test('cloud stream/replay preserve English, omit Markdown secrets and apply cues only on playback', async () => {
  const first = '**Hello Hiyori!**\n'
  const middle = '```js\nconsole.log("secret.");\n```\n[Rest with DeepSeek.](https://example.invalid/a_(b))\n'
  const last = '明天用 API Key?'
  const text = first + middle + last
  const cues = [
    { start: 0, delivery: 'happy' },
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
      let speaking
      if (playback === 'stream') {
        const input = f.controller.beginStream('', 'happy', undefined, 'cloud')
        input.push(first)
        input.setDelivery('soft')
        input.push(middle)
        input.setDelivery('curious')
        input.push(last)
        input.finish()
      }
      else {
        speaking = f.controller.speak(text, 'happy', undefined, cues, 'cloud')
      }
      await settle()
      assert.deepEqual(calls.map(({ text, delivery }) => ({ text, delivery })), [
        { text: 'Hello Hiyori!', delivery: 'happy' },
        { text: 'Rest with DeepSeek.', delivery: 'soft' },
      ])
      assert.ok(calls.every(call => call.signal instanceof AbortSignal && !call.signal.aborted))
      assert.equal(new Set(calls.map(call => call.signal)).size, 1)
      assert.equal(loads, 0)
      assert.equal(f.utterances.length, 0)
      assert.deepEqual(f.events.delivery, ['happy'])
      f.audio.end()
      assert.deepEqual(f.events.delivery, ['happy', 'soft'])
      await settle()
      await speaking
      assert.deepEqual(calls.map(({ text, delivery }) => ({ text, delivery })), [
        { text: 'Hello Hiyori!', delivery: 'happy' },
        { text: 'Rest with DeepSeek.', delivery: 'soft' },
        { text: '明天用 API Key?', delivery: 'curious' },
      ])
      f.audio.end()
      assert.deepEqual(f.events.delivery, ['happy', 'soft', 'curious'])
      f.audio.end()
      const wav = await (await fetch(f.audio.src)).arrayBuffer()
      assert.equal(wav.byteLength, 44 + 2400 * 3 * 2)
      await f.audio.play()
      f.tick(0.15)
      f.tick(0.25)
      f.tick(0.01)
      assert.deepEqual(f.events.delivery.slice(-4), ['happy', 'soft', 'curious', 'happy'])
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
      const oldSpeaking = f.controller.speak('旧云端回复。', 'happy', undefined, [], 'cloud')
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
      const oldSpeaking = f.controller.speak('旧本地回复。', 'happy')
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
      f.utterances[1].onstart()
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
    f.utterances[0].onstart()
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
        const input = f.controller.beginStream('', 'happy', undefined, 'cloud')
        input.push('第一句。第二句。第三句。')
        input.finish()
      }
      else await f.controller.speak('第一句。第二句。第三句。', 'happy', undefined, [], 'cloud')
      await settle()
      assert.deepEqual(calls, ['第一句。', '第二句。'])
      assert.equal(f.utterances.length, 0)
      assert.equal(loads, 0)
      assert.match(f.events.problem.at(-1), /后续语音生成中断/)
      assert.doesNotMatch(f.events.problem.at(-1), /private provider/)
      assert.deepEqual(f.events.delivery, ['happy'])
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

test('cloud lookahead is bounded to one queued clip and follows pause/resume and actual endings', async () => {
  const calls = []
  const f = fixture(undefined, { async synthesizeCloud(sentence) { calls.push(sentence.text); return cloudClip() } })
  try {
    const speaking = f.controller.speak('一。二。三。四。五。', 'neutral', undefined, [], 'cloud')
    await settle()
    assert.deepEqual(calls, ['一。', '二。'])
    f.audio.pause()
    for (let i = 0; i < 3; i++) await settle()
    assert.equal(calls.length, 2, 'pause cannot buy the remainder of the reply')
    await f.audio.play()
    await settle()
    assert.equal(calls.length, 2, 'resume alone does not free an existing queued clip')
    for (const count of [3, 4, 5]) {
      f.audio.end()
      await settle()
      assert.equal(calls.length, count)
    }
    await speaking
    f.audio.end()
    f.audio.end()
    const wav = await (await fetch(f.audio.src)).arrayBuffer()
    assert.equal(wav.byteLength, 44 + 2400 * 5 * 2)
  }
  finally { f.close() }
})

test('pausing during an in-flight cloud lookahead allows it to finish but cannot start another', async () => {
  const lookahead = deferred()
  const calls = []
  const f = fixture(undefined, { async synthesizeCloud(sentence) {
    calls.push(sentence.text)
    return calls.length === 2 ? lookahead.promise : cloudClip()
  } })
  try {
    const speaking = f.controller.speak('一。二。三。', 'neutral', undefined, [], 'cloud')
    await settle()
    assert.deepEqual(calls, ['一。', '二。'])
    f.audio.pause()
    lookahead.resolve(cloudClip())
    await settle()
    assert.deepEqual(calls, ['一。', '二。'])
    await f.audio.play()
    await settle()
    assert.equal(calls.length, 2, 'a completed queued clip still occupies lookahead capacity')
    f.audio.end()
    await settle()
    await speaking
    assert.deepEqual(calls, ['一。', '二。', '三。'])
  }
  finally { f.close() }
})

test('a real player error cancels a cloud capacity wait without generating more sentences', { timeout: 1000 }, async () => {
  const calls = []
  const f = fixture(undefined, { async synthesizeCloud(sentence, signal) {
    calls.push({ text: sentence.text, signal })
    return cloudClip()
  } })
  try {
    const speaking = f.controller.speak('一。二。三。', 'neutral', undefined, [], 'cloud')
    await settle()
    assert.equal(calls.length, 2)
    f.audio.error = { code: 3 }
    f.audio.dispatchEvent(new Event('error'))
    await speaking
    assert.equal(calls.length, 2)
    assert.ok(calls.every(call => call.signal.aborted))
    assert.equal(f.audio.src, '')
    assert.match(f.events.problem.at(-1), /音频文件无法播放/)
  }
  finally { f.close() }
})

test('pause between a resolved capacity check and fetch cannot buy or skip the waiting sentence', { timeout: 1000 }, async () => {
  const calls = []
  const f = fixture(undefined, { async synthesizeCloud(sentence) {
    calls.push({ text: sentence.text, paused: f.audio.paused })
    return cloudClip()
  } })
  try {
    f.audio.addEventListener('playing', () => {
      // Reproducibly land after the second sentence's successful capacity
      // check, but before its awaiting generator resumes to start fetch.
      let microtasks = Promise.resolve()
      for (let index = 0; index < 4; index++) microtasks = microtasks.then(() => {})
      void microtasks.then(() => f.audio.pause())
    }, { once: true })
    const speaking = f.controller.speak('一。二。三。', 'neutral', undefined, [], 'cloud')
    await settle()
    assert.equal(f.audio.paused, true)
    assert.deepEqual(calls.map(call => call.text), ['一。'])
    for (let index = 0; index < 3; index++) await settle()
    assert.equal(calls.length, 1, 'a revoked permit must suspend instead of buying or busy-looping')

    await f.audio.play()
    await settle()
    assert.deepEqual(calls.map(call => call.text), ['一。', '二。'], 'resuming must retain the exact waiting sentence')
    f.audio.end()
    await settle()
    await speaking
    assert.deepEqual(calls.map(call => call.text), ['一。', '二。', '三。'])
    assert.ok(calls.slice(1).every(call => !call.paused))
  }
  finally { f.close() }
})

test('blocked initial cloud playback buys only its first clip until a real playing event', async () => {
  const calls = []
  const f = fixture(undefined, { async synthesizeCloud(sentence) { calls.push(sentence.text); return cloudClip() } })
  try {
    const manualPlay = f.audio.play.bind(f.audio)
    f.audio.play = async () => { throw new DOMException('test: autoplay blocked', 'NotAllowedError') }
    const speaking = f.controller.speak('一。二。三。', 'neutral', undefined, [], 'cloud')
    await settle()
    assert.deepEqual(calls, ['一。'])
    assert.equal(f.audio.paused, true)
    assert.match(f.events.problem.at(-1), /自动播放被浏览器拦截/)
    // Even a spurious event before real playback must not release capacity.
    f.audio.dispatchEvent(new Event('playing'))
    await settle()
    assert.equal(calls.length, 1)
    f.audio.play = manualPlay
    await f.audio.play()
    await settle()
    assert.deepEqual(calls, ['一。', '二。'])
    f.audio.end()
    await settle()
    await speaking
    assert.deepEqual(calls, ['一。', '二。', '三。'])
  }
  finally { f.close() }
})

test('cancel and dispose release a cloud capacity wait without another paid request', { timeout: 1000 }, async () => {
  for (const method of ['cancel', 'dispose']) {
    const calls = []
    const f = fixture(undefined, { async synthesizeCloud(sentence, signal) { calls.push({ ...sentence, signal }); return cloudClip() } })
    try {
      const speaking = f.controller.speak('一。二。三。四。', 'neutral', undefined, [], 'cloud')
      await settle()
      assert.equal(calls.length, 2)
      f.controller[method]()
      const stopped = structuredClone(f.events)
      await speaking
      await settle()
      assert.equal(calls.length, 2)
      assert.ok(calls.every(call => call.signal.aborted))
      assert.deepEqual(f.events, stopped)
      assert.equal(f.audio.src, '')
    }
    finally { f.close() }
  }
})

test('replacing a cloud capacity wait keeps only the new turn active', { timeout: 1000 }, async () => {
  const calls = []
  const f = fixture(undefined, { async synthesizeCloud(sentence, signal) { calls.push({ ...sentence, signal }); return cloudClip() } })
  try {
    const old = f.controller.speak('旧一。旧二。旧三。', 'happy', undefined, [], 'cloud')
    await settle()
    const fresh = f.controller.speak('新一。新二。新三。', 'soft', undefined, [], 'cloud')
    await old
    await settle()
    assert.deepEqual(calls.map(call => call.text), ['旧一。', '旧二。', '新一。', '新二。'])
    assert.ok(calls.slice(0, 2).every(call => call.signal.aborted))
    assert.ok(calls.slice(2).every(call => !call.signal.aborted))
    f.audio.end()
    await settle()
    await fresh
    assert.equal(calls.at(-1).text, '新三。')
    assert.equal(f.events.delivery.at(-1), 'soft')
  }
  finally { f.close() }
})

test('a silent initial cloud clip cannot trigger paid attempts for later sentences', async () => {
  let calls = 0
  const f = fixture(undefined, { async synthesizeCloud() {
    calls++
    return { samples: new Float32Array(2400), sampleRate: 24000, words: [] }
  } })
  try {
    const input = f.controller.beginStream('', 'neutral', undefined, 'cloud')
    input.push('一。二。三。')
    input.finish()
    await settle()
    assert.equal(calls, 1)
    assert.equal(f.audio.src, '')
    assert.equal(f.utterances[0].text, '一。')
  }
  finally { f.close() }
})

test('completed immutable WAV snapshot stays null for a blocked second clip, then covers both clips after playback', async () => {
  // Deliberately injected PCM/audio events are offline state-machine evidence,
  // not real Kokoro or native-browser audition evidence.
  let calls = 0
  const f = fixture(async () => ({ async *stream() { calls++; yield clip() } }))
  try {
    assert.equal(f.controller.getCompletedAudioBlob(), null)
    const speaking = f.controller.speak('第一句。第二句。', 'neutral')
    await settle()
    await speaking
    assert.equal(calls, 2)
    assert.equal(f.controller.getCompletedAudioBlob(), null, 'synthesis completion alone is not full replay completion')
    const manualPlay = f.audio.play.bind(f.audio)
    f.audio.play = async () => { throw new DOMException('blocked second clip', 'NotAllowedError') }
    f.audio.end()
    await settle()
    assert.ok(f.audio.paused && !f.audio.ended && f.audio.currentTime === 0 && !f.events.preparing.at(-1),
      'the previous page heuristic would have accepted the blocked second source')
    const secondOnly = await (await fetch(f.audio.src)).arrayBuffer()
    assert.equal(new DataView(secondOnly).getUint32(40, true), 2400 * 2)
    assert.equal(f.controller.getCompletedAudioBlob(), null, 'a chunk source is never a completed snapshot')
    f.audio.play = manualPlay
    await f.audio.play()
    f.audio.end()
    await settle()
    const complete = f.controller.getCompletedAudioBlob()
    assert.ok(complete instanceof Blob)
    assert.equal(complete.type, 'audio/wav')
    assert.equal(complete.size, 44 + 4800 * 2)
    assert.equal(f.controller.getCompletedAudioBlob(), complete, 'getter exposes the same immutable snapshot, not a copy')
    const bytes = await complete.arrayBuffer()
    assert.deepEqual(await (await fetch(f.audio.src)).arrayBuffer(), bytes, 'snapshot exactly backs the full replay source')
    await f.audio.play()
    f.audio.pause()
    f.audio.currentTime = .05
    await f.audio.play()
    f.audio.end()
    assert.equal(f.controller.getCompletedAudioBlob(), complete)
    assert.equal(calls, 2, 'full replay, seek, pause and snapshot reads never regenerate')

    const next = f.controller.speak('新句。', 'neutral')
    assert.equal(f.controller.getCompletedAudioBlob(), null, 'new run immediately retires the old snapshot')
    await settle(); await next; f.audio.end(); await settle()
    assert.ok(f.controller.getCompletedAudioBlob())
    f.controller.cancel()
    assert.equal(f.controller.getCompletedAudioBlob(), null)
    assert.deepEqual(await complete.arrayBuffer(), bytes, 'previously returned immutable Blob remains usable after cancellation')
  }
  finally { f.close() }
})

test('partial synthesis replay and browser fallback cannot expose a completed audio snapshot', async () => {
  const partial = fixture(async () => ({ async *stream() { yield clip(); throw new Error('partial fixture') } }))
  try {
    await partial.controller.speak('部分。', 'neutral')
    partial.audio.end(); await settle()
    assert.ok(partial.audio.src, 'existing partial replay remains available to ordinary playback')
    assert.equal(partial.controller.getCompletedAudioBlob(), null)
    assert.match(partial.events.problem.at(-1), /后续语音生成中断/)
  }
  finally { partial.close() }
  const fallback = fixture(async () => { throw new Error('fixture loader unavailable') })
  try {
    const speaking = fallback.controller.speak('退回。', 'neutral')
    await settle()
    assert.equal(fallback.controller.getCompletedAudioBlob(), null)
    assert.equal(fallback.events.state.at(-1), 'fallback')
    fallback.utterances[0].onend()
    await speaking
    assert.equal(fallback.controller.getCompletedAudioBlob(), null)
  }
  finally { fallback.close() }
})

test('reentrant completion callbacks cannot retain or install an old completed snapshot', async () => {
  for (const callback of ['preparing', 'ready']) {
    let f, retired = false
    f = fixture(async () => ({ async *stream() { yield clip() } }), {}, {
      onPreparing(value) {
        if (callback === 'preparing' && !value && f?.audio.ended && !retired) {
          retired = true; f.controller.cancel()
        }
      },
      onAudioReady(value) {
        if (callback === 'ready' && value && f?.controller.getCompletedAudioBlob() && !retired) {
          retired = true; f.controller.cancel()
        }
      },
    })
    try {
      await f.controller.speak('一次。', 'neutral')
      f.audio.end(); await settle()
      assert.equal(retired, true)
      assert.equal(f.controller.getCompletedAudioBlob(), null)
      assert.equal(f.audio.src, '', 'canceled full cache cannot be installed by an older callback frame')
    }
    finally { f.close() }
  }
})

// Acts: a laugh, sigh or pause performed just before a sentence.
const int16 = samples => Int16Array.from(samples, sample => {
  const value = Math.max(-1, Math.min(1, sample))
  return Math.trunc(value < 0 ? value * 0x8000 : value * 0x7fff) || 0
})
const sourcePcm = async f => new Int16Array((await (await fetch(f.audio.src)).arrayBuffer()).slice(44))
const seekTo = (f, time) => {
  f.audio.seeking = true
  f.audio.currentTime = time
  f.audio.dispatchEvent(new Event('seeking'))
  f.audio.seeking = false
  f.audio.dispatchEvent(new Event('seeked'))
}

test('a local pause is exactly ACT_PAUSE_SECONDS of silence on its sentence\'s first clip, and fires once inside a joined source', async () => {
  const texts = []
  const acts = []
  const voiced = shapedClip(0.02, 2400, 24000).samples
  const f = fixture(async () => ({ async *stream(text) {
    texts.push(text)
    for (let index = 0; index < 2; index++)
      yield { audio: { data: voiced.slice(), sampling_rate: 24000 } }
  } }), {}, { onAct: act => acts.push(act) })
  const pause = Math.round(ACT_PAUSE_SECONDS * 24000)
  const silence = new Float32Array(pause)
  try {
    const speaking = f.controller.speak('先说一句。嗯，再说。', 'neutral', undefined, [], 'local', { acts: [{ start: 5, act: 'pause' }] })
    await settle()
    assert.deepEqual(texts, ['先说一句。', '嗯，再说。'], 'the act never reaches Kokoro as text')
    assert.deepEqual(await sourcePcm(f), int16(voiced))
    assert.deepEqual(acts, [])

    // The three ready clips share one source; the act clip is the second.
    f.audio.end()
    assert.deepEqual(await sourcePcm(f), int16([...voiced, ...silence, ...voiced, ...voiced]),
      'silence is prepended to the first clip of the pause sentence only')
    assert.deepEqual(acts, [])
    f.tick(0.05)
    assert.deepEqual(acts, [])
    f.tick(0.1)
    assert.deepEqual(acts, ['pause'], 'performed when playback reaches the joined clip')
    f.tick(0.3)
    assert.deepEqual(f.events.mouth.at(-1), [0, 0], 'the mouth stays closed through the pause')
    f.tick(0.6)
    assert.deepEqual(acts, ['pause'], 'once, not on every frame')

    seekTo(f, 0.02)
    f.tick(0.15)
    assert.deepEqual(acts, ['pause', 'pause'], 'a backward seek performs it again')
    seekTo(f, 0.55)
    f.tick(0.6)
    assert.deepEqual(acts, ['pause', 'pause'], 'a forward seek never performs what it skipped')

    f.audio.end()
    await speaking
    assert.deepEqual(await sourcePcm(f), int16([...voiced, ...voiced, ...silence, ...voiced, ...voiced]))
    assert.equal(texts.length, 2, 'replay never resynthesizes')
    await f.audio.play()
    f.tick(0.1)
    assert.deepEqual(acts, ['pause', 'pause'])
    f.tick(0.2)
    assert.deepEqual(acts, ['pause', 'pause', 'pause'], 'the full replay carries the act at its clip offset')
  }
  finally { f.close() }
})

test('a cloud pause sentence buys with its act, gains silence on that clip only and keeps provider beats on the words', async () => {
  const sampleRate = 24000, duration = 1.317
  const voiced = Float32Array.from({ length: Math.round(sampleRate * duration) }, (_, index) => {
    const time = index / sampleRate
    const envelope = Math.max(0, 1 - Math.abs(time - .25) / .08, 1 - Math.abs(time - .95) / .09)
    return .09 * envelope * Math.sin(time * Math.PI * 2 * 230)
  })
  const characters = [{ text: '你', start: .12, end: .42 }, { text: '，', start: .42, end: .6 }, { text: '好', start: .8, end: 1.17 }]
  const calls = []
  const acts = []
  const f = fixture(async () => { throw new Error('cloud must not load Kokoro') }, {
    async synthesizeCloud(sentence) {
      calls.push({ ...sentence })
      return { samples: voiced.slice(), sampleRate, words: [], characters: characters.map(character => ({ ...character })) }
    },
  }, { onAct: act => acts.push(act) })
  const pause = Math.round(ACT_PAUSE_SECONDS * sampleRate)
  const padded = Float32Array.from([...new Float32Array(pause), ...voiced])
  const paddedDuration = padded.length / sampleRate
  const frames = mouthFrames(padded, sampleRate)
  const shifted = characters.map(character => ({ ...character, start: character.start + ACT_PAUSE_SECONDS, end: character.end + ACT_PAUSE_SECONDS }))
  const expected = [{ time: 0, duration: paddedDuration, events: speechBeats({ words: [], characters: shifted }, frames, paddedDuration) }]
  assert.ok(expected[0].events.length > 0 && expected[0].events.every(event => event.peak > ACT_PAUSE_SECONDS))
  assert.deepEqual(speechBeats({ words: [], characters }, frames, paddedDuration), [],
    'fixture: unshifted timings would miss every spoken peak')
  try {
    const speaking = f.controller.speak('你，好。你，好。', 'neutral', undefined, [], 'cloud', { acts: [{ start: 0, act: 'pause' }] })
    await settle()
    assert.deepEqual(calls, [
      { text: '你，好。', delivery: 'neutral', act: 'pause' },
      { text: '你，好。', delivery: 'neutral' },
    ], 'only the act sentence carries the act, and never as text')
    assert.deepEqual(acts, ['pause'], 'performed at the start of its clip, where the silence begins')
    assert.deepEqual(await sourcePcm(f), int16(padded))
    for (const time of [0.2, ...expected[0].events.map(event => event.peak), 1.0]) {
      f.tick(time)
      assert.ok(Math.abs(f.events.beats.at(-1) - speechBeatAtTime(expected, time)) < 1e-12, `beat at ${time}`)
    }
    assert.ok(expected[0].events.some(event => speechBeatAtTime(expected, event.peak) > 0.1))
    f.audio.end()
    assert.deepEqual(await sourcePcm(f), int16(voiced), 'the next sentence gets no pause')
    f.audio.end()
    await speaking
    assert.deepEqual(await sourcePcm(f), int16([...padded, ...voiced]))
    assert.deepEqual(acts, ['pause'])
    assert.equal(calls.length, 2)
  }
  finally { f.close() }
})

test('a streamed act rides on the next sentence to the cloud, only the first counts, and browser fallback keeps it out of the text', async () => {
  for (const outcome of ['cloud', 'fallback']) {
    const calls = []
    const acts = []
    const f = fixture(async () => { throw new Error('cloud must not load Kokoro') }, {
      async synthesizeCloud(sentence) {
        calls.push({ ...sentence })
        if (outcome === 'fallback') throw new SpeechApiError('upstream', 502)
        return cloudClip()
      },
    }, { onAct: act => acts.push(act) })
    try {
      const input = f.controller.beginStream('', 'soft', undefined, 'cloud')
      input.push('好的。')
      input.setAct('sigh')
      input.push('其实我也累了。')
      input.setAct('laugh')
      input.push('明天见。')
      input.finish()
      await settle()
      if (outcome === 'cloud') {
        assert.deepEqual(calls, [
          { text: '好的。', delivery: 'soft' },
          { text: '其实我也累了。', delivery: 'soft', act: 'sigh' },
        ])
        assert.deepEqual(acts, [])
        f.audio.end()
        assert.deepEqual(acts, ['sigh'])
        await settle()
        assert.deepEqual(calls.at(-1), { text: '明天见。', delivery: 'soft' }, 'a second act is ignored')
        f.audio.end()
        assert.deepEqual(acts, ['sigh'])
      }
      else {
        assert.deepEqual(calls, [{ text: '好的。', delivery: 'soft' }])
        for (const [index, text] of ['好的。', '其实我也累了。', '明天见。'].entries()) {
          await settle()
          const utterance = f.utterances[index]
          assert.equal(utterance.text, text, 'the system voice never reads an act')
          utterance.onstart()
          utterance.onpause()
          utterance.onresume()
          assert.deepEqual(acts, index === 0 ? [] : ['sigh'], 'fired once, at its utterance start')
          utterance.onend()
        }
        assert.equal(f.utterances.length, 3)
        assert.equal(calls.length, 1, 'no paid retry')
      }
    }
    finally { f.close() }
  }
})

test('the old bright tone from an untyped caller is spoken as happy on every entry path', async () => {
  const calls = []
  const f = fixture(async () => { throw new Error('cloud must not load Kokoro') }, {
    async synthesizeCloud(sentence) { calls.push(sentence.delivery); return cloudClip() },
  })
  try {
    const input = f.controller.beginStream('', 'bright', undefined, 'cloud')
    input.push('一。')
    input.setDelivery('bright')
    input.setDelivery('invented')
    input.push('二。')
    input.finish()
    await settle()
    f.audio.end()
    await settle()
    assert.deepEqual(calls, ['happy', 'happy'])
    assert.ok(f.events.delivery.length && f.events.delivery.every(delivery => delivery === 'happy'))
    f.audio.end()
    await f.controller.speak('三。', 'bright', undefined, [{ start: 0, delivery: 'bright' }], 'cloud')
    assert.deepEqual(calls, ['happy', 'happy', 'happy'])
  }
  finally { f.close() }
})

test('a dropped silent local chunk passes its act (and pause) to the next audible chunk', async () => {
  const acts = []
  const voiced = shapedClip(0.02, 2400, 24000).samples
  const f = fixture(async () => ({ async *stream() {
    yield { audio: { data: new Float32Array(2400), sampling_rate: 24000 } }
    yield { audio: { data: voiced.slice(), sampling_rate: 24000 } }
  } }), {}, { onAct: act => acts.push(act) })
  try {
    await f.controller.speak('嗯。', 'neutral', undefined, [], 'local', { acts: [{ start: 0, act: 'pause' }] })
    assert.deepEqual(await sourcePcm(f), int16([...new Float32Array(Math.round(ACT_PAUSE_SECONDS * 24000)), ...voiced]))
    assert.deepEqual(acts, ['pause'])
  }
  finally { f.close() }
})

// Plays a cloud reply to the end, one clip after another.
async function playThrough(f, speaking) {
  let done = false
  void speaking.then(() => { done = true })
  for (let i = 0; i < 40 && !done; i++) {
    await settle()
    f.audio.end()
  }
  await speaking
  for (let i = 0; i < 4; i++) {
    f.audio.end()
    await settle()
  }
}

test('a whole cloud reply joins its same-tone sentences into one request', async () => {
  const calls = []
  const f = fixture(undefined, { joinCloudSentences: true, async synthesizeCloud(sentence) { calls.push(sentence); return cloudClip() } })
  try {
    await playThrough(f, f.controller.speak('一。二。三。', 'neutral', undefined, [], 'cloud'))
    assert.deepEqual(calls, [{ text: '一。二。三。', delivery: 'neutral' }])
  }
  finally { f.close() }
  const off = []
  const g = fixture(undefined, { joinCloudSentences: true, async synthesizeCloud(sentence) { off.push(sentence.text); return cloudClip() } })
  try {
    await playThrough(g, g.controller.speak('一。二。三。', 'neutral', undefined, [], 'cloud', { join: false }))
    assert.deepEqual(off, ['一。', '二。', '三。'], 'speak({ join: false }) buys one per sentence')
  }
  finally { g.close() }
  const on = []
  const h = fixture(undefined, { async synthesizeCloud(sentence) { on.push(sentence.text); return cloudClip() } })
  try {
    await playThrough(h, h.controller.speak('一。二。', 'neutral', undefined, [], 'cloud', { join: true }))
    assert.deepEqual(on, ['一。二。'], 'speak({ join: true }) overrides the controller default')
  }
  finally { h.close() }
})

test('the controller buys exactly the clips the live server plans: tones, acts and the limit chain', async () => {
  const replies = [
    ['晚上好呀！今天弹幕好热闹。我们先从第一条开始吧。', 'happy', [], []],
    ['先开心一下。还开心呢。然后难过了。', 'happy', [{ start: 11, delivery: 'sad' }], []],
    ['这个梗我接住了！你们今天弹幕好热闹。还有呢？', 'happy', [], [{ start: 8, act: 'laugh' }]],
    ['这个嘛我猜是草莓味。', 'curious', [], [{ start: 3, act: 'pause' }]],
    [`${'好！'.repeat(25)}再见。`, 'happy', [], []],
    ['第一行\n第二行。第三行。', 'neutral', [], []],
  ]
  for (const [text, delivery, cues, acts] of replies) {
    const calls = []
    const f = fixture(undefined, { joinCloudSentences: true, async synthesizeCloud(sentence) { calls.push(sentence); return cloudClip() } })
    try {
      await playThrough(f, f.controller.speak(text, delivery, undefined, cues, 'cloud', { acts }))
      const planned = []
      for await (const sentence of replySentenceStream(text, delivery, cues, '', acts))
        planned.push(sentence)
      assert.deepEqual(calls, groupSentences(planned).map(({ parts: _parts, ...clip }) => clip), text)
    }
    finally { f.close() }
  }
})

test('a streamed reply sends its first sentence alone, then joins what has arrived', async () => {
  const calls = []
  const f = fixture(undefined, { joinCloudSentences: true, async synthesizeCloud(sentence) { calls.push(sentence.text); return cloudClip() } })
  try {
    const input = f.controller.beginStream('', 'happy', undefined, 'cloud')
    input.push('第一句。第')
    await settle()
    await settle()
    assert.deepEqual(calls, ['第一句。'], 'the first audio never waits for more text')
    // The buffer releases a sentence once the next character shows no
    // closing quote follows, so 第三句 is complete when 第 arrives.
    input.push('二句。第三句。第')
    for (let i = 0; i < 4; i++) await settle()
    assert.deepEqual(calls, ['第一句。', '第二句。第三句。'], 'complete sentences already here join')
    input.push('四句。')
    input.finish()
    for (let i = 0; i < 6; i++) {
      f.audio.end()
      await settle()
    }
    assert.deepEqual(calls, ['第一句。', '第二句。第三句。', '第四句。'])
  }
  finally { f.close() }
})

test('a streamed first request goes alone even when several sentences arrive in one delta', async () => {
  const calls = []
  const f = fixture(undefined, { joinCloudSentences: true, async synthesizeCloud(sentence) { calls.push(sentence.text); return cloudClip() } })
  try {
    const input = f.controller.beginStream('', 'happy', undefined, 'cloud')
    input.push('第一句。第二句。第')
    await settle()
    await settle()
    assert.equal(calls[0], '第一句。', 'a longer first request would delay the first audio')
    input.push('三句。')
    input.finish()
    for (let i = 0; i < 6; i++) {
      f.audio.end()
      await settle()
    }
    assert.deepEqual(calls.flatMap(text => text.match(/第.句。/g)), ['第一句。', '第二句。', '第三句。'], 'nothing skipped or repeated')
  }
  finally { f.close() }
})

test('the web chat controller joins by default', async () => {
  const calls = []
  // joinCloudSentences: undefined is what App.vue passes (nothing).
  const f = fixture(undefined, { joinCloudSentences: undefined, async synthesizeCloud(sentence) { calls.push(sentence.text); return cloudClip() } })
  try {
    await playThrough(f, f.controller.speak('一。二。', 'neutral', undefined, [], 'cloud'))
    assert.deepEqual(calls, ['一。二。'])
  }
  finally { f.close() }
})

// Leads: the next tone announced TONE_LEAD_SECONDS before playback reaches it,
// on a separate callback so onDelivery and onAct keep their timing.
const voicedSecond = () => shapedClip(0.02, 24000, 24000)
function leadFixture(synthesizeCloud, callbacks = {}) {
  const log = []
  const f = fixture(undefined, { synthesizeCloud }, {
    onDelivery: delivery => log.push(['delivery', delivery]),
    onLead: delivery => log.push(['lead', delivery]),
    ...callbacks(log),
  })
  return { f, log }
}

test('a ready next clip of another tone is announced in the last lead of its source, without moving onDelivery', async () => {
  const { TONE_LEAD_SECONDS } = await import('./speech-sentences.ts')
  assert.equal(TONE_LEAD_SECONDS, 0.18)
  const calls = []
  const { f, log } = leadFixture(async (sentence) => { calls.push(sentence.text); return voicedSecond() }, () => ({}))
  const end = 1
  try {
    const speaking = f.controller.speak('开心。难过。', 'happy', undefined, [{ start: 3, delivery: 'sad' }], 'cloud')
    await settle()
    assert.deepEqual(calls, ['开心。', '难过。'], 'the sad clip is ready while the happy one plays')
    assert.deepEqual(log, [['lead', 'happy'], ['delivery', 'happy'], ['lead', null]],
      'the first clip is announced as it is installed, then the voice takes over')
    log.length = 0
    f.tick(end - 0.19)
    assert.deepEqual(log, [], 'not yet one lead before the end')
    f.tick(end - 0.17)
    assert.deepEqual(log, [['lead', 'sad']])
    f.tick(end - 0.01)
    assert.deepEqual(log, [['lead', 'sad']], 'onDelivery keeps the old tone until its source ends')
    f.audio.end()
    assert.deepEqual(log, [['lead', 'sad'], ['delivery', 'sad'], ['lead', null]])
    f.tick(end - 0.17)
    assert.equal(log.length, 3, 'nothing follows the last clip')
    f.audio.end()
    await speaking
    assert.equal(log.length, 3, 'the completed replay is installed with no lead')
  }
  finally { f.close() }
})

test('a next clip that was not ready is announced as it is installed, before play()', async () => {
  const second = deferred()
  let calls = 0
  const { f, log } = leadFixture(async () => calls++ ? second.promise : voicedSecond(), log => ({
    onLead: delivery => log.push(['lead', delivery, f.audio.plays]),
    onPreparing: preparing => log.push(['preparing', preparing]),
  }))
  try {
    const speaking = f.controller.speak('开心。难过。', 'happy', undefined, [{ start: 3, delivery: 'sad' }], 'cloud')
    await settle()
    assert.equal(calls, 2)
    assert.deepEqual(log.filter(entry => entry[0] === 'lead'), [['lead', 'happy', 0], ['lead', null, 1]])
    f.tick(0.9)
    f.audio.end()
    assert.deepEqual(log.filter(entry => entry[0] === 'lead').length, 2, 'nothing to announce while it is missing')
    log.length = 0
    second.resolve(voicedSecond())
    await settle()
    assert.deepEqual(log.slice(0, 2), [['lead', 'sad', 1], ['preparing', false]], 'before preparing ends and before play()')
    assert.deepEqual(log.filter(entry => entry[0] !== 'preparing'), [['lead', 'sad', 1], ['delivery', 'sad'], ['lead', null, 2]])
    f.audio.end()
    await speaking
  }
  finally { f.close() }
})

test('cancel, speak and beginStream retract a pending lead and start the next turn clean', async () => {
  for (const entry of ['cancel', 'speak', 'beginStream']) {
    const { f, log } = leadFixture(async () => voicedSecond(), () => ({}))
    try {
      void f.controller.speak('开心。难过。', 'happy', undefined, [{ start: 3, delivery: 'sad' }], 'cloud')
      await settle()
      f.tick(0.83)
      assert.deepEqual(log.at(-1), ['lead', 'sad'])
      log.length = 0
      let stream = null
      if (entry === 'cancel') f.controller.cancel()
      else if (entry === 'speak') void f.controller.speak('开心。', 'happy', undefined, [], 'cloud')
      else stream = f.controller.beginStream('', 'happy', undefined, 'cloud')
      assert.deepEqual(log, [['lead', null]], entry)
      f.controller.cancel()
      assert.deepEqual(log, [['lead', null]], `${entry}: only on a change`)
      // The tone just spoken is announced again: nothing is carried over.
      if (entry === 'beginStream') {
        stream = f.controller.beginStream('', 'happy', undefined, 'cloud')
        stream.push('开心。')
        stream.finish()
      }
      else void f.controller.speak('开心。', 'happy', undefined, [], 'cloud')
      await settle()
      assert.deepEqual(log, [['lead', null], ['lead', 'happy'], ['delivery', 'happy'], ['lead', null]], entry)
    }
    finally { f.close() }
  }
})

test('the completed replay announces each tone change one lead ahead, and a backward seek recomputes it', async () => {
  const { f, log } = leadFixture(async () => voicedSecond(), () => ({}))
  try {
    await playThrough(f, f.controller.speak('开心。难过。', 'happy', undefined, [{ start: 3, delivery: 'sad' }], 'cloud'))
    log.length = 0
    await f.audio.play()
    assert.deepEqual(log, [['delivery', 'happy']])
    f.tick(0.81)
    assert.deepEqual(log, [['delivery', 'happy']])
    f.tick(0.83)
    assert.deepEqual(log, [['delivery', 'happy'], ['lead', 'sad']], 'the sad cue at 1 s is announced at 0.82 s')
    seekTo(f, 0.2)
    assert.deepEqual(log.slice(2), [['lead', null]], 'a backward seek takes it back')
    f.tick(0.83)
    f.tick(1.05)
    assert.deepEqual(log.slice(2), [['lead', null], ['lead', 'sad'], ['delivery', 'sad'], ['lead', null]])
    f.tick(1.9)
    assert.equal(log.length, 6, 'nothing after the last cue')
  }
  finally { f.close() }
})

test('onMouth\'s fourth argument is the beat BEAT_LOOKAHEAD_SECONDS ahead, only while an audio source plays', async () => {
  const { BEAT_LOOKAHEAD_SECONDS } = await import('./speech.ts')
  assert.equal(BEAT_LOOKAHEAD_SECONDS, 0.12)
  const sampleRate = 24000, duration = 1.317
  const samples = Float32Array.from({ length: sampleRate * duration }, (_, index) => {
    const time = index / sampleRate
    const envelope = Math.max(0, 1 - Math.abs(time - .25) / .08, 1 - Math.abs(time - .95) / .09)
    return .09 * envelope * Math.sin(time * Math.PI * 2 * 230)
  })
  const characters = [{ text: '你', start: .12, end: .42 }, { text: '，', start: .42, end: .6 }, { text: '好', start: .8, end: 1.17 }]
  const track = { time: 0, duration: samples.length / sampleRate,
    events: speechBeats({ words: [], characters }, mouthFrames(samples, sampleRate), samples.length / sampleRate) }
  assert.ok(track.events.length > 0, 'fixture has measured audible peaks')
  const near = (actual, expected) => actual === expected
    || (actual !== null && expected !== null && Math.abs(actual - expected) < 1e-12)
  const mouth = []
  const f = fixture(undefined, {
    async synthesizeCloud() { return { samples: samples.slice(), sampleRate, words: [], characters: characters.map(character => ({ ...character })) } },
  }, { onMouth: (...args) => mouth.push(args) })
  try {
    const speaking = f.controller.speak('你，好。', 'neutral', undefined, [], 'cloud')
    await settle()
    const times = [0.05, ...track.events.flatMap(event => [event.start - 0.1, event.peak - BEAT_LOOKAHEAD_SECONDS, event.peak]), duration - 0.05]
      .filter(time => time >= 0).sort((a, b) => a - b)
    let ahead = 0
    for (const time of times) {
      f.tick(time)
      const args = mouth.at(-1)
      assert.equal(args.length, 4)
      assert.ok(near(args[2], speechBeatAtTime([track], time)), `beat at ${time}`)
      assert.ok(near(args[3], speechBeatAtTime([track], time + BEAT_LOOKAHEAD_SECONDS)), `beat ahead at ${time}`)
      ahead = Math.max(ahead, args[3] ?? 0)
    }
    assert.ok(ahead > 0.1, 'a peak is seen ahead')
    assert.equal(mouth.at(-1)[3], null, 'nothing ahead past the source end')
    f.audio.pause()
    assert.deepEqual(mouth.at(-1), [0, 0, null], 'a stop keeps three arguments')
    f.audio.end()
    await speaking
  }
  finally { f.close() }

  const browser = []
  const g = fixture(undefined, {}, { onMouth: (...args) => browser.push(args) })
  try {
    const speaking = g.controller.speak('你好。', 'neutral', undefined, [], 'browser')
    await settle()
    const utterance = g.utterances[0]
    utterance.onstart()
    utterance.onpause()
    utterance.onresume()
    utterance.onend()
    await speaking
    assert.deepEqual(browser, [[0, 0, null], [null, 0, null], [0, 0, null], [null, 0, null], [0, 0, null]],
      'the system voice passes the same three arguments as before')
  }
  finally { g.close() }
})

test('a pause or a blocked play takes back an announced tone; playing again announces it again', async () => {
  const { f, log } = leadFixture(async () => voicedSecond(), () => ({}))
  try {
    void f.controller.speak('开心。难过。', 'happy', undefined, [{ start: 3, delivery: 'sad' }], 'cloud')
    await settle()
    f.tick(0.83)
    assert.deepEqual(log.at(-1), ['lead', 'sad'])
    f.audio.pause()
    assert.deepEqual(log.at(-1), ['lead', null], 'paused inside the lead window: the face may relax')
    await f.audio.play()
    f.tick(0.84)
    assert.deepEqual(log.at(-1), ['lead', 'sad'], 'the next playing frame announces it again')
  }
  finally { f.close() }

  const blocked = leadFixture(async () => voicedSecond(), () => ({}))
  blocked.f.audio.play = async function () { this.plays++; throw new DOMException('blocked', 'NotAllowedError') }
  try {
    void blocked.f.controller.speak('开心。', 'happy', undefined, [], 'cloud')
    await settle()
    await settle()
    assert.deepEqual(blocked.log, [['lead', 'happy'], ['lead', null]], 'an install lead is taken back when autoplay is refused')
  }
  finally { blocked.f.close() }
})

test('a late clip in the tone just spoken is announced at install too, since the face may have relaxed meanwhile', async () => {
  const second = deferred()
  let calls = 0
  const { f, log } = leadFixture(async () => calls++ ? second.promise : voicedSecond(), () => ({}))
  try {
    const speaking = f.controller.speak('开心。还开心。', 'happy', undefined, [], 'cloud', { join: false })
    await settle()
    f.tick(0.9)
    f.audio.end()
    log.length = 0
    second.resolve(voicedSecond())
    await settle()
    assert.deepEqual(log, [['lead', 'happy'], ['delivery', 'happy'], ['lead', null]], 'announced at install, retracted on the first frame')
    f.audio.end()
    await speaking
  }
  finally { f.close() }
})
