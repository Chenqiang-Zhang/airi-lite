export const MAX_CHAT_MESSAGES: number
export const MAX_MESSAGE_CHARS: number
export const MAX_CONTEXT_BYTES: number
export const MAX_REQUEST_BYTES: number

export interface NormalisedChatRequest {
  persona: {
    name: string
    personality: string
    preferences: string
    scenario: string
    speakingStyle: string
    behaviorGuidelines: string
    dialogueExamples: string
    greeting: string
  }
  userMemory: string
  messages: { role: 'user' | 'assistant', content: string }[]
}

export function normaliseChatRequest(payload: unknown): NormalisedChatRequest
