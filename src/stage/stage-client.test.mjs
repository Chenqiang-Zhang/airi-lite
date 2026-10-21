import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { STAGE_PROTOCOL } from '../../shared/performance-cues.mjs'

import { SpeechApiError } from '../cloud-speech.ts'
import { createStageClient, isStageProblem, resolveStageRole, shouldShowPerformanceDebug } from './stage-client.ts'

const settle = () => new Promise(resolve => setImmediate(resolve))
const CLIP = { samples: new Float32Array([0.1, -0.1]), sampleRate: 32000, words: [] }

function fixture({ role = 'obs', postStatus = () => 200 } = {}) {
  const posts = []
  const spoken = []
  const view = { captions: [], brb: [], connection: [], reloads: 0, thinking: [] }
  const timers = new Map()
  let nextTimer = 0
  const sources = []
  let cancels = 0
  const client = createStageClient({
    role,
    openEvents(handlers) {
      const source = { handlers, closed: false, close() { this.closed = true } }
      sources.push(source)
      return source
    },
    async post(path, body, signal) {
      posts.push({ path, body, signal })
      const status = postStatus(path, body)
      return new Response(status === 204 ? null : JSON.stringify(CLIP), { status })
    },
    speech: {
      async speak(text, delivery, voice, cues, engine, options) {
        spoken.push({ text, delivery, voice, cues, engine, options })
      },
      cancel() { cancels++ },
    },
    view: {
      showCaption: text => view.captions.push(text),
      clearCaption: () => view.captions.push(null),
      setBrb: on => view.brb.push(on),
      reload: () => view.reloads++,
      setConnection: state => view.connection.push(state),
      setThinking: on => view.thinking.push(on),
    },
    timers: {
      setTimeout(callback, ms) { timers.set(++nextTimer, { callback, ms }); return nextTimer },
      clearTimeout(handle) { timers.delete(handle) },
    },
    decode: async () => CLIP,
  })
  return {
    client, posts, spoken, view, timers, sources,
    get cancels() { return cancels },
    emit(type, data, index = sources.length - 1) { sources[index].handlers.onEvent(type, data) },
    disconnect(index = sources.length - 1) { sources[index].handlers.onDisconnect() },
    fire(ms) {
      for (const [handle, timer] of [...timers]) {
        if (timer.ms === ms) { timers.delete(handle); timer.callback() }
      }
    },
    reports: () => posts.filter(post => post.path === 'api/live/stage/report').map(post => post.body),
  }
}

test('role defaults to obs inside OBS and preview elsewhere; progress chatter is not a problem', () => {
  assert.equal(resolveStageRole(null, true), 'obs')
  assert.equal(resolveStageRole(null, false), 'preview')
  assert.equal(resolveStageRole('preview', true), 'preview')
  assert.equal(resolveStageRole('obs', false), 'obs')
  assert.equal(resolveStageRole('director', false), 'preview')
  assert.equal(isStageProblem(''), false)
  assert.equal(isStageProblem('正在生成语音…'), false)
  assert.equal(isStageProblem('语音已生成，但自动播放被浏览器拦截。请点击下方播放器的播放键。'), true)
})

test('the primary reports ready (and known avatar/OBS state), speaks on cloud and reports the outcome', async () => {
  const f = fixture()
  f.client.reportAvatar('ready')
  f.client.reportObs({ active: true, visible: true, streaming: false })
  f.client.start()
  assert.deepEqual(f.view.connection, ['connecting'])
  assert.deepEqual(f.posts, [], 'nothing is reported before a lease exists')
  f.emit('hello', { leaseId: 'lease-1', role: 'obs', primary: true, mode: 'live' })
  await settle()
  assert.deepEqual(f.reports(), [
    { leaseId: 'lease-1', type: 'ready', protocol: STAGE_PROTOCOL },
    { leaseId: 'lease-1', type: 'avatar', status: 'ready' },
    { leaseId: 'lease-1', type: 'obs', active: true, visible: true, streaming: false },
  ])
  assert.equal(f.view.connection.at(-1), 'live')

  f.emit('say', { turnId: 't1', text: '你好。', delivery: 'soft', cues: [], replyTo: null })
  assert.deepEqual(f.view.captions, ['你好。'])
  assert.equal(f.spoken.length, 1)
  assert.equal(f.spoken[0].engine, 'cloud')
  assert.equal(f.spoken[0].delivery, 'soft')

  const clip = await f.client.synthesizeCloud({ text: '你好。', delivery: 'soft' }, new AbortController().signal)
  assert.equal(clip, CLIP)
  assert.deepEqual(f.posts.at(-1).body, { leaseId: 'lease-1', turnId: 't1', text: '你好。', delivery: 'soft' })
  assert.equal(f.posts.at(-1).path, 'api/live/stage/speech')

  f.spoken[0].options.onEnded('played')
  await settle()
  assert.deepEqual(f.reports().at(-1), { leaseId: 'lease-1', type: 'ended', turnId: 't1', outcome: 'played' })
  assert.deepEqual(f.view.captions, ['你好。'], 'the caption lingers briefly after playback')
  f.fire(1_200)
  assert.deepEqual(f.view.captions, ['你好。', null])
})

test('a preview shows captions but never speaks, buys audio or reports', async () => {
  const f = fixture({ role: 'preview' })
  f.client.start()
  f.emit('hello', { leaseId: null, role: 'preview', primary: false, mode: 'live' })
  f.emit('say', { turnId: 't1', text: '只看字幕。', delivery: 'neutral', cues: [] })
  assert.deepEqual(f.view.captions, ['只看字幕。'])
  assert.equal(f.spoken.length, 0)
  await assert.rejects(f.client.synthesizeCloud({ text: '只看字幕。', delivery: 'neutral' }, new AbortController().signal),
    error => error instanceof SpeechApiError && error.code === 'unavailable')
  f.client.reportProblem('任何问题')
  await settle()
  assert.deepEqual(f.posts, [])
  assert.equal(f.view.connection.at(-1), 'preview')
  f.fire(4_000 + 300 * '只看字幕。'.length)
  assert.deepEqual(f.view.captions, ['只看字幕。', null], 'preview captions fade on a budget')
})

test('standby, stop and brb silence the stage; a stale stop or ended report never clears a newer caption', async () => {
  const f = fixture()
  f.client.start()
  f.emit('hello', { leaseId: 'lease-1', primary: true, mode: 'live' })
  f.emit('say', { turnId: 't1', text: '第一句。', delivery: 'neutral', cues: [] })
  f.emit('say', { turnId: 't2', text: '第二句。', delivery: 'neutral', cues: [] })
  // speak() for t2 cancels t1, whose late "cancelled" must not touch t2.
  f.spoken[0].options.onEnded('cancelled')
  f.emit('stop', { turnId: 't1' })
  assert.equal(f.view.captions.at(-1), '第二句。')
  const before = f.cancels
  f.emit('stop', { turnId: 't2' })
  assert.equal(f.cancels, before + 1)
  assert.equal(f.view.captions.at(-1), null)

  f.emit('say', { turnId: 't3', text: '第三句。', delivery: 'neutral', cues: [] })
  f.emit('mode', { mode: 'brb' })
  assert.deepEqual(f.view.brb.at(-1), true)
  assert.equal(f.view.captions.at(-1), null)
  f.emit('mode', { mode: 'live' })
  assert.deepEqual(f.view.brb.at(-1), false)

  f.emit('say', { turnId: 't4', text: '第四句。', delivery: 'neutral', cues: [] })
  const cancelsBeforeStandby = f.cancels
  f.emit('standby', {})
  assert.equal(f.cancels, cancelsBeforeStandby + 1)
  assert.equal(f.view.connection.at(-1), 'standby')
  await assert.rejects(f.client.synthesizeCloud({ text: '第四句。', delivery: 'neutral' }, new AbortController().signal),
    { code: 'unavailable' }, 'a standby page holds no lease')
  f.emit('reload', {})
  assert.equal(f.view.reloads, 1)
})

test('a refused purchase becomes an unavailable error instead of decoding a JSON refusal', async () => {
  const f = fixture({ postStatus: path => path === 'api/live/stage/speech' ? 409 : 204 })
  f.client.start()
  f.emit('hello', { leaseId: 'lease-1', primary: true, mode: 'live' })
  f.emit('say', { turnId: 't1', text: '没计划的话。', delivery: 'neutral', cues: [] })
  await assert.rejects(f.client.synthesizeCloud({ text: '别的话。', delivery: 'neutral' }, new AbortController().signal),
    error => error instanceof SpeechApiError && error.code === 'unavailable' && error.status === 409)
})

test('a lost stream drops the lease immediately and reconnects with backoff for a fresh hello', async () => {
  const f = fixture()
  f.client.start()
  f.emit('hello', { leaseId: 'lease-1', primary: true, mode: 'live' })
  f.emit('say', { turnId: 't1', text: '断线了。', delivery: 'neutral', cues: [] })
  const before = f.cancels
  f.disconnect()
  assert.equal(f.sources[0].closed, true)
  assert.equal(f.cancels, before + 1, 'never keep speaking without the event stream')
  assert.equal(f.view.connection.at(-1), 'offline')
  assert.equal(f.client.state.leaseId, null)
  f.fire(1_000)
  assert.equal(f.sources.length, 2)
  f.disconnect()
  f.fire(2_000)
  f.disconnect()
  assert.ok([...f.timers.values()].some(timer => timer.ms === 4_000), 'backoff grows')
  f.fire(4_000)
  f.emit('hello', { leaseId: 'lease-2', primary: true, mode: 'brb' })
  await settle()
  assert.equal(f.view.brb.at(-1), true, 'a reconnect lands on the current screen mode')
  assert.deepEqual(f.reports().at(-1), { leaseId: 'lease-2', type: 'ready', protocol: STAGE_PROTOCOL })
  f.disconnect()
  assert.ok([...f.timers.values()].some(timer => timer.ms === 1_000), 'a successful hello resets the backoff')
  f.client.stop()
  assert.equal(f.timers.size, 0)
})

test('the brain\'s thinking cue shows until a line arrives or the stage goes brb', () => {
  const f = fixture()
  f.client.start()
  f.emit('hello', { leaseId: 'lease-1', primary: true, mode: 'live' })
  f.emit('activity', { state: 'thinking' })
  f.emit('activity', { state: 'idle' })
  f.emit('activity', { state: 'thinking' })
  f.emit('say', { turnId: 't1', text: '想好了。', delivery: 'neutral', cues: [] })
  f.emit('activity', { state: 'thinking' })
  f.emit('mode', { mode: 'brb' })
  assert.deepEqual(f.view.thinking, [false, true, false, true, false, true, false])
})

test('a lost event stream drops the thinking pose; the next hello restores the server\'s activity', () => {
  const f = fixture()
  f.client.start()
  f.emit('hello', { leaseId: 'lease-1', primary: true, mode: 'live', activity: 'idle' })
  f.emit('activity', { state: 'thinking' })
  f.disconnect()
  f.fire(1_000)
  f.emit('hello', { leaseId: 'lease-2', primary: true, mode: 'live', activity: 'thinking' })
  assert.deepEqual(f.view.thinking, [false, true, false, true])
  f.client.stop()
})

test('a say carries its acts to speech, and a purchase names the act only for the sentence that has one', async () => {
  const f = fixture()
  f.client.start()
  f.emit('hello', { leaseId: 'lease-1', primary: true, mode: 'live' })
  const acts = [{ start: 3, act: 'laugh' }]
  f.emit('say', { turnId: 't1', text: '谢谢！哈哈真好。', delivery: 'bright', cues: [], acts })
  assert.equal(f.spoken.length, 1)
  assert.equal(f.spoken[0].delivery, 'happy', 'an old server\'s bright is spoken as happy')
  assert.equal(f.spoken[0].options.acts, acts, 'the raw list goes to the planner, which validates it')
  f.emit('say', { turnId: 't2', text: '没有动作。', delivery: 'sad', cues: [] })
  assert.deepEqual(f.spoken[1].options.acts, [])

  await f.client.synthesizeCloud({ text: '哈哈真好。', delivery: 'happy', act: 'laugh' }, new AbortController().signal)
  assert.equal(JSON.stringify(f.posts.at(-1).body),
    JSON.stringify({ leaseId: 'lease-1', turnId: 't2', text: '哈哈真好。', delivery: 'happy', act: 'laugh' }))
  await f.client.synthesizeCloud({ text: '没有动作。', delivery: 'sad' }, new AbortController().signal)
  assert.equal(JSON.stringify(f.posts.at(-1).body),
    JSON.stringify({ leaseId: 'lease-1', turnId: 't2', text: '没有动作。', delivery: 'sad' }))
})

test('a tone this page does not know is reported and ends the turn at once instead of waiting for the watchdog', async () => {
  for (const role of ['obs', 'preview']) {
    const f = fixture({ role })
    f.client.start()
    f.emit('hello', role === 'obs' ? { leaseId: 'lease-1', primary: true, mode: 'live' } : { leaseId: null, primary: false, mode: 'live' })
    await settle()
    const before = f.reports().length
    f.emit('say', { turnId: 't1', text: '新语气。', delivery: 'ecstatic', cues: [] })
    await settle()
    assert.equal(f.spoken.length, 0)
    assert.deepEqual(f.view.captions, [])
    const reports = f.reports().slice(before)
    if (role === 'preview') {
      assert.deepEqual(reports, [], 'a preview never reports')
      continue
    }
    assert.equal(reports.length, 2)
    assert.equal(reports[0].type, 'problem')
    assert.match(reports[0].message, /ecstatic/)
    assert.ok(reports[0].message.length <= 120)
    assert.deepEqual(reports[1], { leaseId: 'lease-1', type: 'ended', turnId: 't1', outcome: 'failed' })
  }
})

test('a say joins sentences only when the server planned clips that way', async () => {
  const f = fixture()
  f.client.start()
  f.emit('hello', { leaseId: 'lease-1', primary: true, mode: 'live' })
  f.emit('say', { turnId: 't1', text: '一。二。', delivery: 'happy', cues: [], acts: [], join: true })
  f.emit('say', { turnId: 't2', text: '一。二。', delivery: 'happy', cues: [], acts: [] })
  f.emit('say', { turnId: 't3', text: '一。二。', delivery: 'happy', cues: [], acts: [], join: 'yes' })
  assert.deepEqual(f.spoken.map(call => call.options.join), [true, false, false], 'an older server, or anything but true, means one per sentence')
  await f.client.synthesizeCloud({ text: '哈哈真好。再说一句。', delivery: 'happy', act: 'laugh' }, new AbortController().signal)
  assert.equal(JSON.stringify(f.posts.at(-1).body),
    JSON.stringify({ leaseId: 'lease-1', turnId: 't3', text: '哈哈真好。再说一句。', delivery: 'happy', act: 'laugh' }), 'a joined clip is bought like a sentence')
  f.client.stop()
})

test('the performance panel is only for ?debug=performance on a preview page outside OBS', () => {
  assert.equal(shouldShowPerformanceDebug('performance', 'preview', false), true)
  for (const debug of [null, '', 'Performance', 'PERFORMANCE', ' performance', 'performance ', 'perf', '1', 'true'])
    assert.equal(shouldShowPerformanceDebug(debug, 'preview', false), false, `debug=${debug}`)
  assert.equal(shouldShowPerformanceDebug('performance', 'obs', false), false, 'role=obs is the stream')
  assert.equal(shouldShowPerformanceDebug('performance', 'preview', true), false, 'never inside OBS, whatever the role')
  assert.equal(shouldShowPerformanceDebug('performance', 'obs', true), false)
  assert.equal(shouldShowPerformanceDebug(null, 'obs', true), false)
  // The stage's real role resolution: inside OBS a missing role is obs.
  assert.equal(shouldShowPerformanceDebug('performance', resolveStageRole(null, true), true), false)
  assert.equal(shouldShowPerformanceDebug('performance', resolveStageRole(null, false), false), true)
})

test('main.ts loads the debug panel once, only behind the DEV and runtime guards, and never connects for it', () => {
  const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  const imports = source.match(/import\(\s*['"]\.\/performance-debug['"]\s*\)/g) ?? []
  assert.equal(imports.length, 1, 'exactly one dynamic import of the panel')
  assert.doesNotMatch(source, /from\s+['"]\.\/performance-debug/, 'no static import would bundle it into the stream')
  const guard = source.indexOf('if (import.meta.env.DEV && shouldShowPerformanceDebug(')
  assert.ok(guard >= 0, 'the branch is gated by the DEV build flag first')
  const at = source.indexOf(imports[0])
  // The import sits inside that if-block, and the else branch is the only start().
  const elseAt = source.indexOf('\nelse {', guard)
  assert.ok(at > guard && elseAt > at, 'the import is inside the guarded branch')
  const starts = source.match(/client\.start\(\)/g) ?? []
  assert.equal(starts.length, 1)
  assert.ok(source.indexOf('client.start()') > elseAt, 'the debug page never starts the client')
})
