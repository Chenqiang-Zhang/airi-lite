import assert from 'node:assert/strict'
import test from 'node:test'

import { createDeliveryCueParser } from '../delivery-cue.mjs'
import { TtsBudgetError } from '../tts-budget.mjs'
import { createLiveBrain, cutToLastSentence } from './brain.mjs'
import { createHub } from './hub.mjs'
import { buildLiveSystemPrompt } from './live-prompt.mjs'
import { screenReply } from './moderation.mjs'
import { createCandidateQueue } from './queue.mjs'
import { screenUtterance } from './utterance.mjs'

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)) }

// A scripted model: each call takes the next reply ('[[tone:x]]text' strings,
// {text, truncated}, an Error, or {hang: true} which waits for abort).
function fakeModel(replies) {
  const calls = []
  return {
    calls,
    configured: true,
    async open(messages, signal) {
      const reply = replies.shift() ?? '[[tone:neutral]]好的。'
      calls.push({ messages, signal })
      if (reply instanceof Error) throw reply
      return {
        async relay(onEvent) {
          if (reply.hang) {
            await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
          }
          const text = typeof reply === 'string' ? reply : reply.text
          const parser = createDeliveryCueParser()
          for (const event of [...parser.push(text), ...parser.finish()])
            onEvent(event)
          return { truncated: Boolean(reply.truncated), usage: { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 90 } }
        },
      }
    },
  }
}

function setup({ replies = [], gate = { ok: true }, budget = { reserve: async () => {} }, screen = utterance => screenUtterance(utterance) } = {}) {
  let time = 0
  let id = 0
  const hub = createHub({ now: () => time })
  const queue = createCandidateQueue({ now: () => time, newId: () => `i${++id}` })
  const model = fakeModel(replies)
  const said = []
  const pauses = []
  const events = []
  hub.subscribe('brain', event => events.push(event))
  const timers = { pending: [], setTimeout(callback, ms) { const handle = { callback, ms }; this.pending.push(handle); return handle }, clearTimeout() {} }
  const state = { gate }
  const brain = createLiveBrain({
    hub, queue, deepseek: model, screen, replyBudget: budget, now: () => time, timers,
    turns: {
      canSpeak: () => state.gate,
      say: async (request) => { said.push(request); return { ok: true, turnId: `t${said.length}` } },
      activity: () => {},
    },
    control: { pause: reason => pauses.push(reason) },
  })
  return {
    hub, queue, model, said, pauses, events, timers, state, brain,
    advance: ms => (time += ms),
    // The stage finished the turn having synthesised `spoken` sentences.
    async end(turnId, spoken) {
      hub.publish('turn.ended', { turnId, outcome: 'played', spoken })
      const cooldown = timers.pending.pop()
      cooldown.callback()
      await settle()
    },
    async danmaku(text, approve = true) {
      const item = queue.add({ kind: 'danmaku', msgId: `m${++id}`, user: { name: '甲' }, text })
      if (approve) queue.approve(item.id)
      await settle()
      return item
    },
  }
}

test('unapproved danmaku never reach the model; approving one starts a turn with the screened reply', async () => {
  const f = setup({ replies: ['[[tone:bright]]欢迎！今天也慢慢聊。'] })
  const item = await f.danmaku('晚上好', false)
  assert.equal(f.model.calls.length, 0)
  f.queue.approve(item.id)
  await settle()
  assert.equal(f.model.calls.length, 1)
  assert.deepEqual(f.said, [{
    text: '欢迎！今天也慢慢聊。', delivery: 'bright', cues: [{ start: 0, delivery: 'bright' }], replyTo: [item.id], origin: 'brain',
  }])
  const { messages } = f.model.calls[0]
  assert.equal(messages[0].content, buildLiveSystemPrompt())
  assert.equal(messages.at(-1).content, '<viewer_message from="甲" kind="danmaku">晚上好</viewer_message>')
  assert.equal(f.queue.snapshot().open[0].status, 'answering', 'not answered until the stage has spoken')
  await f.end('t1', ['欢迎！', '今天也慢慢聊。'])
  assert.equal(f.queue.snapshot().recent[0].status, 'answered')
})

test('nothing is generated without a speakable stage, and one turn at a time', async () => {
  const f = setup({ gate: { ok: false, reason: 'no-stage' } })
  await f.danmaku('有人吗')
  assert.equal(f.model.calls.length, 0, 'no stage, paused or busy: no DeepSeek call')
  f.state.gate = { ok: true }
  f.brain.schedule()
  await settle()
  assert.equal(f.model.calls.length, 1)
  await f.danmaku('第二条')
  assert.equal(f.model.calls.length, 1, 'waits until the stage has finished the current turn')
  await f.end('t1', ['好的。'])
  assert.equal(f.model.calls.length, 2)
})

test('a blocked reply is never said, is logged, and three strikes in ten minutes pause the stream', async () => {
  const f = setup({ replies: ['[[tone:bright]]去 www.example.com 看看！', '[[tone:neutral]]加我微信：abc12345', '[[tone:bright]]记得刷礼物！'] })
  await f.danmaku('一')
  await f.danmaku('二')
  assert.equal(f.said.length, 0)
  assert.deepEqual(f.pauses, [])
  await f.danmaku('三')
  assert.equal(f.said.length, 0)
  assert.deepEqual(f.pauses, ['strikes'])
  const blocked = f.events.filter(event => event.type === 'brain.blocked')
  assert.deepEqual(blocked.map(event => event.data.reason), ['url', 'contact', 'blocklist'])
  assert.equal(blocked[0].data.text, '去 www.example.com 看看！', 'the audit trail keeps the blocked text')
  assert.deepEqual(f.queue.snapshot().recent.map(item => item.status), ['blocked', 'blocked', 'blocked'])
  assert.ok(f.events.some(event => event.type === 'brain.paused' && event.data.reason === 'strikes'))
})

test('strikes older than the window do not accumulate', async () => {
  const f = setup({ replies: ['www.a.com', '[[tone:neutral]]www.b.com', '[[tone:neutral]]www.c.com'] })
  await f.danmaku('一')
  await f.danmaku('二')
  f.advance(10 * 60_000)
  await f.danmaku('三')
  assert.deepEqual(f.pauses, [])
  assert.equal(f.brain.state().strikes, 1)
})

test('stop aborts the upstream request and nothing it produced is spoken', async () => {
  const f = setup({ replies: [{ hang: true, text: '[[tone:neutral]]不该说出。' }] })
  const item = await f.danmaku('长问题')
  assert.equal(f.brain.state().phase, 'generating')
  f.brain.abortGeneration()
  await settle()
  assert.equal(f.model.calls[0].signal.aborted, true)
  assert.equal(f.said.length, 0)
  assert.equal(f.brain.state().phase, 'idle')
  assert.deepEqual(f.queue.snapshot().recent.map(entry => [entry.id, entry.status, entry.detail]), [[item.id, 'failed', 'stopped']])
})

test('history keeps only spoken sentences, at most six rounds, with the tone cue restored', async () => {
  const f = setup({ replies: Array.from({ length: 9 }, (_, index) => `[[tone:soft]]第${index}句。没说出的尾巴。`) })
  for (let round = 0; round < 8; round++) {
    await f.danmaku(`问题${round}`)
    // The stage only managed to synthesise the first sentence.
    await f.end(`t${round + 1}`, [`第${round}句。`])
  }
  await f.danmaku('最后')
  const { messages } = f.model.calls.at(-1)
  assert.equal(messages.length, 1 + 6 * 2 + 1)
  assert.deepEqual(messages.slice(1, 3), [
    { role: 'user', content: '<viewer_message from="甲" kind="danmaku">问题2</viewer_message>' },
    { role: 'assistant', content: '[[tone:soft]]第2句。' },
  ])
  assert.equal(messages.some(message => message.content.includes('没说出的尾巴')), false)

  const g = setup({ replies: ['[[tone:neutral]]完全没念出来。', '[[tone:neutral]]第二次。'] })
  await g.danmaku('一')
  await g.end('t1', [])
  await g.danmaku('二')
  assert.equal(g.model.calls[1].messages.length, 2, 'an unheard reply leaves no round in the context')
})

test('the daily reply budget pauses the stream before any model call', async () => {
  let reserved = 0
  const f = setup({ budget: { reserve: async () => { if (++reserved > 1) throw new TtsBudgetError('TTS_DAILY_LIMIT') } } })
  await f.danmaku('一')
  await f.end('t1', ['好的。'])
  await f.danmaku('二')
  assert.equal(f.model.calls.length, 1)
  assert.deepEqual(f.pauses, ['reply-budget'])
  assert.equal(f.queue.snapshot().recent[0].detail, 'reply-budget')
})

test('a length cut keeps whole sentences; an empty reply fails without a strike', async () => {
  const f = setup({ replies: [{ text: '[[tone:neutral]]第一句说完了。第二句还没说完就被', truncated: true }, { text: '[[tone:neutral]]完全没有句号的半句', truncated: true }, '[[tone:bright]]'] })
  await f.danmaku('一')
  assert.equal(f.said[0].text, '第一句说完了。')
  await f.end('t1', ['第一句说完了。'])
  await f.danmaku('二')
  await f.danmaku('三')
  assert.equal(f.said.length, 1)
  assert.equal(f.brain.state().strikes, 0)
  assert.deepEqual(f.queue.snapshot().recent.slice(0, 2).map(item => item.detail), ['empty-reply', 'truncated'])
  assert.equal(cutToLastSentence('你好！真的吗？还有'), '你好！真的吗？')
  assert.equal(cutToLastSentence('没有标点'), '')
})

test('three consecutive upstream errors pause the stream; items are not retried', async () => {
  const f = setup({ replies: [new Error('502'), new Error('502'), new Error('502')] })
  await f.danmaku('一')
  await f.danmaku('二')
  await f.danmaku('三')
  assert.equal(f.model.calls.length, 3)
  assert.deepEqual(f.pauses, ['upstream-errors'])
  assert.ok(f.queue.snapshot().recent.every(item => item.status === 'failed'))
  assert.equal(f.brain.state().lastError.message, '502')
})

test('a reply finished while the stage is briefly gone is released, then answered when it returns', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  let screened = 0
  const f = setup({ replies: ['[[tone:neutral]]第一次。', '[[tone:neutral]]舞台回来后。'],
    screen: async (utterance) => { if (++screened === 1) await gate; return screenUtterance(utterance) } })
  const item = await f.danmaku('一')
  f.state.gate = { ok: false, reason: 'no-stage' }
  release()
  await settle()
  assert.equal(f.said.length, 0)
  assert.equal(f.queue.snapshot().open[0].status, 'approved', 'not lost while the OBS page reloads')
  f.state.gate = { ok: true }
  f.brain.schedule() // the runtime does this when the stage reports ready
  await settle()
  assert.equal(f.said.at(-1).text, '舞台回来后。')
  assert.deepEqual(f.said.at(-1).replyTo, [item.id])
})

test('a reply finished after the host paused is dropped, not kept for later', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const f = setup({ screen: async (utterance) => { await gate; return screenUtterance(utterance) } })
  await f.danmaku('一')
  f.state.gate = { ok: false, reason: 'paused' }
  release()
  await settle()
  assert.equal(f.said.length, 0)
  assert.equal(f.queue.snapshot().recent[0].detail, 'not-speakable')
})

test('a host line ending wakes the brain for items approved meanwhile', async () => {
  const f = setup({ gate: { ok: false, reason: 'turn-active' } })
  await f.danmaku('主播说话时来的弹幕')
  assert.equal(f.model.calls.length, 0)
  f.state.gate = { ok: true }
  // The host's own turn ends: not the brain's turn, but the stage is free.
  f.hub.publish('turn.ended', { turnId: 'host-turn', outcome: 'played', spoken: ['主播的话。'] })
  await settle()
  assert.equal(f.model.calls.length, 1)
  assert.equal(f.said.length, 1)
})

test('a screened reply blocked only by a host line is released, then answered after it', async () => {
  let open
  const screening = new Promise(resolve => { open = resolve })
  let calls = 0
  const f = setup({ replies: ['[[tone:neutral]]第一次的回答。', '[[tone:neutral]]重新生成的回答。'],
    screen: async (utterance) => { if (++calls === 1) await screening; return screenUtterance(utterance) } })
  const item = await f.danmaku('问题')
  f.state.gate = { ok: false, reason: 'turn-active' }
  open()
  await settle()
  assert.equal(f.said.length, 0)
  assert.equal(f.queue.snapshot().open[0].id, item.id)
  assert.equal(f.queue.snapshot().open[0].status, 'approved', 'given back, not failed')
  assert.ok(f.events.some(event => event.type === 'brain.dropped' && event.data.released))
  f.state.gate = { ok: true }
  f.hub.publish('turn.ended', { turnId: 'host-turn', outcome: 'played', spoken: ['主播的话。'] })
  await settle()
  assert.equal(f.said.at(-1).text, '重新生成的回答。')
  assert.deepEqual(f.said.at(-1).replyTo, [item.id])
})

test('items are answered only if the stage actually spoke; otherwise failed with the outcome', async () => {
  const f = setup({ replies: ['[[tone:neutral]]第一条回答。', '[[tone:neutral]]第二条回答。'] })
  const first = await f.danmaku('一')
  f.hub.publish('turn.ended', { turnId: 't1', outcome: 'failed', spoken: [] })
  await f.timers.pending.pop().callback()
  await settle()
  const firstRecord = f.queue.snapshot().recent.find(item => item.id === first.id)
  assert.deepEqual([firstRecord.status, firstRecord.detail], ['failed', 'unspoken:failed'])
  const second = await f.danmaku('二')
  await f.end('t2', ['第二条回答。'])
  assert.equal(f.queue.snapshot().recent.find(item => item.id === second.id).status, 'answered')
  assert.equal(f.brain.state().historyRounds, 1, 'the unheard reply left no context')
})

test('every completed model call publishes exactly one usage event', async () => {
  const f = setup({ replies: ['[[tone:neutral]]好的。', 'www.example.com', '[[tone:bright]]', new Error('502'), '[[tone:soft]]再来。'] })
  await f.danmaku('一')
  await f.end('t1', ['好的。'])
  // One at a time: approvals made while she speaks would share one batch.
  for (const text of ['二', '三', '四', '五']) await f.danmaku(text)
  const usage = f.events.filter(event => event.type === 'brain.usage')
  assert.equal(f.model.calls.length, 5)
  assert.equal(usage.length, 4, 'four completed calls (one errored before any usage)')
  assert.equal(f.brain.state().usage.calls, 4)
  assert.equal(f.brain.state().usage.failedCalls, 1)
  assert.equal(usage.reduce((sum, event) => sum + event.data.usage.prompt_tokens, 0), f.brain.state().usage.promptTokens)
})

test('bidi and control characters in a reply never reach captions or speech', async () => {
  const f = setup({ replies: ['[[tone:neutral]]记得\u202e物礼刷\u202c哦！\u0007'] })
  await f.danmaku('一')
  assert.equal(f.said.length, 1)
  assert.equal(f.said[0].text, '记得物礼刷哦！')
  assert.equal(/[\u0000-\u0009\u000b-\u001f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(f.said[0].text), false)
})

test('a term split by Markdown is blocked by what would be spoken, not just what is shown', async () => {
  const f = setup({ replies: ['[[tone:bright]]觉得好玩记得[刷](a)礼物支持一下哦！', '[[tone:neutral]]打[1](a)3812345678找我。'] })
  await f.danmaku('一')
  await f.danmaku('二')
  assert.equal(f.said.length, 0)
  const blocked = f.events.filter(event => event.type === 'brain.blocked').map(event => [event.data.reason, event.data.term])
  assert.deepEqual(blocked, [['blocklist', '刷礼物'], ['contact', null]])
})

test('forgetContext empties the history (panic) without stalling the brain', async () => {
  const f = setup({ replies: ['[[tone:neutral]]第一句。', '[[tone:neutral]]第二句。'] })
  await f.danmaku('一')
  await f.end('t1', ['第一句。'])
  f.brain.forgetContext()
  await f.danmaku('二')
  assert.equal(f.model.calls[1].messages.length, 2, 'only system and the new batch')
  assert.equal(f.said.length, 2)
})
