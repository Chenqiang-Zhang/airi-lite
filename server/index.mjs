import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildSystemPrompt, normaliseChatRequest } from './persona.mjs'

const rootDirectory = resolve(fileURLToPath(new URL('..', import.meta.url)))
const production = process.env.NODE_ENV === 'production'
const port = safeNumber(process.env.PORT, 5173, 1, 65_535)
const host = process.env.HOST?.trim() || '127.0.0.1'
const model = process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-flash'
const baseUrl = process.env.DEEPSEEK_BASE_URL?.trim() || 'https://api.deepseek.com'
const accessCode = process.env.AIRI_DEMO_ACCESS_CODE?.trim() || ''
const rateWindows = new Map()
let activeChats = 0

if (production && accessCode.length < 16)
  throw new Error('Production requires AIRI_DEMO_ACCESS_CODE with at least 16 characters')

const vite = production
  ? null
  : await import('vite').then(({ createServer }) => createServer({
      root: rootDirectory,
      appType: 'spa',
      server: { middlewareMode: true },
    }))

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    const pathname = url.pathname.startsWith('/airi/') ? url.pathname.slice('/airi'.length) : url.pathname

    if (url.pathname === '/airi') {
      response.writeHead(308, { Location: '/airi/' })
      return response.end()
    }

    if (request.method === 'GET' && pathname === '/api/health') {
      return sendJson(response, 200, {
        configured: Boolean(process.env.DEEPSEEK_API_KEY?.trim()),
        model,
        provider: 'deepseek',
        accessProtected: Boolean(accessCode),
      })
    }

    if (request.method === 'POST' && pathname === '/api/chat')
      return await handleProtectedChat(request, response)

    if (pathname.startsWith('/api/'))
      return sendJson(response, 404, { message: 'API 路径不存在' })

    if (vite)
      return vite.middlewares(request, response)

    return await serveProductionFile(pathname, response)
  }
  catch (error) {
    console.error(error)
    if (!response.headersSent)
      sendJson(response, 500, { message: '本地服务发生了意外错误' })
    else
      response.end()
  }
})

server.listen(port, host, () => {
  console.log(`AIRI Lite running at http://${host}:${port}/airi/`)
  console.log(`DeepSeek: ${process.env.DEEPSEEK_API_KEY?.trim() ? `configured (${model})` : 'not configured; local fallback enabled'}`)
})

async function handleProtectedChat(request, response) {
  const ip = clientIp(request)
  if (!acceptRate(ip))
    return sendJson(response, 429, { message: '请求太频繁，请稍后再试。' })

  if (accessCode && !validCode(request.headers['x-demo-access-code']))
    return sendJson(response, 401, { message: '体验码不正确，请重新输入。' })

  if (activeChats >= 4)
    return sendJson(response, 503, { message: '当前体验人数较多，请稍后再试。' })

  activeChats++
  try {
    return await handleChat(request, response)
  }
  finally {
    activeChats--
  }
}

function validCode(candidate) {
  if (typeof candidate !== 'string')
    return false
  const actual = Buffer.from(accessCode)
  const supplied = Buffer.from(candidate)
  return supplied.length === actual.length && timingSafeEqual(supplied, actual)
}

function clientIp(request) {
  const remote = request.socket.remoteAddress ?? 'unknown'
  if (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1')
    return String(request.headers['x-real-ip'] ?? remote).slice(0, 64)
  return remote
}

function acceptRate(ip) {
  const now = Date.now()
  const window = rateWindows.get(ip) ?? []
  const recent = window.filter(time => now - time < 10 * 60_000)
  if (recent.length >= 30)
    return false
  recent.push(now)
  rateWindows.set(ip, recent)
  if (rateWindows.size > 2_000) {
    for (const [key, times] of rateWindows) {
      if (times.at(-1) < now - 10 * 60_000)
        rateWindows.delete(key)
    }
  }
  return true
}

async function handleChat(request, response) {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim()
  if (!apiKey) {
    return sendJson(response, 503, {
      code: 'DEEPSEEK_NOT_CONFIGURED',
      message: 'DeepSeek API Key 尚未配置，当前使用本地演示回复。',
    })
  }

  let chatRequest
  try {
    chatRequest = normaliseChatRequest(await readJson(request))
  }
  catch (error) {
    return sendJson(response, 400, {
      message: error instanceof Error ? error.message : '聊天请求格式无效',
    })
  }

  const abortController = new AbortController()
  response.on('close', () => abortController.abort())

  const upstream = await fetch(new URL('chat/completions', ensureTrailingSlash(baseUrl)), {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: buildSystemPrompt(chatRequest.persona) },
        ...chatRequest.messages,
      ],
      stream: true,
      stream_options: { include_usage: true },
      thinking: { type: 'disabled' },
      max_tokens: safeNumber(process.env.DEEPSEEK_MAX_TOKENS, 320, 32, 4_096),
      temperature: safeNumber(process.env.DEEPSEEK_TEMPERATURE, 0.8, 0, 2),
    }),
    signal: AbortSignal.any([
      abortController.signal,
      AbortSignal.timeout(90_000),
    ]),
  })

  if (!upstream.ok) {
    const detail = await upstream.json().catch(() => null)
    const providerMessage = detail?.error?.message
    return sendJson(response, 502, {
      message: providerMessage
        ? `DeepSeek：${String(providerMessage).slice(0, 240)}`
        : `DeepSeek 请求失败（HTTP ${upstream.status}）`,
    })
  }

  if (!upstream.body)
    return sendJson(response, 502, { message: 'DeepSeek 没有返回响应内容' })

  response.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-store',
    'X-Content-Type-Options': 'nosniff',
  })

  try {
    await relayDeepSeekStream(upstream.body, response)
    writeEvent(response, { type: 'done' })
  }
  catch (error) {
    if (!abortController.signal.aborted) {
      writeEvent(response, {
        type: 'error',
        message: error instanceof Error ? error.message : 'DeepSeek 流式响应中断',
      })
    }
  }
  finally {
    response.end()
  }
}

async function relayDeepSeekStream(body, response) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const consumeLine = (line) => {
    if (!line.startsWith('data:'))
      return

    const data = line.slice(5).trim()
    if (!data || data === '[DONE]')
      return

    const chunk = JSON.parse(data)
    const content = chunk.choices?.[0]?.delta?.content
    if (typeof content === 'string' && content)
      writeEvent(response, { type: 'delta', content })
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
}

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 128_000)
      throw new TypeError('请求内容过大')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function serveProductionFile(pathname, response) {
  const distDirectory = join(rootDirectory, 'dist')
  const requested = resolve(distDirectory, `.${decodeURIComponent(pathname)}`)
  const safePath = requested.startsWith(`${distDirectory}${sep}`) ? requested : join(distDirectory, 'index.html')

  let filePath = safePath
  try {
    const info = await stat(filePath)
    if (!info.isFile())
      filePath = join(distDirectory, 'index.html')
  }
  catch {
    filePath = join(distDirectory, 'index.html')
  }

  response.writeHead(200, {
    'Content-Type': mimeType(filePath),
    'Cache-Control': filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
  })
  createReadStream(filePath).pipe(response)
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  response.end(JSON.stringify(payload))
}

function writeEvent(response, event) {
  response.write(`${JSON.stringify(event)}\n`)
}

function ensureTrailingSlash(value) {
  return value.endsWith('/') ? value : `${value}/`
}

function safeNumber(value, fallback, minimum, maximum) {
  const number = Number(value)
  return Number.isFinite(number)
    ? Math.min(maximum, Math.max(minimum, number))
    : fallback
}

function mimeType(filePath) {
  return ({
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
  })[extname(filePath)] ?? 'application/octet-stream'
}
