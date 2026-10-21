import assert from 'node:assert/strict'
import test from 'node:test'

import { DeepSeekRequestError, openDeepSeekStream } from './deepseek.mjs'

// Fake fetches only; nothing here reaches DeepSeek.
const sse = text => new Response(text, { headers: { 'Content-Type': 'text/event-stream' } })
const line = (delta, finish = null) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`
const options = (fetchImpl, extra = {}) => ({
  apiKey: 'sk-test-only', baseUrl: 'https://deepseek.invalid/v1', model: 'test-model',
  messages: [{ role: 'user', content: '你好' }], maxTokens: 160, temperature: 0.8, fetchImpl, ...extra,
})

test('relay emits cue, act and text events and reports truncation and usage', async () => {
  const stream = await openDeepSeekStream(options(async () => sse([
    line({ content: '[[tone:bright]]你' }), line({ content: '好。[[act:si' }), line({ content: 'gh]]唉。' }), line({}, 'length'),
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, prompt_cache_hit_tokens: 8 } })}\n\n`,
    'data: [DONE]\n\n',
  ].join(''))))
  const events = []
  const result = await stream.relay(event => events.push(event))
  // The old name 'bright' arrives as 'happy'.
  assert.deepEqual(events, [
    { type: 'delivery', value: 'happy' }, { type: 'delta', content: '你' }, { type: 'delta', content: '好。' },
    { type: 'act', value: 'sigh' }, { type: 'delta', content: '唉。' },
  ])
  assert.deepEqual(result, { truncated: true, usage: { prompt_tokens: 12, completion_tokens: 3, prompt_cache_hit_tokens: 8 } })
})

test('a request carries the bounded options and never anything else', async () => {
  let request
  const stream = await openDeepSeekStream(options(async (url, init) => {
    request = { url: String(url), init }
    return sse('data: [DONE]\n\n')
  }))
  assert.deepEqual(await stream.relay(() => {}), { truncated: false, usage: null })
  assert.equal(request.url, 'https://deepseek.invalid/v1/chat/completions')
  assert.deepEqual(JSON.parse(request.init.body), {
    model: 'test-model', messages: [{ role: 'user', content: '你好' }], stream: true,
    stream_options: { include_usage: true }, thinking: { type: 'disabled' }, max_tokens: 160, temperature: 0.8,
  })
  assert.equal(request.init.headers.Authorization, 'Bearer sk-test-only')
})

test('HTTP failures become DeepSeekRequestError; network failures and aborts propagate', async () => {
  await assert.rejects(openDeepSeekStream(options(async () => new Response(JSON.stringify({ error: { message: 'x'.repeat(400) } }), { status: 429 }))),
    error => error instanceof DeepSeekRequestError && error.status === 502 && error.message === `DeepSeek：${'x'.repeat(240)}`)
  await assert.rejects(openDeepSeekStream(options(async () => new Response('busy', { status: 503 }))),
    { message: 'DeepSeek 请求失败（HTTP 503）' })
  await assert.rejects(openDeepSeekStream(options(async () => new Response(null, { status: 200 }))),
    { message: 'DeepSeek 没有返回响应内容' })
  await assert.rejects(openDeepSeekStream(options(async () => { throw new TypeError('fetch failed') })),
    error => error instanceof TypeError && !(error instanceof DeepSeekRequestError))
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(openDeepSeekStream(options(async (_url, init) => {
    init.signal.throwIfAborted()
    return sse('')
  }, { signal: controller.signal })), { name: 'AbortError' })
})
