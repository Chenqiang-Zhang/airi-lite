import type { PersonaConfig } from './persona'

export interface ChatMessage {
  role: 'assistant' | 'user'
  content: string
}

export interface ProviderStatus {
  configured: boolean
  model: string
  provider: 'deepseek'
  accessProtected: boolean
}

interface StreamEvent {
  type: 'delta' | 'done' | 'error'
  content?: string
  message?: string
}

export class ChatApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'ChatApiError'
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
  signal?: AbortSignal
  accessCode?: string
  onDelta: (content: string) => void
}) {
  const response = await fetch(`${import.meta.env.BASE_URL}api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(options.accessCode ? { 'X-Demo-Access-Code': options.accessCode } : {}),
    },
    body: JSON.stringify({
      messages: options.messages,
      persona: options.persona,
    }),
    signal: options.signal,
  })

  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { message?: string } | null
    throw new ChatApiError(payload?.message ?? 'DeepSeek 请求失败', response.status)
  }

  if (!response.body)
    throw new ChatApiError('浏览器没有收到流式响应')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let completeText = ''

  const consumeLine = (line: string) => {
    if (!line.trim())
      return

    const event = JSON.parse(line) as StreamEvent
    if (event.type === 'error')
      throw new ChatApiError(event.message ?? 'DeepSeek 流式响应中断')

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

  return completeText
}
