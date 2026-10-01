import type { Delivery } from './delivery'
import { normaliseDeliveryCues } from './speech-sentences.ts'
import type { DeliveryCue } from './speech-sentences'
import { MAX_CHAT_MESSAGES, MAX_MESSAGE_CHARS } from '../shared/chat-request.mjs'

export interface ConversationMessage {
  role: 'assistant' | 'user'
  text: string
  delivery?: Delivery
  deliveryCues?: DeliveryCue[]
  source?: 'deepseek' | 'fallback'
  interrupted?: true
}

export const CONVERSATION_STORAGE_KEY = 'airi-lite:conversation:v1'
export const CONVERSATION_STORAGE_BYTES = 512_000

const deliveries = new Set<Delivery>(['neutral', 'soft', 'bright', 'curious'])
const encoder = new TextEncoder()

function normaliseMessages(value: unknown): ConversationMessage[] {
  if (!Array.isArray(value))
    return []

  const normalised = value
    .filter(item => item && (item.role === 'assistant' || item.role === 'user') && typeof item.text === 'string')
    .map((item) => {
      const message: ConversationMessage = {
        role: item.role,
        text: item.text.trim().slice(0, MAX_MESSAGE_CHARS),
      }
      if (deliveries.has(item.delivery))
        message.delivery = item.delivery
      if (item.role === 'assistant') {
        if (item.interrupted === true)
          message.interrupted = true
        const leading = item.text.length - item.text.trimStart().length
        const cues = normaliseDeliveryCues(
          normaliseDeliveryCues(item.deliveryCues, item.text.length)
            .map(cue => ({ ...cue, start: Math.max(0, cue.start - leading) })),
          message.text.length,
        )
        if (cues.length)
          message.deliveryCues = cues
      }
      if (item.source === 'deepseek' || item.source === 'fallback')
        message.source = item.source
      return message
    })
    .filter(message => message.text)
  const retained = normalised.slice(-MAX_CHAT_MESSAGES)
  const sizes = retained.map(message => encoder.encode(JSON.stringify(message)).length)
  let start = 0
  let bytes = 2 + sizes.reduce((sum, size) => sum + size + 1, -1)
  while (bytes > CONVERSATION_STORAGE_BYTES || (start === 0 && normalised.length > retained.length && retained[start]?.role === 'assistant')) {
    // Drop a whole old turn rather than restoring an orphan assistant reply.
    do {
      bytes -= (sizes[start] ?? 0) + 1
      start++
    } while (retained[start]?.role === 'assistant')
  }
  return retained.slice(start)
}

export function loadConversation(storage: Storage = window.sessionStorage): ConversationMessage[] {
  try {
    return normaliseMessages(JSON.parse(storage.getItem(CONVERSATION_STORAGE_KEY) ?? 'null'))
  }
  catch {
    return []
  }
}

export function saveConversation(messages: ConversationMessage[], storage: Storage = window.sessionStorage): void {
  try {
    storage.setItem(CONVERSATION_STORAGE_KEY, JSON.stringify(normaliseMessages(messages)))
  }
  catch {
    // Storage can be disabled or full; chat still works for the current page.
  }
}

export function clearConversation(storage: Storage = window.sessionStorage): void {
  try {
    storage.removeItem(CONVERSATION_STORAGE_KEY)
  }
  catch {
    // Private browsing may deny session storage; clearing the visible chat still works.
  }
}
