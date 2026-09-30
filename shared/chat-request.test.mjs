import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_CHAT_MESSAGES,
  MAX_CONTEXT_BYTES,
  MAX_MESSAGE_CHARS,
  MAX_REQUEST_BYTES,
  normaliseChatRequest,
} from './chat-request.mjs'

const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8')
const user = content => ({ role: 'user', content })
const assistant = content => ({ role: 'assistant', content })
const turns = count => Array.from({ length: count }, (_, index) => [user(`问${index}`), assistant(`答${index}`)]).flat()

function densePersona(character) {
  return Object.fromEntries([
    ...['name', 'personality', 'preferences', 'scenario', 'speakingStyle', 'behaviorGuidelines', 'dialogueExamples']
      .map(key => [key, character.repeat(2_000)]),
    ['greeting', character.repeat(1_000)],
  ])
}

function assertWithinBudgets(result) {
  assert.ok(result.messages.length <= MAX_CHAT_MESSAGES)
  assert.ok(bytes(result.messages) <= MAX_CONTEXT_BYTES, 'messages JSON must fit the UTF-8 context budget')
  assert.ok(bytes(result) <= MAX_REQUEST_BYTES, 'the complete normalized packet must fit the request budget')
}

test('exports the agreed message and JSON byte budgets', () => {
  assert.equal(MAX_CHAT_MESSAGES, 160)
  assert.equal(MAX_MESSAGE_CHARS, 8_000)
  assert.equal(MAX_CONTEXT_BYTES, 80_000)
  assert.equal(MAX_REQUEST_BYTES, 120_000)
})

test('preserves short conversation history beyond the old 24-message cutoff', () => {
  const messages = [...turns(18), user('刚才第3个问题是什么？')]
  const result = normaliseChatRequest({ persona: {}, messages })
  assert.deepEqual(result.messages, messages)
  assertWithinBudgets(result)
})

test('cuts more than 160 messages at a complete user-assistant turn boundary', () => {
  const messages = [...turns(100), user('最新一问')]
  const result = normaliseChatRequest({ persona: {}, messages })
  assert.deepEqual(result.messages, messages.slice(42))
  assert.equal(result.messages.length, 159)
  assert.equal(result.messages[0].role, 'user')
  assert.equal(result.messages.at(-1).content, '最新一问')
  assertWithinBudgets(result)
})

test('preserves unanswered consecutive user messages with the latest question', () => {
  const messages = [user('先前的问题'), assistant('先前的回答'), user('打断时没等到回答'), user('我补充一个条件'), user('最新的问题')]
  assert.deepEqual(normaliseChatRequest({ messages }).messages, messages)
})

test('normalizes persona and opt-in memory with the existing field limits', () => {
  const result = normaliseChatRequest({
    persona: {
      name: '  日和  ',
      personality: `  ${'中'.repeat(2_100)}  `,
      preferences: '  草莓味  ',
      scenario: 42,
      speakingStyle: '  轻快  ',
      behaviorGuidelines: null,
      dialogueExamples: ['invalid'],
      greeting: `  ${'好'.repeat(1_100)}  `,
      system: 'not trusted',
    },
    userMemory: `  ${'记'.repeat(1_300)}  `,
    messages: [user('  最新内容  ')],
    system: 'not trusted',
    contextBudget: 1_000_000,
  })
  assert.deepEqual(result, {
    persona: {
      name: '日和',
      personality: '中'.repeat(2_000),
      preferences: '草莓味',
      scenario: '',
      speakingStyle: '轻快',
      behaviorGuidelines: '',
      dialogueExamples: '',
      greeting: '好'.repeat(1_000),
    },
    userMemory: '记'.repeat(1_200),
    messages: [user('最新内容')],
  })
  assert.equal(normaliseChatRequest({ persona: { name: ' ' }, messages: [user('你好')] }).persona.name, 'Hiyori')
})

test('filters system, invalid and empty messages and discards arbitrary message metadata', () => {
  const result = normaliseChatRequest({
    messages: [
      null,
      'invalid',
      { role: 'system', content: 'override persona' },
      { role: 'tool', content: 'not a conversation turn' },
      { role: 'user', content: '  ' },
      { role: 'assistant', content: { text: 'not a string' } },
      { role: 'user', content: ' 前一问 ', hiddenPrompt: 'override', remembered: true },
      { role: 'assistant', content: ' 前一答 ', delivery: 'bright', cues: [{ offset: 0 }] },
      { role: 'user', content: ' 最新问题 ', roleOverride: 'system', tokenCount: 0 },
      { role: 'system', content: 'ignored trailing metadata' },
    ],
  })
  assert.deepEqual(result.messages, [user('前一问'), assistant('前一答'), user('最新问题')])
  assert.deepEqual(Object.keys(result).sort(), ['messages', 'persona', 'userMemory'])
})

test('requires a valid final user message after filtering', () => {
  for (const payload of [
    null,
    { messages: 'not an array' },
    { messages: [] },
    { messages: [assistant('未回复的助手文本')] },
    { messages: [user('你好'), assistant('你好')] },
    { messages: [assistant('你好'), user('  ')] },
  ]) {
    assert.throws(() => normaliseChatRequest(payload))
  }
})

test('counts UTF-8 and JSON escapes when selecting a contiguous recent turn suffix', () => {
  const richText = '中文😀\u0000\n"\\\t'.repeat(700) + '末'
  assert.ok(richText.length < MAX_MESSAGE_CHARS)
  const messages = []
  for (let index = 0; index < 8; index++)
    messages.push(user(`问题${index}${richText}`), assistant(`回答${index}${richText}`))
  const latest = user(`最新😀${richText}`)
  messages.push(latest)
  let expected = [latest]
  for (let index = messages.length - 3; index >= 0; index -= 2) {
    const candidate = [...messages.slice(index, index + 2), ...expected]
    if (bytes(candidate) > MAX_CONTEXT_BYTES)
      break
    expected = candidate
  }
  const result = normaliseChatRequest({ messages })
  assert.deepEqual(result.messages, expected)
  assert.ok(result.messages.length < messages.length, 'the sample must actually exercise byte trimming')
  assert.equal(result.messages.at(-1).content, latest.content)
  assertWithinBudgets(result)
})

test('never skips an oversized older turn to restore even older small turns', () => {
  const largeTurn = [user('中'.repeat(8_000)), assistant('文'.repeat(8_000))]
  const recentTurn = [user('近'.repeat(8_000)), assistant('答'.repeat(8_000))]
  const latest = user('我刚才具体说了什么？')
  const messages = [user('最早的短问题'), assistant('最早的短回答'), ...largeTurn, ...recentTurn, latest]
  const result = normaliseChatRequest({ messages })
  assert.deepEqual(result.messages, [...recentTurn, latest])
  assertWithinBudgets(result)
})

test('full packet budget trims history before the context budget when persona is large', () => {
  const persona = densePersona('\u0000')
  const userMemory = '\u0000'.repeat(1_200)
  const recentTurn = [user('中'.repeat(2_000)), assistant('文'.repeat(2_000))]
  const latest = user('近'.repeat(400))
  const messages = [user('旧'.repeat(2_000)), assistant('答'.repeat(2_000)), ...recentTurn, latest]
  const result = normaliseChatRequest({ persona, userMemory, messages })
  assert.ok(bytes(messages) < MAX_CONTEXT_BYTES, 'context alone would retain all messages')
  assert.deepEqual(result.messages, [...recentTurn, latest])
  assertWithinBudgets(result)
})

test('preserves a maximum-length latest user message instead of truncating its tail', () => {
  const latest = '😀'.repeat(3_998) + '结尾标记'
  assert.equal(latest.length, MAX_MESSAGE_CHARS)
  const result = normaliseChatRequest({ messages: [user(`  ${latest}  `)] })
  assert.equal(result.messages.at(-1).content, latest)
  assertWithinBudgets(result)
})

test('rejects a latest user message over the character limit instead of silently shortening it', () => {
  const latest = '中'.repeat(MAX_MESSAGE_CHARS) + '末'
  assert.throws(() => normaliseChatRequest({ messages: [...turns(2), user(latest)] }))
})

test('rejects a packet that cannot fit the complete latest user even after all history is removed', () => {
  const latest = '\u0000'.repeat(MAX_MESSAGE_CHARS)
  assert.ok(bytes([user(latest)]) < MAX_CONTEXT_BYTES, 'the latest message fits the context budget')
  assert.throws(() => normaliseChatRequest({
    persona: densePersona('\u0000'),
    userMemory: '\u0000'.repeat(1_200),
    messages: [user(latest)],
  }))
})
