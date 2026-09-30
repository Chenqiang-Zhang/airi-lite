import assert from 'node:assert/strict'
import test from 'node:test'

import { buildSystemPrompt, normaliseChatRequest } from './persona.mjs'

test('normalises persona and keeps recent user/assistant messages', () => {
  const result = normaliseChatRequest({
    persona: { name: 'Hiyori', personality: '温柔而好奇', dialogueExamples: '用户：你好\n日和：来啦！' },
    messages: [
      { role: 'system', content: 'ignored' },
      { role: 'assistant', content: '你好' },
      { role: 'user', content: '今天怎么样？' },
    ],
  })

  assert.equal(result.persona.name, 'Hiyori')
  assert.match(result.persona.dialogueExamples, /来啦/)
  assert.deepEqual(result.messages, [
    { role: 'assistant', content: '你好' },
    { role: 'user', content: '今天怎么样？' },
  ])
  assert.equal(result.userMemory, '')
})

test('requires the final message to come from the user', () => {
  assert.throws(() => normaliseChatRequest({
    persona: {},
    messages: [{ role: 'assistant', content: 'hello' }],
  }), /最后一条消息/)
})

test('builds a persona-led system prompt', () => {
  const prompt = buildSystemPrompt({
    name: 'Hiyori',
    personality: '温柔而好奇',
    scenario: '住在电脑里的数字伙伴',
    speakingStyle: '自然简洁',
    behaviorGuidelines: '不知道时坦率说明',
    dialogueExamples: '用户：你好\n日和：来啦！',
  })

  assert.match(prompt, /Hiyori/)
  assert.match(prompt, /温柔而好奇/)
  assert.match(prompt, /不是需要逐条复述的台词/)
  assert.match(prompt, /不是实际聊天记录/)
  assert.match(prompt, /用户：你好/)
  assert.match(prompt, /\[\[tone:soft\]\]/)
  assert.match(prompt, /没有读取用户浏览器标签页/)
  assert.match(prompt, /不要用“刚才看到”/)
  assert.match(prompt, /用户明确更正的信息，优先于旧的保存记忆/)
  assert.match(prompt, /不把自己的建议当成用户已经答应/)
  assert.match(prompt, /不补造共同经历/)
})

test('bounds opt-in user memory and includes it only when provided', () => {
  const result = normaliseChatRequest({
    persona: {},
    messages: [{ role: 'user', content: '还记得我吗？' }],
    userMemory: `  可以叫我小陈。${'a'.repeat(2_000)}  `,
  })
  assert.equal(result.userMemory.length, 1_200)
  const prompt = buildSystemPrompt(result.persona, result.userMemory)
  assert.match(prompt, /用户主动保存的背景信息/)
  assert.match(prompt, /可以叫我小陈/)
  assert.match(prompt, /可能过时/)
  assert.ok(prompt.indexOf('没有读取用户浏览器标签页') > prompt.indexOf('用户主动保存的背景信息'))

  const withoutMemory = buildSystemPrompt(result.persona)
  assert.doesNotMatch(withoutMemory, /用户主动保存的背景信息/)
})

test('carries bounded character preferences to the prompt without a default for custom cards', () => {
  const result = normaliseChatRequest({
    persona: { name: '小遥', preferences: `  偏爱咸味。${'a'.repeat(2_100)}  ` },
    messages: [{ role: 'user', content: '喜欢什么？' }],
  })
  assert.equal(result.persona.preferences.length, 2_000)
  assert.ok(result.persona.preferences.startsWith('偏爱咸味。'))
  const prompt = buildSystemPrompt(result.persona)
  assert.match(prompt, /稳定偏好与小习惯：偏爱咸味/)
  assert.match(prompt, /不因为对方要求附和就临时改口/)
  assert.doesNotMatch(prompt, /草莓/)
  for (const preferences of [undefined, '', '  ']) {
    const empty = normaliseChatRequest({
      persona: { name: '小遥', preferences },
      messages: [{ role: 'user', content: '你好' }],
    })
    assert.equal(empty.persona.preferences, '')
    assert.doesNotMatch(buildSystemPrompt(empty.persona), /稳定偏好与小习惯/)
  }
})
