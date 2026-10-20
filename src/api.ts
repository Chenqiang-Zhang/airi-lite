import type { PersonaConfig } from './persona'
import type { Delivery } from './delivery'
import { INVALID_ACCESS_CODE_MESSAGE, isValidAccessCode } from './access-code.ts'
import { normaliseChatRequest } from '../shared/chat-request.mjs'

export interface ChatMessage {
  role: 'assistant' | 'user'
  content: string
}

export interface ProviderStatus {
  configured: boolean
  model: string
  provider: 'deepseek'
  accessProtected: boolean
  speech?: {
    configured: boolean
    provider: 'minimax' | 'elevenlabs' | 'local' | 'unavailable'
    model: string
    region?: 'cn' | 'global' | null
  }
}

interface StreamEvent {
  type: 'delta' | 'delivery' | 'done' | 'error'
  content?: string
  message?: string
  value?: string
  truncated?: boolean
}

export interface ChatResult {
  text: string
  truncated: boolean
}

export class ChatApiError extends Error {
  readonly status?: number
  readonly code?: string

  constructor(message: string, status?: number, code?: string) {
    super(message)
    this.name = 'ChatApiError'
    this.status = status
    this.code = code
  }
}

export async function fetchProviderStatus(): Promise<ProviderStatus> {
  const response = await fetch(`${import.meta.env.BASE_URL}api/health`)
  if (!response.ok)
    throw new ChatApiError('无法读取模型服务状态', response.status)

  return response.json() as Promise<ProviderStatus>
}

export async function streamChat(options: {
  messages: ChatMessage[]
  persona: PersonaConfig
  userMemory?: string
  signal?: AbortSignal
  accessCode?: string
  onDelta: (content: string) => void
  onDelivery?: (delivery: Delivery) => void
}): Promise<ChatResult> {
  if (options.accessCode && !isValidAccessCode(options.accessCode))
    throw new ChatApiError(INVALID_ACCESS_CODE_MESSAGE)

  // Node tests run this without Vite's import.meta.env.
  const response = await fetch(`${import.meta.env?.BASE_URL ?? '/'}api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(options.accessCode ? { 'X-Demo-Access-Code': options.accessCode } : {}),
    },
    body: JSON.stringify(normaliseChatRequest({
      messages: options.messages,
      persona: options.persona,
      userMemory: options.userMemory,
    })),
    signal: options.signal,
  })

  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { code?: string, message?: string } | null
    throw new ChatApiError(payload?.message ?? 'DeepSeek 请求失败', response.status, payload?.code)
  }

  if (!response.body)
    throw new ChatApiError('浏览器没有收到流式响应')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let completeText = ''
  let truncated = false

  const consumeLine = (line: string) => {
    if (!line.trim())
      return

    const event = JSON.parse(line) as StreamEvent
    if (event.type === 'error')
      throw new ChatApiError(event.message ?? 'DeepSeek 流式响应中断')

    if (event.type === 'done' && event.truncated === true)
      truncated = true

    if (event.type === 'delivery' && ['neutral', 'soft', 'bright', 'curious'].includes(event.value ?? ''))
      options.onDelivery?.(event.value as Delivery)

    if (event.type === 'delta' && event.content) {
      completeText += event.content
      options.onDelta(event.content)
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })

    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines)
      consumeLine(line)

    if (done)
      break
  }

  consumeLine(buffer)
  if (!completeText.trim())
    throw new ChatApiError('DeepSeek 返回了空回复')

  return { text: completeText, truncated }
}
