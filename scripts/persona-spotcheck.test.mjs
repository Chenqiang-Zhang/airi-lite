import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { runPersonaSpotcheck } from './persona-spotcheck.mjs'

const payload = () => ({
  persona: { name: '  日和  ', personality: '活泼' },
  userMemory: '  喜欢草莓  ',
  cases: [{ id: 'first', messages: [{ role: 'user', content: '  放学啦！  ' }] }],
})
const health = (extra = {}) => Response.json({ configured: true, model: 'test-model', accessProtected: false, ...extra })
const ndjson = events => new Response(events.map(event => JSON.stringify(event)).join('\n') + '\n')
const replyEvents = [
  { type: 'delivery', value: 'bright' },
  { type: 'delta', content: '好耶！' },
  { type: 'delta', content: '一起走。' },
  { type: 'done' },
]

test('validates every case and all ids before any network request', async () => {
  for (const input of [
    {},
    { ...payload(), cases: [] },
    { ...payload(), cases: Array.from({ length: 9 }, (_, index) => ({ id: String(index), messages: [{ role: 'user', content: '你好' }] })) },
    { ...payload(), cases: [...payload().cases, { id: ' first ', messages: [{ role: 'user', content: '你好' }] }] },
    { ...payload(), cases: [...payload().cases, { id: ' ', messages: [{ role: 'user', content: '你好' }] }] },
    { ...payload(), cases: [...payload().cases, { id: 'second', messages: [{ role: 'assistant', content: '不是用户的最后一条' }] }] },
    { ...payload(), cases: [...payload().cases, { id: 'second', messages: [{ role: 'user', content: '中'.repeat(8_001) }] }] },
  ]) {
    let calls = 0
    await assert.rejects(runPersonaSpotcheck(input, { env: {}, fetchImpl: async () => { calls++; return health() } }))
    assert.equal(calls, 0)
  }
})

test('emits normalized context and all server events with health model; requests are serial and bounded', async () => {
  const input = payload()
  input.cases.push({ id: 'second', messages: [{ role: 'user', content: '第二句' }] })
  const lines = [], calls = [], timeouts = []
  let firstBodyConsumed = false
  await runPersonaSpotcheck(input, {
    env: { AIRI_DEMO_ACCESS_CODE: 'test-code', AIRI_SMOKE_URL: 'https://example.invalid/airi/api/chat' },
    now: () => '2026-09-30T00:00:00.000Z',
    timeoutSignal: milliseconds => { timeouts.push(milliseconds); return new AbortController().signal },
    writeLine: line => lines.push(JSON.parse(line)),
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      if (calls.length === 1) return health({ accessProtected: true })
      if (calls.length === 2) return { ok: true, text: async () => {
        await Promise.resolve()
        firstBodyConsumed = true
        return replyEvents.map(event => JSON.stringify(event)).join('\n')
      } }
      assert.ok(firstBodyConsumed, 'the previous response body must finish before requesting the next case')
      assert.equal(lines.length, 1, 'the previous evidence must be written before the next request')
      return ndjson(replyEvents)
    },
  })
  assert.deepEqual(timeouts, [90_000, 90_000, 90_000])
  assert.equal(calls[0].url, 'https://example.invalid/airi/api/health')
  assert.equal(calls[1].options.headers['X-Demo-Access-Code'], 'test-code')
  assert.ok(calls.every(call => call.options.redirect === 'error'))
  const packet = JSON.parse(calls[1].options.body)
  assert.equal(packet.persona.name, '日和')
  assert.equal(packet.userMemory, '喜欢草莓')
  assert.deepEqual(lines[0], {
    id: 'first',
    content: { context: [{ role: 'user', content: '放学啦！' }], text: '好耶！一起走。' },
    evidence: { observedAt: '2026-09-30T00:00:00.000Z', requestedModel: 'test-model', serverEvents: replyEvents },
  })
  assert.equal(lines[1].id, 'second')
  assert.ok(!JSON.stringify(lines).includes('test-code'))
})

test('uses the loopback endpoint by default and refuses unconfigured or protected-without-code servers', async () => {
  for (const serverHealth of [{ configured: false }, { accessProtected: true }, { model: '' }]) {
    const urls = []
    await assert.rejects(runPersonaSpotcheck(payload(), {
      env: {}, fetchImpl: async url => { urls.push(url); return health(serverHealth) },
    }))
    assert.deepEqual(urls, ['http://127.0.0.1:3001/airi/api/health'])
  }
})

test('rejects invalid endpoints and header codes before requesting health', async () => {
  for (const env of [
    { AIRI_SMOKE_URL: 'file:///tmp/api/chat' },
    { AIRI_SMOKE_URL: 'https://user:password@example.invalid/api/chat' },
    { AIRI_SMOKE_URL: 'https://example.invalid/api/other' },
    { AIRI_SMOKE_URL: 'https://example.invalid/api/chat#fragment' },
    { AIRI_DEMO_ACCESS_CODE: '中文体验码' },
    { AIRI_DEMO_ACCESS_CODE: 'a b' },
    { AIRI_DEMO_ACCESS_CODE: 'a\nb' },
    { AIRI_DEMO_ACCESS_CODE: 'a'.repeat(257) },
  ]) {
    let calls = 0
    await assert.rejects(runPersonaSpotcheck(payload(), {
      env, fetchImpl: async () => { calls++; return health() },
    }))
    assert.equal(calls, 0)
  }
})

test('retains error and incomplete stream evidence but fails before requesting another case', async () => {
  for (const events of [
    [{ type: 'delta', content: '先说半句' }, { type: 'error', message: 'upstream stopped' }],
    [{ type: 'delta', content: '缺少结束事件' }],
    [{ type: 'done' }],
  ]) {
    const input = payload()
    input.cases.push({ id: 'second', messages: [{ role: 'user', content: '不应发送' }] })
    const lines = []
    let calls = 0
    await assert.rejects(runPersonaSpotcheck(input, {
      env: {}, writeLine: line => lines.push(JSON.parse(line)),
      fetchImpl: async () => ++calls === 1 ? health() : ndjson(events),
    }))
    assert.equal(calls, 2)
    assert.deepEqual(lines[0].evidence.serverEvents, events)
  }
})

test('network and HTTP failures do not expose access codes or error bodies', async () => {
  for (const mode of ['fetch', 'http', 'body']) {
    let calls = 0
    await assert.rejects(runPersonaSpotcheck(payload(), {
      env: { AIRI_DEMO_ACCESS_CODE: 'do-not-print-this-code' },
      fetchImpl: async () => {
        if (++calls === 1) return health()
        if (mode === 'fetch') throw new Error('do-not-print-this-code')
        if (mode === 'http') return new Response('do-not-print-this-code', { status: 401 })
        return { ok: true, text: async () => { throw new Error('do-not-print-this-code') } }
      },
    }), error => !error.message.includes('do-not-print-this-code'))
  }
})

test('rejects malformed NDJSON without emitting a valid-looking record', async () => {
  for (const body of ['not-json', '{"type":"delta","content":1}', 'null', '[]']) {
    let calls = 0
    const lines = []
    await assert.rejects(runPersonaSpotcheck(payload(), {
      env: {}, writeLine: line => lines.push(line),
      fetchImpl: async () => ++calls === 1 ? health() : new Response(body),
    }))
    assert.deepEqual(lines, [])
  }
})

test('CLI returns a failing exit for invalid stdin without echoing it or environment secrets', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./persona-spotcheck.mjs', import.meta.url))], {
    input: '{invalid secret-input', encoding: 'utf8',
    env: { ...process.env, AIRI_DEMO_ACCESS_CODE: 'secret-code', DEEPSEEK_API_KEY: 'secret-key' },
  })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, 'Standard input must be valid JSON.\n')
})
