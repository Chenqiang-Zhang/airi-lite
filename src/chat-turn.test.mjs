import assert from 'node:assert/strict'
import test from 'node:test'
import { nextTick, ref, watch } from 'vue'
import { createAssistantMessage } from './chat-turn.ts'

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
