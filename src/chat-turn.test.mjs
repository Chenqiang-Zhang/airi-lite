import assert from 'node:assert/strict'
import test from 'node:test'
import { nextTick, ref, watch } from 'vue'
import { normaliseChatRequest } from '../shared/chat-request.mjs'
import { createAssistantMessage, interruptAssistantMessage } from './chat-turn.ts'

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
