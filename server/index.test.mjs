import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { createRequestHandler, readServerConfig } from './app.mjs'

// Fake credentials only. `.invalid` never resolves, and every handler below
// gets an injected fetch, so no test can reach the real DeepSeek API.
const ACCESS_CODE = 'test-access-code-0123'
const API_KEY = 'sk-test-key-do-not-leak'
const env = Object.freeze({
  DEEPSEEK_API_KEY: API_KEY,
  DEEPSEEK_BASE_URL: 'https://deepseek.invalid/v1',
  AIRI_DEMO_ACCESS_CODE: ACCESS_CODE,
})
const chatBody = JSON.stringify({ messages: [{ role: 'user', content: '你好' }] })
const encoder = new TextEncoder()
const line = content => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
const unexpectedFetch = async () => { throw new Error('this test must not call DeepSeek') }

function sse(text, pieceBytes = Infinity) {
  const bytes = encoder.encode(text)
  return new Response(new ReadableStream({
    start(controller) {
      for (let index = 0; index < bytes.length; index += pieceBytes)
        controller.enqueue(bytes.slice(index, index + pieceBytes))
      controller.close()
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } })
}
async function start(context, options = {}) {
  const server = createServer(createRequestHandler({ env, fetchImpl: unexpectedFetch, ...options }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  context.after(() => {
    server.closeAllConnections()
    return new Promise(resolve => server.close(resolve))
  })
  const { port } = server.address()
  return { base: `http://127.0.0.1:${port}`, port }
}
function chat(base, { code = ACCESS_CODE, ip, body = chatBody, path = '/airi/api/chat', signal } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (code !== null)
    headers['X-Demo-Access-Code'] = code
  if (ip)
    headers['X-Real-IP'] = ip
  return fetch(`${base}${path}`, { method: 'POST', headers, body, signal })
}
async function events(response) {
  const text = await response.text()
  assert.ok(text.endsWith('\n'), 'NDJSON stream ends with a newline')
  return text.trimEnd().split('\n').map(entry => JSON.parse(entry))
}
// Sends the path byte-for-byte; fetch()/URL would normalise dot segments first.
function rawGet(port, path) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path }, (response) => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve({
        status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    request.on('error', reject)
    request.end()
  })
}

// Direct handler calls, for remote addresses a loopback test socket cannot have.
class MockResponse extends EventEmitter {
  headersSent = false
  writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true }
  end(body) { this.body = body }
}
async function call(handler, { remoteAddress, realIp, code = 'wrong-code' }) {
  const request = Readable.from([Buffer.from(chatBody)])
  Object.assign(request, { method: 'POST', url: '/airi/api/chat', socket: { remoteAddress },
    headers: { 'x-demo-access-code': code, ...(realIp === undefined ? {} : { 'x-real-ip': realIp }) } })
  const response = new MockResponse()
  await handler(request, response)
  return response.status
}

test('config reading keeps the existing env names, defaults and clamps', () => {
  assert.deepEqual(readServerConfig({}), { production: false, port: 5173, host: '127.0.0.1',
    model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com', accessCode: '' })
  assert.deepEqual(readServerConfig({ NODE_ENV: 'production', PORT: '3001', HOST: ' 0.0.0.0 ',
    DEEPSEEK_MODEL: ' deepseek-chat ', DEEPSEEK_BASE_URL: ' https://proxy.invalid/ ', AIRI_DEMO_ACCESS_CODE: '  code  ' }),
  { production: true, port: 3001, host: '0.0.0.0', model: 'deepseek-chat', baseUrl: 'https://proxy.invalid/',
    accessCode: 'code' })
  assert.equal(readServerConfig({ PORT: 'not-a-port' }).port, 5173)
  assert.equal(readServerConfig({ PORT: '70000' }).port, 65_535)
  assert.equal(readServerConfig({ NODE_ENV: 'development' }).production, false)
})

test('production refuses to build a handler without a 16+ character access code', () => {
  const production = { NODE_ENV: 'production', DEEPSEEK_BASE_URL: env.DEEPSEEK_BASE_URL }
  for (const code of [undefined, '', 'short', `  ${'x'.repeat(15)}  `]) {
    assert.throws(() => createRequestHandler({ env: { ...production, AIRI_DEMO_ACCESS_CODE: code } }),
      /Production requires AIRI_DEMO_ACCESS_CODE with at least 16 characters/)
  }
  assert.equal(typeof createRequestHandler({ env: { ...production, AIRI_DEMO_ACCESS_CODE: 'x'.repeat(16) } }), 'function')
  // Development may run unprotected, which disables the access-code check.
  assert.equal(typeof createRequestHandler({ env: {} }), 'function')
})

test('/api/health is public and returns only non-secret status fields', async (context) => {
  const secretEnv = { ...env, DEEPSEEK_MODEL: 'deepseek-test-model', MINIMAX_TTS_ENABLED: '1',
    MINIMAX_API_KEY: 'minimax-test-key-do-not-leak', MINIMAX_VOICE_ID: 'private-test-voice' }
  const { base } = await start(context, { env: secretEnv })
  for (const path of ['/api/health', '/airi/api/health']) {
    const response = await fetch(`${base}${path}`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const text = await response.text()
    const health = JSON.parse(text)
    assert.deepEqual(Object.keys(health), ['configured', 'model', 'provider', 'accessProtected', 'speech'])
    assert.deepEqual({ ...health, speech: undefined },
      { configured: true, model: 'deepseek-test-model', provider: 'deepseek', accessProtected: true, speech: undefined })
    assert.deepEqual(Object.keys(health.speech), ['configured', 'provider', 'model', 'region'])
    assert.equal(health.speech.provider, 'minimax')
    for (const secret of [API_KEY, ACCESS_CODE, 'deepseek.invalid', 'minimax-test-key-do-not-leak', 'private-test-voice'])
      assert.equal(text.includes(secret), false, `health must not expose ${secret}`)
  }
  const unconfigured = await start(context, { env: { DEEPSEEK_BASE_URL: env.DEEPSEEK_BASE_URL } })
  const health = await (await fetch(`${unconfigured.base}/airi/api/health`)).json()
  assert.equal(health.configured, false)
  assert.equal(health.accessProtected, false)
})

test('unknown API paths and non-POST chat requests return JSON 404s', async (context) => {
  const { base } = await start(context)
  for (const [method, path] of [['GET', '/airi/api/chat'], ['POST', '/airi/api/unknown'], ['GET', '/api/'], ['POST', '/api/health']]) {
    const response = await fetch(`${base}${path}`, { method })
    assert.equal(response.status, 404, `${method} ${path}`)
    assert.deepEqual(await response.json(), { message: 'API 路径不存在' })
  }
})

test('/api/chat rejects a missing or wrong access code with 401 before reading the body', async (context) => {
  const fetchImpl = context.mock.fn(unexpectedFetch)
  const { base } = await start(context, { fetchImpl })
  for (const code of [null, '', 'wrong', ACCESS_CODE.slice(0, -1), `${ACCESS_CODE}x`, ACCESS_CODE.toUpperCase()]) {
    const response = await chat(base, { code, body: '{not json' })
    assert.equal(response.status, 401, `code ${JSON.stringify(code)}`)
    assert.deepEqual(await response.json(), { message: '体验码不正确，请重新输入。' })
  }
  assert.equal(fetchImpl.mock.callCount(), 0)
})

test('/api/chat allows 30 requests per IP per 10 minutes, counted before the access-code check', async (context) => {
  let clock = 1_000_000
  const fetchImpl = context.mock.fn(async () => sse(`${line('好')}data: [DONE]\n\n`))
  const { base } = await start(context, { fetchImpl, now: () => clock })
  for (let index = 0; index < 30; index++)
    assert.equal((await chat(base, { code: 'wrong', ip: '203.0.113.9' })).status, 401)

  // Wrong-code attempts used up the window, so even the right code is now 429:
  // the rate limit runs first and stops access-code guessing.
  const limited = await chat(base, { ip: '203.0.113.9' })
  assert.equal(limited.status, 429)
  assert.deepEqual(await limited.json(), { message: '请求太频繁，请稍后再试。' })
  assert.equal((await chat(base, { code: 'wrong', ip: '203.0.113.9' })).status, 429)
  assert.equal((await chat(base, { code: 'wrong', ip: '203.0.113.10' })).status, 401, 'other clients are unaffected')

  clock += 10 * 60_000 - 1
  assert.equal((await chat(base, { ip: '203.0.113.9' })).status, 429)
  clock += 1
  const reopened = await chat(base, { ip: '203.0.113.9' })
  assert.equal(reopened.status, 200)
  await reopened.text()
  assert.equal(fetchImpl.mock.callCount(), 1)
})

test('X-Real-IP is honoured only from a loopback proxy, truncated to 64 characters', async () => {
  const handler = createRequestHandler({ env, fetchImpl: unexpectedFetch })
  // A direct (non-loopback) client cannot escape its bucket by rotating X-Real-IP.
  for (let index = 0; index < 30; index++)
    assert.equal(await call(handler, { remoteAddress: '198.51.100.7', realIp: `10.0.0.${index}` }), 401)
  assert.equal(await call(handler, { remoteAddress: '198.51.100.7', realIp: '10.0.0.99' }), 429)
  assert.equal(await call(handler, { remoteAddress: '198.51.100.7' }), 429)
  assert.equal(await call(handler, { remoteAddress: '198.51.100.8', realIp: '10.0.0.99' }), 401)

  // Behind Nginx on loopback, each forwarded client gets its own bucket.
  for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    const client = `client-of-${remoteAddress}`
    for (let index = 0; index < 30; index++)
      assert.equal(await call(handler, { remoteAddress, realIp: client }), 401)
    assert.equal(await call(handler, { remoteAddress, realIp: client }), 429, remoteAddress)
    assert.equal(await call(handler, { remoteAddress, realIp: `other-${client}` }), 401, remoteAddress)
  }

  // Without the header, loopback requests share the loopback address bucket.
  for (let index = 0; index < 30; index++)
    assert.equal(await call(handler, { remoteAddress: '127.0.0.1' }), 401)
  assert.equal(await call(handler, { remoteAddress: '127.0.0.1' }), 429)

  const prefix = 'x'.repeat(64)
  for (let index = 0; index < 30; index++)
    assert.equal(await call(handler, { remoteAddress: '::1', realIp: `${prefix}A` }), 401)
  assert.equal(await call(handler, { remoteAddress: '::1', realIp: `${prefix}B` }), 429)
})

test('/api/chat answers 503 while 4 chats are in flight and frees slots when they finish', { timeout: 5_000 }, async (context) => {
  const releases = []
  let allStarted
  const started = new Promise((resolve) => { allStarted = resolve })
  const fetchImpl = context.mock.fn(async () => {
    if (releases.length < 4) {
      await new Promise((resolve) => {
        releases.push(resolve)
        if (releases.length === 4)
          allStarted()
      })
    }
    return sse(`${line('好')}data: [DONE]\n\n`)
  })
  const { base } = await start(context, { fetchImpl })
  const inFlight = Array.from({ length: 4 }, () => chat(base))
  await started

  const busy = await chat(base)
  assert.equal(busy.status, 503)
  // A distinct code keeps a busy server from being shown as the unconfigured local fallback.
  assert.deepEqual(await busy.json(), { code: 'CHAT_BUSY', message: '当前体验人数较多，请稍后再试。' })
  assert.equal((await chat(base, { code: 'wrong' })).status, 401, 'the access code is checked before capacity')
  assert.equal(fetchImpl.mock.callCount(), 4)

  for (const release of releases)
    release()
  for (const response of await Promise.all(inFlight)) {
    assert.equal(response.status, 200)
    assert.deepEqual((await events(response)).at(-1), { type: 'done' })
  }
  const after = await chat(base)
  assert.equal(after.status, 200)
  await after.text()
  assert.equal(fetchImpl.mock.callCount(), 5)
})

test('/api/chat caps the request body at 128,000 bytes', async (context) => {
  const fetchImpl = context.mock.fn(async () => sse(`${line('好')}data: [DONE]\n\n`))
  const { base } = await start(context, { fetchImpl })
  const padded = bytes => chatBody + ' '.repeat(bytes - Buffer.byteLength(chatBody))

  const tooLarge = await chat(base, { body: padded(128_001) })
  assert.equal(tooLarge.status, 400)
  assert.deepEqual(await tooLarge.json(), { message: '请求内容过大' })
  const muchTooLarge = await chat(base, { body: padded(2_000_000) })
  assert.equal(muchTooLarge.status, 400)
  assert.deepEqual(await muchTooLarge.json(), { message: '请求内容过大' })
  assert.equal(fetchImpl.mock.callCount(), 0)

  const atLimit = await chat(base, { body: padded(128_000) })
  assert.equal(atLimit.status, 200)
  await atLimit.text()
  assert.equal(fetchImpl.mock.callCount(), 1)
})

test('/api/chat rejects malformed chat payloads with 400 and never calls upstream', async (context) => {
  const fetchImpl = context.mock.fn(unexpectedFetch)
  const { base } = await start(context, { fetchImpl })
  const invalid = await chat(base, { body: '{not json' })
  assert.equal(invalid.status, 400)
  assert.equal(typeof (await invalid.json()).message, 'string')
  const assistantLast = await chat(base, { body: JSON.stringify({ messages: [{ role: 'assistant', content: '嗨' }] }) })
  assert.equal(assistantLast.status, 400)
  assert.deepEqual(await assistantLast.json(), { message: '最后一条消息必须来自用户' })
  assert.equal(fetchImpl.mock.callCount(), 0)
})

test('/api/chat falls back with 503 when DeepSeek is unconfigured, still behind the access code', async (context) => {
  const fetchImpl = context.mock.fn(unexpectedFetch)
  for (const apiKey of [undefined, '', '   ']) {
    const { base } = await start(context, { env: { ...env, DEEPSEEK_API_KEY: apiKey }, fetchImpl })
    assert.equal((await chat(base, { code: 'wrong' })).status, 401)
    const response = await chat(base)
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(),
      { code: 'DEEPSEEK_NOT_CONFIGURED', message: 'DeepSeek API Key 尚未配置，当前使用本地演示回复。' })
  }
  assert.equal(fetchImpl.mock.callCount(), 0)
})

test('/api/chat sends one bounded streaming request to the configured DeepSeek URL', async (context) => {
  const fetchImpl = context.mock.fn(async () => sse('data: [DONE]\n\n'))
  const { base } = await start(context, { env: { ...env, DEEPSEEK_MODEL: 'deepseek-test-model',
    DEEPSEEK_MAX_TOKENS: '99999', DEEPSEEK_TEMPERATURE: '-1' }, fetchImpl })
  const response = await chat(base, { ip: '203.0.113.5', body: JSON.stringify({
    persona: { name: 'Hiyori' }, messages: [{ role: 'assistant', content: '欢迎' }, { role: 'user', content: ' 你好 ' }],
    apiKey: 'client-key', model: 'client-model', max_tokens: 4_000, baseUrl: 'https://attacker.invalid' }) })
  assert.equal(response.status, 200)
  assert.deepEqual(await events(response), [{ type: 'done' }])

  assert.equal(fetchImpl.mock.callCount(), 1)
  const [url, options] = fetchImpl.mock.calls[0].arguments
  assert.equal(String(url), 'https://deepseek.invalid/v1/chat/completions')
  assert.equal(options.method, 'POST')
  assert.deepEqual(options.headers, { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' })
  assert.ok(options.signal instanceof AbortSignal)
  const body = JSON.parse(options.body)
  assert.deepEqual(Object.keys(body),
    ['model', 'messages', 'stream', 'stream_options', 'thinking', 'max_tokens', 'temperature'])
  assert.equal(body.model, 'deepseek-test-model')
  assert.equal(body.stream, true)
  assert.deepEqual(body.stream_options, { include_usage: true })
  assert.deepEqual(body.thinking, { type: 'disabled' })
  assert.equal(body.max_tokens, 4_096)
  assert.equal(body.temperature, 0)
  assert.equal(body.messages[0].role, 'system')
  assert.match(body.messages[0].content, /Hiyori/)
  assert.deepEqual(body.messages.slice(1), [{ role: 'assistant', content: '欢迎' }, { role: 'user', content: '你好' }])
  assert.equal(options.body.includes(ACCESS_CODE), false)
  assert.equal(options.body.includes('203.0.113.5'), false)

  const defaults = await start(context, { fetchImpl })
  await (await chat(defaults.base)).text()
  const defaultBody = JSON.parse(fetchImpl.mock.calls[1].arguments[1].body)
  assert.equal(defaultBody.model, 'deepseek-flash')
  assert.equal(defaultBody.max_tokens, 320)
  assert.equal(defaultBody.temperature, 0.8)

  // Number('') is 0: an empty env assignment must keep the default, not clamp to the minimum.
  for (const [maxTokens, temperature] of [['', ' '], [' \t', '']]) {
    const empty = await start(context, { env: { ...env, DEEPSEEK_MAX_TOKENS: maxTokens, DEEPSEEK_TEMPERATURE: temperature }, fetchImpl })
    await (await chat(empty.base)).text()
    const emptyBody = JSON.parse(fetchImpl.mock.calls.at(-1).arguments[1].body)
    assert.equal(emptyBody.max_tokens, 320, JSON.stringify(maxTokens))
    assert.equal(emptyBody.temperature, 0.8, JSON.stringify(temperature))
  }
  for (const port of ['', '   ', '\t\n'])
    assert.equal(readServerConfig({ PORT: port }).port, 5173, JSON.stringify(port))
})

test('upstream non-OK responses become 502 with a provider message truncated to 240 characters', async (context) => {
  const longMessage = `${'余额不足'.repeat(100)}-tail-that-must-be-cut`
  const replies = [
    () => Response.json({ error: { message: longMessage } }, { status: 402 }),
    () => Response.json({ error: { message: 'Model Not Exist' } }, { status: 400 }),
    () => new Response('<html>bad gateway</html>', { status: 503 }),
    () => Response.json({ error: 'not an object' }, { status: 429 }),
    () => new Response(null, { status: 200 }),
  ]
  const fetchImpl = context.mock.fn(async () => replies.shift()())
  const { base } = await start(context, { fetchImpl })
  const results = []
  for (let index = 0; index < 5; index++) {
    const response = await chat(base)
    results.push([response.status, (await response.json()).message])
  }
  assert.deepEqual(results, [
    [502, `DeepSeek：${longMessage.slice(0, 240)}`],
    [502, 'DeepSeek：Model Not Exist'],
    [502, 'DeepSeek 请求失败（HTTP 503）'],
    [502, 'DeepSeek 请求失败（HTTP 429）'],
    [502, 'DeepSeek 没有返回响应内容'],
  ])
  assert.equal(results[0][1].length, 'DeepSeek：'.length + 240)
})

test('upstream SSE is relayed as NDJSON delta / delivery / done events across arbitrary chunk splits', async (context) => {
  const upstream = [
    line('[[tone:so'),
    line('ft]]你好呀。'),
    ': keep-alive\n\n',
    'data: {"choices":[],"usage":{"total_tokens":9}}\r\n\r\n',
    line('\n[[tone:bright]]今天怎么样？'),
    'data: [DONE]\n\n',
  ].join('')
  for (const pieceBytes of [Infinity, 7, 1]) {
    const { base } = await start(context, { fetchImpl: async () => sse(upstream, pieceBytes) })
    const response = await chat(base)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'application/x-ndjson; charset=utf-8')
    assert.equal(response.headers.get('cache-control'), 'no-cache, no-store')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    assert.deepEqual(await events(response), [
      { type: 'delivery', value: 'soft' },
      { type: 'delta', content: '你好呀。' },
      { type: 'delta', content: '\n' },
      { type: 'delivery', value: 'bright' },
      { type: 'delta', content: '今天怎么样？' },
      { type: 'done' },
    ], `piece size ${pieceBytes}`)
  }

  // A final line without a trailing newline is still relayed.
  const { base } = await start(context, { fetchImpl: async () => sse(`${line('最后')}data: ${JSON.stringify({
    choices: [{ delta: { content: '一句' } }] })}`) })
  assert.deepEqual(await events(await chat(base)),
    [{ type: 'delta', content: '最后' }, { type: 'delta', content: '一句' }, { type: 'done' }])
})

test('a length-capped DeepSeek reply ends with a truncated done event', async (context) => {
  const finish = reason => `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] })}\n\n`
  const reply = reason => [
    `data: ${JSON.stringify({ choices: [{ delta: { content: '写到一半' }, finish_reason: null }] })}\n\n`,
    finish(reason),
    'data: {"choices":[],"usage":{"completion_tokens":320}}\n\n',
    'data: [DONE]\n\n',
  ].join('')

  const capped = await start(context, { fetchImpl: async () => sse(reply('length'), 5) })
  assert.deepEqual(await events(await chat(capped.base)),
    [{ type: 'delta', content: '写到一半' }, { type: 'done', truncated: true }])

  const complete = await start(context, { fetchImpl: async () => sse(reply('stop')) })
  assert.deepEqual((await events(await chat(complete.base))).at(-1), { type: 'done' })
})

test('a mid-stream upstream failure ends the NDJSON stream with an error event instead of done', async (context) => {
  const failing = error => async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(encoder.encode(line('先说一半。'))) },
    pull(controller) { controller.error(error) },
  }))
  const { base } = await start(context, { fetchImpl: failing(new Error('upstream socket reset')) })
  const response = await chat(base)
  assert.equal(response.status, 200)
  assert.deepEqual(await events(response),
    [{ type: 'delta', content: '先说一半。' }, { type: 'error', message: 'upstream socket reset' }])

  const nonError = await start(context, { fetchImpl: failing('not an Error') })
  assert.deepEqual((await events(await chat(nonError.base))).at(-1), { type: 'error', message: 'DeepSeek 流式响应中断' })

  const malformed = await start(context, { fetchImpl: async () => sse(`${line('好')}data: {not json}\n\n${line('不会到达')}`) })
  const malformedEvents = await events(await chat(malformed.base))
  assert.deepEqual(malformedEvents[0], { type: 'delta', content: '好' })
  assert.equal(malformedEvents.length, 2)
  assert.equal(malformedEvents[1].type, 'error')
  assert.equal(typeof malformedEvents[1].message, 'string')
})

test('a rejected upstream fetch (network error or timeout) is a logged 500', async (context) => {
  const logged = context.mock.method(console, 'error', () => {})
  const { base } = await start(context, { fetchImpl: async () => { throw new TypeError('fetch failed') } })
  const response = await chat(base)
  assert.equal(response.status, 500)
  assert.deepEqual(await response.json(), { message: '本地服务发生了意外错误' })
  assert.equal(logged.mock.callCount(), 1)
  assert.equal(logged.mock.calls[0].arguments[0].message, 'fetch failed')
})

test('a client disconnect aborts the upstream DeepSeek request', { timeout: 5_000 }, async (context) => {
  let upstreamSignal
  const fetchImpl = async (url, options) => {
    upstreamSignal = options.signal
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(line('第一句。')))
        options.signal.addEventListener('abort', () => controller.error(options.signal.reason), { once: true })
      },
    }))
  }
  const { base } = await start(context, { fetchImpl })
  const client = new AbortController()
  const response = await chat(base, { signal: client.signal })
  const first = await response.body.getReader().read()
  assert.match(new TextDecoder().decode(first.value), /第一句/)
  assert.equal(upstreamSignal.aborted, false)
  client.abort()
  await new Promise(resolve => upstreamSignal.aborted ? resolve() : upstreamSignal.addEventListener('abort', resolve))
  assert.equal(upstreamSignal.aborted, true)
})

const INDEX_HTML = '<!doctype html><title>AIRI index</title>'
const SECRET = 'SECRET-OUTSIDE-DIST'
async function staticRoot(context) {
  const root = await mkdtemp(join(tmpdir(), 'airi-static-test-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'dist', 'assets'), { recursive: true })
  await mkdir(join(root, 'dist-evil'))
  await writeFile(join(root, 'dist', 'index.html'), INDEX_HTML)
  await writeFile(join(root, 'dist', 'assets', 'app.js'), 'console.log("app")')
  await writeFile(join(root, 'secret.txt'), SECRET)
  await writeFile(join(root, '.env'), SECRET)
  await writeFile(join(root, 'dist-evil', 'secret.txt'), SECRET)
  return root
}
const productionEnv = { ...env, NODE_ENV: 'production' }

test('production static serving redirects /airi, serves dist/, gives routes index.html and missing files 404', async (context) => {
  const { port } = await start(context, { env: productionEnv, root: await staticRoot(context) })

  for (const path of ['/airi', '/airi?from=bookmark']) {
    const redirect = await rawGet(port, path)
    assert.equal(redirect.status, 308, path)
    assert.equal(redirect.headers.location, '/airi/', path)
  }

  const index = await rawGet(port, '/airi/')
  assert.equal(index.status, 200)
  assert.equal(index.body, INDEX_HTML)
  assert.equal(index.headers['content-type'], 'text/html; charset=utf-8')
  assert.equal(index.headers['cache-control'], 'no-cache')

  const asset = await rawGet(port, '/airi/assets/app.js')
  assert.equal(asset.body, 'console.log("app")')
  assert.equal(asset.headers['content-type'], 'text/javascript; charset=utf-8')
  assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable')

  // Client routes and directories get the app shell.
  for (const path of ['/airi/chat/history', '/airi/assets', '/airi/assets/', '/airi/.well-known/x', '/'])
    assert.equal((await rawGet(port, path)).body, INDEX_HTML, path)

  // A missing file (a stale hashed asset, an uninstalled model, a page that
  // was not built) is reported, not replaced by the app shell.
  for (const path of ['/airi/missing.js', '/airi/assets/old-hash.js', '/airi/stage.html', '/airi/models/hiyori/hiyori_free_t08.model3.json']) {
    const response = await rawGet(port, path)
    assert.equal(response.status, 404, path)
    assert.equal(response.headers['cache-control'], 'no-store', path)
    assert.deepEqual(JSON.parse(response.body), { message: '文件不存在' }, path)
  }
})

test('every built page revalidates, so a rebuilt OBS stage never keeps stale asset names', async (context) => {
  const root = await staticRoot(context)
  await writeFile(join(root, 'dist', 'stage.html'), '<!doctype html><title>stage</title>')
  await writeFile(join(root, 'dist', 'console.html'), '<!doctype html><title>console</title>')
  const { port } = await start(context, { env: productionEnv, root })
  for (const page of ['stage', 'console']) {
    const response = await rawGet(port, `/airi/${page}.html`)
    assert.equal(response.status, 200)
    assert.match(response.body, new RegExp(`<title>${page}</title>`))
    assert.equal(response.headers['content-type'], 'text/html; charset=utf-8')
    assert.equal(response.headers['cache-control'], 'no-cache', page)
  }
  assert.equal((await rawGet(port, '/airi/assets/app.js')).headers['cache-control'], 'public, max-age=31536000, immutable')
})

test('production static serving keeps path traversal attempts inside dist/', async (context) => {
  const { port } = await start(context, { env: productionEnv, root: await staticRoot(context) })
  const attempts = [
    '/airi/../secret.txt',
    '/airi/../../secret.txt',
    '/airi/../.env',
    '/airi/%2e%2e/secret.txt',
    '/airi/%2E%2E/%2e%2e/secret.txt',
    '/airi/..%2fsecret.txt',
    '/airi/..%2f..%2fsecret.txt',
    '/airi/%2e%2e%2fsecret.txt',
    '/airi/..%2f.env',
    '/airi/..%2fdist-evil%2fsecret.txt',
    '/airi/..%5csecret.txt',
    '/..%2fsecret.txt',
    '/airi//..%2fsecret.txt',
    '//secret.txt',
    '/airi/%00',
    '/airi/assets/..%2f..%2f..%2fsecret.txt',
  ]
  // The URL parser resolves `..` and `%2e%2e` segments before the static
  // handler sees the path, so these arrive as /secret.txt: a lookup inside
  // dist/ that is reported missing. On Linux and macOS a backslash is an
  // ordinary filename character, so `..\secret.txt` is the same case.
  const missingInsideDist = new Set([
    '/airi/../secret.txt', '/airi/../../secret.txt', '/airi/%2e%2e/secret.txt', '/airi/%2E%2E/%2e%2e/secret.txt', '/airi/..%5csecret.txt',
  ])
  for (const path of attempts) {
    const response = await rawGet(port, path)
    assert.equal(response.body.includes(SECRET), false, path)
    if (missingInsideDist.has(path)) {
      assert.equal(response.status, 404, path)
      continue
    }
    assert.equal(response.status, 200, path)
    assert.equal(response.body, INDEX_HTML, path)
  }
})

test('production static serving answers malformed percent-encoding with 400, not a logged 500', async (context) => {
  const logged = context.mock.method(console, 'error', () => {})
  const { port } = await start(context, { env: productionEnv, root: await staticRoot(context) })
  for (const path of ['/airi/%E0%A4%A', '/airi/%', '/airi/%zz.js', '/airi/..%2f%E0%A4%A']) {
    const response = await rawGet(port, path)
    assert.equal(response.status, 400, path)
    assert.equal(response.headers['cache-control'], 'no-store')
    assert.deepEqual(JSON.parse(response.body), { message: '请求路径无效' })
  }
  assert.equal(logged.mock.callCount(), 0)
  // Well-formed encodings still decode normally.
  assert.equal((await rawGet(port, '/airi/assets/%61pp.js')).body, 'console.log("app")')
})

test('production static serving survives a missing dist/ build instead of crashing the process', async (context) => {
  const logged = context.mock.method(console, 'error', () => {})
  const root = await mkdtemp(join(tmpdir(), 'airi-static-test-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const { base, port } = await start(context, { env: productionEnv, root })
  for (const path of ['/airi/', '/airi/chat/history', '/airi/']) {
    const response = await rawGet(port, path)
    assert.equal(response.status, 500, path)
    assert.deepEqual(JSON.parse(response.body), { message: '本地服务发生了意外错误' })
  }
  assert.equal(logged.mock.callCount(), 3)
  assert.equal(logged.mock.calls[0].arguments[0].code, 'ENOENT')
  // A missing asset is a plain 404 even without a build, and not logged.
  assert.equal((await rawGet(port, '/airi/assets/app.js')).status, 404)
  assert.equal(logged.mock.callCount(), 3)
  assert.equal((await fetch(`${base}/airi/api/health`)).status, 200)
})

test('a static file that fails after its headers drops only that connection', async (context) => {
  const logged = context.mock.method(console, 'error', () => {})
  const root = await mkdtemp(join(tmpdir(), 'airi-static-test-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  // A directory opens like a file but fails on the first read (EISDIR).
  await mkdir(join(root, 'dist', 'index.html'), { recursive: true })
  const { base, port } = await start(context, { env: productionEnv, root })
  for (let attempt = 0; attempt < 2; attempt++)
    await assert.rejects(rawGet(port, '/airi/'), { code: 'ECONNRESET' })
  assert.equal(logged.mock.callCount(), 2)
  assert.equal(logged.mock.calls[0].arguments[0].code, 'EISDIR')
  assert.equal((await fetch(`${base}/airi/api/health`)).status, 200)
})

async function freePort() {
  const probe = createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address()
  await new Promise(resolve => probe.close(resolve))
  return port
}
function runEntry(extraEnv) {
  // A minimal env: never inherit a real DEEPSEEK_API_KEY or TTS key from the shell.
  const entry = fileURLToPath(new URL('./index.mjs', import.meta.url))
  const child = spawn(process.execPath, [entry], { stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, NODE_ENV: 'production', HOST: '127.0.0.1', ...extraEnv } })
  const output = { stdout: '', stderr: '' }
  child.stdout.on('data', chunk => output.stdout += chunk)
  child.stderr.on('data', chunk => output.stderr += chunk)
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)))
  return { child, output, exited }
}

test('server/index.mjs still listens on PORT/HOST in production', { timeout: 20_000 }, async (context) => {
  const port = await freePort()
  const { child, output, exited } = runEntry({ PORT: String(port), AIRI_DEMO_ACCESS_CODE: ACCESS_CODE })
  context.after(() => child.kill())
  await new Promise((resolve, reject) => {
    child.stdout.on('data', () => output.stdout.includes('local fallback enabled\n') && resolve())
    exited.then(code => reject(new Error(`entry exited early (${code}): ${output.stderr}`)))
  })
  assert.match(output.stdout, new RegExp(`AIRI Lite running at http://127\\.0\\.0\\.1:${port}/airi/`))
  const health = await (await fetch(`http://127.0.0.1:${port}/airi/api/health`)).json()
  assert.equal(health.configured, false)
  assert.equal(health.accessProtected, true)
  assert.match(output.stdout, /DeepSeek: not configured; local fallback enabled/)
  child.kill()
  await exited
})

test('server/index.mjs exits at startup in production without a valid access code', { timeout: 20_000 }, async () => {
  const { output, exited } = runEntry({ PORT: String(await freePort()), AIRI_DEMO_ACCESS_CODE: 'too-short' })
  assert.equal(await exited, 1)
  assert.match(output.stderr, /Production requires AIRI_DEMO_ACCESS_CODE with at least 16 characters/)
  assert.equal(output.stdout.includes('AIRI Lite running at'), false)
})

test('server/index.mjs refuses live mode on a non-loopback HOST and serves it on loopback', { timeout: 20_000 }, async (context) => {
  const exposed = runEntry({ PORT: String(await freePort()), AIRI_DEMO_ACCESS_CODE: ACCESS_CODE, AIRI_LIVE: '1', HOST: '0.0.0.0' })
  assert.equal(await exposed.exited, 1)
  assert.match(exposed.output.stderr, /AIRI_LIVE=1 requires HOST to be a loopback address/)
  assert.equal(exposed.output.stdout.includes('AIRI Lite running at'), false)

  const port = await freePort()
  const { child, output, exited } = runEntry({ PORT: String(port), AIRI_DEMO_ACCESS_CODE: ACCESS_CODE, AIRI_LIVE: '1' })
  context.after(() => child.kill())
  await new Promise((resolve, reject) => {
    child.stdout.on('data', () => output.stdout.includes('Live mode: enabled') && resolve())
    exited.then(code => reject(new Error(`entry exited early (${code}): ${output.stderr}`)))
  })
  const state = await fetch(`http://127.0.0.1:${port}/airi/api/live/state`)
  assert.equal(state.status, 200)
  assert.equal((await state.json()).control, 'running')
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/airi/api/health`)).json()).live.enabled, true)
  // SIGTERM closes live streams first, then exits cleanly.
  child.kill('SIGTERM')
  assert.equal(await exited, 0)
})

test('the deployed layout (server/, shared/, dist/ without src/) starts when live mode is off', { timeout: 20_000 }, async (context) => {
  // The VPS release syncs only these directories; nothing on the default
  // path may import src/*.ts, which only live mode loads.
  const root = await mkdtemp(join(tmpdir(), 'airi-deploy-layout-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const repository = fileURLToPath(new URL('..', import.meta.url))
  for (const directory of ['server', 'shared'])
    await cp(join(repository, directory), join(root, directory), { recursive: true })
  await cp(join(repository, 'package.json'), join(root, 'package.json'))
  await mkdir(join(root, 'dist'))
  await writeFile(join(root, 'dist', 'index.html'), INDEX_HTML)
  const port = await freePort()
  const child = spawn(process.execPath, [join(root, 'server', 'index.mjs')], { stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), AIRI_DEMO_ACCESS_CODE: ACCESS_CODE } })
  context.after(() => child.kill())
  const output = { stdout: '', stderr: '' }
  child.stdout.on('data', chunk => output.stdout += chunk)
  child.stderr.on('data', chunk => output.stderr += chunk)
  const exited = new Promise(resolve => child.once('exit', resolve))
  await new Promise((resolve, reject) => {
    child.stdout.on('data', () => output.stdout.includes('local fallback enabled\n') && resolve())
    exited.then(code => reject(new Error(`deployed entry exited (${code}): ${output.stderr}`)))
  })
  assert.equal((await fetch(`http://127.0.0.1:${port}/airi/`)).status, 200)
  child.kill()
  await exited
})
