import type { Delivery } from './delivery'

export interface ConversationMessage {
  role: 'assistant' | 'user'
  text: string
  delivery?: Delivery
}

export const CONVERSATION_STORAGE_KEY = 'airi-lite:conversation:v1'

const MAX_MESSAGES = 24
const MAX_TEXT_LENGTH = 8_000
const deliveries = new Set<Delivery>(['neutral', 'soft', 'bright', 'curious'])

function normaliseMessages(value: unknown): ConversationMessage[] {
  if (!Array.isArray(value))
    return []

  return value
    .filter(item => item && (item.role === 'assistant' || item.role === 'user') && typeof item.text === 'string')
    .map((item) => {
      const message: ConversationMessage = {
        role: item.role,
        text: item.text.trim().slice(0, MAX_TEXT_LENGTH),
      }
      if (deliveries.has(item.delivery))
        message.delivery = item.delivery
      return message
    })
    .filter(message => message.text)
    .slice(-MAX_MESSAGES)
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
