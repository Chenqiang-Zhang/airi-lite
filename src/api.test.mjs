import assert from 'node:assert/strict'
import test from 'node:test'

import { ChatApiError, streamChat } from './api.ts'

const persona = {
  name: 'Test', personality: '', preferences: '', scenario: '', speakingStyle: '',
  behaviorGuidelines: '', dialogueExamples: '', greeting: '',
}

// Replace only the browser transport; parsing and error mapping are production.
async function withResponse(response, run) {
  const previousFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init })
    return response
  }
  try {
    return await run(requests)
  }
  finally {
    globalThis.fetch = previousFetch
  }
}

const ndjson = events => new Response(events.map(event => `${JSON.stringify(event)}\n`).join(''), {
  headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
})

const chat = (deltas = []) => streamChat({
  messages: [{ role: 'user', content: '你好' }],
  persona,
  onDelta: delta => deltas.push(delta),
})

test('a streamed reply reports whether DeepSeek cut it off at the length limit', async () => {
  for (const [done, truncated] of [[{ type: 'done', truncated: true }, true], [{ type: 'done' }, false]]) {
    const deltas = []
    const result = await withResponse(ndjson([
      { type: 'delta', content: '写到' },
      { type: 'delta', content: '一半' },
      done,
    ]), async (requests) => {
      const value = await chat(deltas)
      assert.equal(requests[0].url, '/api/chat')
      return value
    })
    assert.deepEqual(result, { text: '写到一半', truncated })
    assert.deepEqual(deltas, ['写到', '一半'])
  }
})

test('a failed request keeps the server error code alongside the HTTP status', async () => {
  for (const code of ['CHAT_BUSY', 'DEEPSEEK_NOT_CONFIGURED']) {
    const response = new Response(JSON.stringify({ code, message: '服务暂不可用' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })
    await assert.rejects(withResponse(response, () => chat()), (error) => {
      assert.ok(error instanceof ChatApiError)
      assert.equal(error.message, '服务暂不可用')
      assert.equal(error.status, 503)
      assert.equal(error.code, code)
      return true
    })
  }
})

test('a stream error after partial text rejects once the partial delta was delivered', async () => {
  const deltas = []
  await assert.rejects(withResponse(ndjson([
    { type: 'delta', content: '故事讲到' },
    { type: 'error', message: 'DeepSeek 流式响应中断' },
  ]), () => chat(deltas)), /DeepSeek 流式响应中断/)
  assert.deepEqual(deltas, ['故事讲到'])
})
