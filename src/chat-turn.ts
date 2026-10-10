import { reactive } from 'vue'
import type { ConversationMessage } from './conversation'
import type { PersonaConfig } from './persona'
import { MAX_MESSAGE_CHARS, normaliseChatRequest } from '../shared/chat-request.mjs'
import { INVALID_ACCESS_CODE_MESSAGE, isValidAccessCode } from './access-code.ts'

// Validate without mutating the draft, history, or the currently running turn.
export function prepareTypedMessage(options: {
  text: string, messages: ConversationMessage[], persona: PersonaConfig, userMemory: string,
  accessProtected: boolean, accessCode: string,
}) {
  const text = options.text.trim()
  if (!text) return null
  if (text.length > MAX_MESSAGE_CHARS)
    throw new TypeError(`消息太长，请缩短到 ${MAX_MESSAGE_CHARS} 字符以内。`)
  if (options.accessProtected && !options.accessCode)
    throw new TypeError('请先输入体验码。')
  if (options.accessCode && !isValidAccessCode(options.accessCode))
    throw new TypeError(INVALID_ACCESS_CODE_MESSAGE)
  const request = normaliseChatRequest({
    messages: [
      ...options.messages.filter(message => message.source !== 'fallback')
        .map(message => ({ role: message.role, content: message.text })),
      { role: 'user', content: text },
    ],
    persona: options.persona,
    userMemory: options.userMemory,
  })
  return { text, request, accessCode: options.accessCode }
}

export interface ChatTurn {
  controller: AbortController
  assistantId: number | null
}

// Ownership changes before abort/cancel callbacks or any await. An old run can
// settle at any time, but only the current owner may touch shared UI or speech.
export function createChatTurnCoordinator(options: {
  interrupt: (assistantId: number | null) => void,
  cancelSpeech: () => void,
  onGenerating: (generating: boolean) => void,
}) {
  let current: ChatTurn | null = null
  let claiming = false
  const isCurrent = (turn: ChatTurn) => current === turn && !turn.controller.signal.aborted
  function revoke() {
    const old = current
    current = null
    if (old) {
      old.controller.abort()
      options.interrupt(old.assistantId)
    }
    options.cancelSpeech()
    return old
  }
  return {
    isCurrent,
    submit<T>(prepare: () => T | null, begin: (prepared: T, turn: ChatTurn) => number) {
      if (claiming) return null
      claiming = true
      try {
        const prepared = prepare()
        if (prepared === null) return null
        revoke()
        const turn: ChatTurn = { controller: new AbortController(), assistantId: null }
        current = turn
        options.onGenerating(true)
        turn.assistantId = begin(prepared, turn)
        return { prepared, turn }
      }
      finally { claiming = false }
    },
    finish(turn: ChatTurn) {
      if (!isCurrent(turn)) return false
      current = null
      options.onGenerating(false)
      return true
    },
    stop() {
      const old = revoke()
      options.onGenerating(false)
      return old !== null
    },
  }
}

// Some IMEs end composition just before the confirming Enter keydown. Retain
// the guard through that event's task as well as checking native composition.
export function createComposerGuard(schedule = (callback: () => void) => setTimeout(callback, 0)) {
  let composing = false
  let completing = false
  let revision = 0
  function finishTask() {
    completing = true
    const ended = ++revision
    schedule(() => { if (ended === revision) completing = false })
  }
  return {
    compositionStart() { composing = true; completing = false; revision++ },
    compositionEnd() {
      composing = false
      finishTask()
    },
    keydown(event: Pick<KeyboardEvent, 'key' | 'isComposing' | 'keyCode' | 'preventDefault'>) {
      if (event.key !== 'Enter') return
      if (composing || event.isComposing || event.keyCode === 229) {
        // Do not cancel the IME's candidate-confirmation default action. Guard
        // a possible implicit form submit for this same task instead.
        finishTask()
      }
      else if (completing) {
        event.preventDefault()
      }
    },
    canSubmit: () => !composing && !completing,
  }
}

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
