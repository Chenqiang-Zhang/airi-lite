import assert from 'node:assert/strict'
import test from 'node:test'
import { nextTick, ref, watch } from 'vue'
import { normaliseChatRequest } from '../shared/chat-request.mjs'
import { createAssistantMessage, createChatTurnCoordinator, createComposerGuard, interruptAssistantMessage, prepareTypedMessage } from './chat-turn.ts'
import { MAX_MESSAGE_CHARS } from '../shared/chat-request.mjs'
import { DEFAULT_PERSONA } from './persona.ts'

function typedChat() {
  let id = 100
  const messages = ref([{ id: id++, role: 'assistant', text: '你好。' }])
  const draft = ref('')
  const generating = ref(false)
  const states = []
  const speech = { cancels: 0, pushes: [], deliveries: [], finishes: 0 }
  const access = { protected: false, code: '' }
  const turns = createChatTurnCoordinator({
    interrupt: id => (messages.value = interruptAssistantMessage(messages.value, id)),
    cancelSpeech: () => speech.cancels++,
    onGenerating: value => { generating.value = value; states.push(value) },
  })
  function submit() {
    let assistant
    const claim = turns.submit(() => prepareTypedMessage({
      text: draft.value, messages: messages.value, persona: DEFAULT_PERSONA, userMemory: '',
      accessProtected: access.protected, accessCode: access.code,
    }), prepared => {
      assistant = createAssistantMessage(id++)
      messages.value.push({ id: id++, role: 'user', text: prepared.text }, assistant)
      draft.value = ''
      return assistant.id
    })
    if (!claim) return null
    const { turn } = claim
    return {
      ...claim, assistant,
      delta(text) {
        if (!turns.isCurrent(turn)) return
        assistant.text += text
        assistant.source = 'deepseek'
        speech.pushes.push(text)
      },
      delivery(value) {
        if (!turns.isCurrent(turn)) return
        assistant.deliveryCues ??= []
        assistant.deliveryCues.push({ start: assistant.text.length, delivery: value })
        speech.deliveries.push(value)
      },
      release() {
        if (!turns.isCurrent(turn)) return
        speech.finishes++
        turns.finish(turn)
      },
    }
  }
  return { draft, messages, generating, states, speech, access, turns, submit }
}

test('typed barge-in claims new ownership synchronously while old release/deltas/delivery arrive late', async () => {
  const chat = typedChat()
  chat.draft.value = '先讲河边。'
  const old = chat.submit()
  old.delivery('soft')
  old.delta('先去河边。')
  let releaseOld
  const delayedOld = new Promise(resolve => { releaseOld = resolve }).then(() => {
    old.delta('不该出现的迟到内容。')
    old.delivery('happy')
    old.release()
  })
  chat.draft.value = '不，改讲公园。'
  // Typing alone never revokes the stream.
  assert.equal(old.turn.controller.signal.aborted, false)
  const fresh = chat.submit()
  assert.equal(old.turn.controller.signal.aborted, true)
  assert.equal(chat.turns.isCurrent(fresh.turn), true)
  assert.equal(chat.generating.value, true)
  assert.deepEqual(chat.states, [true, true]) // No fleeting stopped state.
  assert.equal(chat.draft.value, '')
  assert.equal(old.assistant.interrupted, true)
  assert.deepEqual(fresh.prepared.request.messages, [
    { role: 'assistant', content: '你好。' },
    { role: 'user', content: '先讲河边。' },
    { role: 'assistant', content: '先去河边。' },
    { role: 'user', content: '不，改讲公园。' },
  ])
  fresh.delta('那就去公园。')
  releaseOld()
  await delayedOld
  assert.equal(chat.generating.value, true)
  assert.equal(chat.turns.isCurrent(fresh.turn), true)
  assert.equal(old.assistant.text, '先去河边。')
  assert.deepEqual(old.assistant.deliveryCues, [{ start: 0, delivery: 'soft' }])
  assert.deepEqual(chat.speech.pushes, ['先去河边。', '那就去公园。'])
  assert.deepEqual(chat.speech.deliveries, ['soft'])
  assert.equal(chat.speech.finishes, 0)
  assert.equal(chat.turns.finish(old.turn), false)
  fresh.release()
  assert.equal(chat.generating.value, false)
  assert.equal(chat.speech.finishes, 1)
})

test('duplicate submit before a render/await and reentrant old abort cannot claim a duplicate turn', () => {
  const chat = typedChat()
  chat.draft.value = '第一句。'
  const old = chat.submit()
  let reentrant = 'not-called'
  old.turn.controller.signal.addEventListener('abort', () => { reentrant = chat.submit() })
  chat.draft.value = '更正。'
  const fresh = chat.submit()
  assert.equal(reentrant, null)
  assert.equal(chat.submit(), null)
  assert.equal(chat.turns.isCurrent(fresh.turn), true)
  assert.equal(chat.messages.value.filter(message => message.role === 'user').length, 2)
  assert.equal(chat.speech.cancels, 2)
  assert.deepEqual(chat.states, [true, true])
  assert.equal(new Set(chat.messages.value.map(message => message.id)).size, chat.messages.value.length)
})

test('invalid length/access/request and empty submissions preserve active output, draft and speech', () => {
  const chat = typedChat()
  chat.draft.value = '原来的问题。'
  const old = chat.submit()
  old.delta('正在解释。')
  const history = structuredClone(chat.messages.value.map(message => ({ ...message })))
  const invalid = [
    { text: 'x'.repeat(MAX_MESSAGE_CHARS + 1), protected: false, code: '' },
    { text: '更正。', protected: true, code: '' },
    { text: '更正。', protected: true, code: '中文体验码' },
  ]
  for (const scenario of invalid) {
    chat.draft.value = scenario.text
    Object.assign(chat.access, { protected: scenario.protected, code: scenario.code })
    assert.throws(chat.submit, TypeError)
    assert.equal(chat.draft.value, scenario.text)
    assert.equal(old.turn.controller.signal.aborted, false)
    assert.equal(chat.turns.isCurrent(old.turn), true)
    assert.deepEqual(chat.messages.value, history)
    assert.equal(chat.speech.cancels, 1)
  }
  assert.throws(() => chat.turns.submit(() => normaliseChatRequest({ messages: [] }), () => 0))
  chat.draft.value = ' \n\t '
  assert.equal(chat.submit(), null)
  assert.equal(chat.draft.value, ' \n\t ')
  assert.equal(chat.turns.isCurrent(old.turn), true)
  old.delta('继续讲。')
  assert.equal(old.assistant.text, '正在解释。继续讲。')
})

test('barge-in removes an empty placeholder and completed voice-only runs still cancel speech', () => {
  const chat = typedChat()
  chat.draft.value = '等回复。'
  const empty = chat.submit()
  chat.draft.value = '马上更正。'
  const fresh = chat.submit()
  assert.equal(chat.messages.value.includes(empty.assistant), false)
  assert.deepEqual(fresh.prepared.request.messages.map(message => message.content), ['你好。', '等回复。', '马上更正。'])
  fresh.delta('新的回复。')
  fresh.release() // Text complete, speech may still be playing/preparing.
  chat.draft.value = '语音还没说完，我继续。'
  const voiceOnly = chat.submit()
  assert.equal(chat.speech.cancels, 3)
  assert.equal(chat.turns.isCurrent(voiceOnly.turn), true)
  assert.equal(fresh.assistant.text, '新的回复。')
  assert.equal(fresh.assistant.interrupted, undefined)
})

test('manual stop invalidates ownership before abort, retains fragment, and releases generation', () => {
  const chat = typedChat()
  chat.draft.value = '问题。'
  const old = chat.submit()
  old.delta('已显示。')
  old.turn.controller.signal.addEventListener('abort', () => {
    assert.equal(chat.turns.isCurrent(old.turn), false)
    old.delta('迟到。')
  })
  assert.equal(chat.turns.stop(), true)
  assert.equal(chat.generating.value, false)
  assert.equal(old.assistant.text, '已显示。')
  assert.equal(old.assistant.interrupted, true)
  assert.equal(chat.turns.finish(old.turn), false)
})

test('composer handles real keyboard/composition event shape, confirmation cannot submit or interrupt', () => {
  const scheduled = []
  const guard = createComposerGuard(callback => scheduled.push(callback))
  const chat = typedChat()
  chat.draft.value = '旧问题。'
  const old = chat.submit()
  let lastKeydown
  const enter = (extras = {}) => {
    const event = new Event('keydown', { cancelable: true })
    Object.assign(event, { key: 'Enter', isComposing: false, keyCode: 13, ...extras })
    guard.keydown(event)
    lastKeydown = event
    if (!event.defaultPrevented && guard.canSubmit()) return chat.submit()
    return null
  }
  guard.compositionStart()
  chat.draft.value = '候选词'
  assert.equal(enter({ isComposing: true }), null)
  assert.equal(lastKeydown.defaultPrevented, false) // Candidate confirmation remains native.
  assert.equal(guard.canSubmit(), false) // Also blocks an implicit form submit.
  guard.compositionEnd()
  assert.equal(enter(), null) // compositionend-before-Enter browser ordering.
  assert.equal(lastKeydown.defaultPrevented, true)
  assert.equal(enter({ keyCode: 229 }), null)
  assert.equal(old.turn.controller.signal.aborted, false)
  assert.equal(chat.draft.value, '候选词')
  scheduled.shift()()
  assert.equal(guard.canSubmit(), false) // A stale clear cannot unlock a newer task guard.
  scheduled.splice(0).forEach(callback => callback())
  assert.equal(enter({ keyCode: 229 }), null)
  assert.equal(lastKeydown.defaultPrevented, false)
  assert.equal(old.turn.controller.signal.aborted, false)
  scheduled.splice(0).forEach(callback => callback())
  const fresh = enter()
  assert.ok(fresh)
  assert.equal(old.turn.controller.signal.aborted, true)
  assert.equal(chat.messages.value.filter(message => message.role === 'user').length, 2)
  assert.equal(enter(), null)
})

test('stream callbacks update the message and text watcher on every delta', async () => {
  const messages = ref([])
  const assistant = createAssistantMessage(7)
  messages.value.push(assistant)
  const seen = []
  const stop = watch(() => messages.value.at(-1)?.text, text => seen.push(text), { flush: 'post' })
  for (const delta of ['嗨！', '慢慢聊。', '不用赶。']) {
    assistant.text += delta
    await nextTick()
    assert.equal(messages.value.at(-1).text, assistant.text)
  }
  assert.deepEqual(seen, ['嗨！', '嗨！慢慢聊。', '嗨！慢慢聊。不用赶。'])
  stop()
})

test('interruption preserves the visible fragment, original references and delivery cue offsets', () => {
  const cues = [{ start: 2, delivery: 'soft' }]
  const assistant = { id: 7, role: 'assistant', text: '  先去河边散步。  ', delivery: 'soft', deliveryCues: cues, source: 'deepseek' }
  const user = { id: 6, role: 'user', text: '有点烦。' }
  const later = { id: 8, role: 'assistant', text: '另一条回复。' }
  const messages = [user, assistant, later]

  assert.equal(interruptAssistantMessage(messages, 7), messages)
  assert.equal(messages[1], assistant)
  assert.equal(assistant.interrupted, true)
  assert.equal(assistant.text, '  先去河边散步。  ')
  assert.equal(assistant.deliveryCues, cues)
  assert.deepEqual(cues, [{ start: 2, delivery: 'soft' }])
  assert.equal(assistant.delivery, 'soft')
  assert.equal(assistant.source, 'deepseek')
  assert.deepEqual(user, { id: 6, role: 'user', text: '有点烦。' })
  assert.deepEqual(later, { id: 8, role: 'assistant', text: '另一条回复。' })
})

test('interruption removes only an empty assistant placeholder', () => {
  for (const text of ['', ' \n\t ']) {
    const before = { id: 6, role: 'user', text: '有点烦。' }
    const placeholder = { id: 7, role: 'assistant', text }
    const after = { id: 8, role: 'assistant', text: '保留我。' }
    const messages = [before, placeholder, after]
    const interrupted = interruptAssistantMessage(messages, 7)

    assert.deepEqual(interrupted, [before, after])
    assert.equal(interrupted[0], before)
    assert.equal(interrupted[1], after)
    assert.deepEqual(messages, [before, placeholder, after])
    assert.equal(placeholder.interrupted, undefined)
  }
})

test('null, missing or user targets do not alter any message or array', () => {
  const messages = [
    { id: 6, role: 'user', text: '有点烦。' },
    { id: 7, role: 'assistant', text: '保留我。' },
  ]
  const original = structuredClone(messages)
  for (const activeId of [null, 99, 6]) {
    assert.equal(interruptAssistantMessage(messages, activeId), messages)
    assert.deepEqual(messages, original)
  }
  const empty = []
  assert.equal(interruptAssistantMessage(empty, 7), empty)
})

test('interruption updates the original reactive assistant and its watchers', async () => {
  const assistant = createAssistantMessage(7)
  assistant.text = '我刚才说过这句。'
  const messages = ref([assistant])
  const seen = []
  const stop = watch(() => assistant.interrupted, value => seen.push(value), { flush: 'post' })
  try {
    messages.value = interruptAssistantMessage(messages.value, 7)
    await nextTick()
    assert.equal(messages.value[0], assistant)
    assert.equal(assistant.interrupted, true)
    assert.deepEqual(seen, [true])
    assert.equal(interruptAssistantMessage(messages.value, 7), messages.value)
    await nextTick()
    assert.deepEqual(seen, [true])
  }
  finally { stop() }
})

test('the next chat request includes the interrupted assistant fragment without text markers', () => {
  const messages = [
    { id: 6, role: 'user', text: '有点烦。' },
    { id: 7, role: 'assistant', text: '先去河边散步。' },
  ]
  interruptAssistantMessage(messages, 7)
  const request = normaliseChatRequest({ messages: [
    ...messages.map(message => ({ role: message.role, content: message.text })),
    { role: 'user', content: '刚才你说的河边是哪里？' },
  ] })
  assert.deepEqual(request.messages, [
    { role: 'user', content: '有点烦。' },
    { role: 'assistant', content: '先去河边散步。' },
    { role: 'user', content: '刚才你说的河边是哪里？' },
  ])
})
