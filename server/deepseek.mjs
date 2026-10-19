import { createDeliveryCueParser } from './delivery-cue.mjs'

// One streaming chat completion, shared by /api/chat and the live brain.
// An HTTP failure or a missing body rejects with DeepSeekRequestError (the
// caller maps it to 502); a rejected fetch (network error, timeout before
// headers, caller abort) propagates unchanged.
export class DeepSeekRequestError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export async function openDeepSeekStream({
  apiKey,
  baseUrl,
  model,
  messages,
  maxTokens,
  temperature,
  signal,
  fetchImpl = fetch,
  timeoutMs = 90_000,
}) {
  const upstream = await fetchImpl(new URL('chat/completions', ensureTrailingSlash(baseUrl)), {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      thinking: { type: 'disabled' },
      max_tokens: maxTokens,
      temperature,
    }),
    signal: AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(timeoutMs),
    ]),
  })

  if (!upstream.ok) {
    const detail = await upstream.json().catch(() => null)
    const providerMessage = detail?.error?.message
    throw new DeepSeekRequestError(502, providerMessage
      ? `DeepSeek：${String(providerMessage).slice(0, 240)}`
      : `DeepSeek 请求失败（HTTP ${upstream.status}）`)
  }

  if (!upstream.body)
    throw new DeepSeekRequestError(502, 'DeepSeek 没有返回响应内容')

  return {
    // Emits {type:'delta'|'delivery'} events in order; resolves with whether
    // max_tokens cut the reply and the provider's token usage, if reported.
    relay: onEvent => relayDeepSeekStream(upstream.body, onEvent),
  }
}

async function relayDeepSeekStream(body, onEvent) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let truncated = false
  let usage = null
  const deliveryCue = createDeliveryCueParser()

  const consumeLine = (line) => {
    if (!line.startsWith('data:'))
      return

    const data = line.slice(5).trim()
    if (!data || data === '[DONE]')
      return

    const chunk = JSON.parse(data)
    // max_tokens stops the reply mid-thought; tell the browser it was cut off.
    if (chunk.choices?.[0]?.finish_reason === 'length')
      truncated = true
    if (chunk.usage && typeof chunk.usage === 'object')
      usage = chunk.usage
    const content = chunk.choices?.[0]?.delta?.content
    if (typeof content === 'string' && content) {
      for (const event of deliveryCue.push(content))
        onEvent(event)
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines)
      consumeLine(line.trimEnd())
    if (done)
      break
  }

  consumeLine(buffer.trimEnd())
  for (const event of deliveryCue.finish())
    onEvent(event)
  return { truncated, usage }
}

function ensureTrailingSlash(value) {
  return value.endsWith('/') ? value : `${value}/`
}
