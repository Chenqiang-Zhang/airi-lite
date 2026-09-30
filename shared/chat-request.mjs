// Shared by the browser and server: keep original recent turns, not an inferred
// summary. Count serialized UTF-8 bytes, including JSON escaping and metadata.
export const MAX_CHAT_MESSAGES = 160
export const MAX_MESSAGE_CHARS = 8_000
export const MAX_CONTEXT_BYTES = 80_000
export const MAX_REQUEST_BYTES = 120_000

const encoder = new TextEncoder()
const jsonBytes = value => encoder.encode(JSON.stringify(value)).length
const text = (value, limit = 2_000) => typeof value === 'string' ? value.trim().slice(0, limit) : ''

export function normaliseChatRequest(payload) {
  if (!payload || typeof payload !== 'object')
    throw new TypeError('请求内容必须是 JSON 对象')

  const input = payload.persona && typeof payload.persona === 'object' ? payload.persona : {}
  const persona = {
    name: text(input.name) || 'Hiyori',
    personality: text(input.personality),
    preferences: text(input.preferences),
    scenario: text(input.scenario),
    speakingStyle: text(input.speakingStyle),
    behaviorGuidelines: text(input.behaviorGuidelines),
    dialogueExamples: text(input.dialogueExamples),
    greeting: text(input.greeting, 1_000),
  }
  if (!Array.isArray(payload.messages))
    throw new TypeError('messages 必须是数组')

  const valid = payload.messages
    .filter(message => message && (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string')
    .map(message => ({ role: message.role, content: message.content.trim() }))
    .filter(message => message.content)
  if (!valid.length || valid.at(-1).role !== 'user')
    throw new TypeError('最后一条消息必须来自用户')
  // The ending may contain a correction. Never silently chop off the latest
  // user message; the UI retains the draft when this limit is exceeded.
  if (valid.at(-1).content.length > MAX_MESSAGE_CHARS)
    throw new TypeError(`消息太长，请缩短到 ${MAX_MESSAGE_CHARS} 字符以内。`)

  const result = { persona, userMemory: text(payload.userMemory, 1_200), messages: [] }
  const available = Math.min(MAX_CONTEXT_BYTES, MAX_REQUEST_BYTES - jsonBytes(result) + 2)
  const recent = valid.slice(-MAX_CHAT_MESSAGES)
    .map(message => ({ ...message, content: message.content.slice(0, MAX_MESSAGE_CHARS) }))

  // A turn starts at a user message. Consecutive users (e.g. after interruption)
  // are separate valid turns. An initial assistant greeting is optional.
  const turns = []
  for (const message of recent) {
    if (message.role === 'user' || !turns.length)
      turns.push([])
    turns.at(-1).push(message)
  }
  let bytes = 2
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index]
    if (turn[0].role === 'assistant' && valid.length > recent.length)
      break // The corresponding user was outside the retained window.
    const turnBytes = jsonBytes(turn) - 2 + (result.messages.length ? 1 : 0)
    if (bytes + turnBytes > available)
      break // Keep a contiguous suffix, never skip a turn to backfill old ones.
    result.messages.unshift(...turn)
    bytes += turnBytes
  }
  if (!result.messages.length)
    throw new TypeError('当前消息与人格内容过大，请缩短消息或精简人格。')
  return result
}
