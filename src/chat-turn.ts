import { reactive } from 'vue'
import type { ConversationMessage } from './conversation'

// Callbacks retain this reference. Pushing a raw object into a reactive array
// does not make later writes through that original reference reactive.
export function createAssistantMessage(id: number) {
  return reactive<ConversationMessage & { id: number }>({ id, role: 'assistant', text: '' })
}

// Interrupt future output without retracting what was already displayed or heard.
// Keep the original reactive message, text and cue offsets for continued context.
export function interruptAssistantMessage<T extends ConversationMessage & { id: number }>(messages: T[], activeId: number | null): T[] {
  if (activeId === null)
    return messages
  const index = messages.findIndex(message => message.id === activeId)
  const message = messages[index]
  if (!message || message.role !== 'assistant')
    return messages
  if (message.text.trim()) {
    message.interrupted = true
    return messages
  }
  return messages.filter((_, messageIndex) => messageIndex !== index)
}
