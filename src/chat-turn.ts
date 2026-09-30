import { reactive } from 'vue'
import type { ConversationMessage } from './conversation'

// Callbacks retain this reference. Pushing a raw object into a reactive array
// does not make later writes through that original reference reactive.
export function createAssistantMessage(id: number) {
  return reactive<ConversationMessage & { id: number }>({ id, role: 'assistant', text: '' })
}
