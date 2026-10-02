import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { runPersonaDialogueCheck } from './persona-dialogue-check.mjs'

const payload = () => ({
  persona: { name: '  日和  ', personality: '活泼' },
  userMemory: '  喜欢草莓  ',
  trajectories: [{ id: 'first', turns: ['  放学啦！  ', '后来呢？', '真的吗？'] }],
})
const health = (extra = {}) => Response.json({ configured: true, model: 'test-model', accessProtected: false, ...extra })
const ndjson = events => new Response(events.map(event => JSON.stringify(event)).join('\n') + '\n')
const reply = text => [{ type: 'delivery', value: 'bright' }, { type: 'delta', content: text }, { type: 'done' }]

test('validates the entire plan, all turns, persona, and memory before any network request', async () => {
  const late = { id: 'second', turns: ['valid', 'valid', '中'.repeat(8_001)] }
  for (const input of [
    {}, { ...payload(), persona: [] }, { ...payload(), persona: null },
    { ...payload(), persona: { name: 123 } },
    { ...payload(), persona: { dialogueExamples: [] } },
    { ...payload(), userMemory: {} }, { ...payload(), userMemory: null },
    { ...payload(), trajectories: [] },
    { ...payload(), trajectories: [...payload().trajectories, late] },
    { ...payload(), trajectories: [...payload().trajectories, { id: ' first ', turns: ['valid'] }] },
    { ...payload(), trajectories: [{ id: ' ', turns: ['valid'] }] },
    { ...payload(), trajectories: [{ id: 'a', turns: [] }] },
    { ...payload(), trajectories: [{ id: 'a', turns: ['valid', ' '] }] },
    { ...payload(), trajectories: [{ id: 'a', turns: ['valid', { role: 'user', content: 'not a string' }] }] },
    { ...payload(), trajectories: [{ id: 'a', turns: new Array(2) }] },
    { ...payload(), trajectories: [{ id: 'a', turns: ['1', '2', '3', '4'] }] },
    { ...payload(), trajectories: Array.from({ length: 5 }, (_, index) => ({ id: String(index), turns: ['valid'] })) },
  ]) {
    let calls = 0
    const lines = []
    await assert.rejects(runPersonaDialogueCheck(input, {
      env: {}, writeLine: line => lines.push(line), fetchImpl: async () => { calls++; return health() },
    }))
    assert.equal(calls, 0)
    assert.deepEqual(lines, [])
  }
})

test('relays actual successful assistant text, normalizes input, and isolates trajectories', async () => {
  const input = payload()
  input.trajectories.push({ id: ' second ', turns: ['  重新开始  ', '只问这一次'] })
  const lines = [], packets = [], calls = [], timeouts = []
  const answers = ['第一个实际回答。', '第二个实际回答。', '第三个实际回答。', '另一条的回答。', '另一条的第二答。']
  await runPersonaDialogueCheck(input, {
    env: { AIRI_SMOKE_URL: 'https://example.invalid/airi/api/chat', AIRI_DEMO_ACCESS_CODE: 'test-code' },
    now: () => '2026-10-02T00:00:00.000Z',
    timeoutSignal: milliseconds => { timeouts.push(milliseconds); return new AbortController().signal },
    writeLine: line => lines.push(JSON.parse(line)),
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      if (options.method !== 'POST') return health({ accessProtected: true })
      assert.equal(lines.length, packets.length, 'previous evidence must be recorded before the next text request')
      packets.push(JSON.parse(options.body))
      const answer = answers[packets.length - 1]
      return ndjson([
        { type: 'delivery', value: 'bright' },
        { type: 'delta', content: answer.slice(0, 3) },
        { type: 'delta', content: answer.slice(3) },
        { type: 'done' },
      ])
    },
  })
  assert.deepEqual(packets.map(packet => packet.messages), [
    [{ role: 'user', content: '放学啦！' }],
    [{ role: 'user', content: '放学啦！' }, { role: 'assistant', content: answers[0] }, { role: 'user', content: '后来呢？' }],
    [{ role: 'user', content: '放学啦！' }, { role: 'assistant', content: answers[0] }, { role: 'user', content: '后来呢？' }, { role: 'assistant', content: answers[1] }, { role: 'user', content: '真的吗？' }],
    [{ role: 'user', content: '重新开始' }],
    [{ role: 'user', content: '重新开始' }, { role: 'assistant', content: answers[3] }, { role: 'user', content: '只问这一次' }],
  ])
  assert.equal(packets[0].persona.name, '日和')
  assert.equal(packets[0].userMemory, '喜欢草莓')
  assert.deepEqual(lines.map(line => [line.trajectoryId, line.turn, line.status, line.contextOrigin]), [
    ['first', 1, 'completed', 'free-running'], ['first', 2, 'completed', 'free-running'],
    ['first', 3, 'completed', 'free-running'], ['second', 1, 'completed', 'free-running'],
    ['second', 2, 'completed', 'free-running'],
  ])
  assert.deepEqual(lines.map(line => line.content.context), packets.map(packet => packet.messages))
  assert.ok(lines.every(line => line.evidence.requestedModel === 'test-model' && line.evidence.observedAt === '2026-10-02T00:00:00.000Z'))
  assert.ok(lines.every(line => line.evidence.serverEvents.length === 4))
  assert.ok(!JSON.stringify(lines).includes('test-code'))
  assert.deepEqual(timeouts, Array(10).fill(90_000))
  assert.ok(calls.every(call => call.options.redirect === 'error'))
  assert.equal(calls[0].url, 'https://example.invalid/airi/api/health')
  assert.equal(calls[1].options.headers['X-Demo-Access-Code'], 'test-code')
})

test('allows exactly four three-turn trajectories and at most twelve serial text requests', async () => {
  const input = { ...payload(), trajectories: Array.from({ length: 4 }, (_, index) => ({ id: String(index), turns: ['one', 'two', 'three'] })) }
  let requests = 0, bodiesRead = 0
  const lines = []
  await runPersonaDialogueCheck(input, {
    env: {}, writeLine: line => lines.push(JSON.parse(line)),
    fetchImpl: async (_url, options) => {
      if (options.method !== 'POST') return health()
      assert.equal(requests, bodiesRead)
      assert.equal(requests, lines.length)
      requests++
      return { ok: true, text: async () => {
        await Promise.resolve()
        bodiesRead++
        return reply(`actual-${requests}`).map(event => JSON.stringify(event)).join('\n')
      } }
    },
  })
  assert.equal(requests, 12)
  assert.equal(bodiesRead, 12)
  assert.equal(lines.length, 12)
  assert.ok(lines.every(line => line.status === 'completed'))
})

test('snapshots inputs before networking and retains shared persona and memory length normalization', async () => {
  const input = payload()
  input.persona.personality = '性'.repeat(2_001)
  input.persona.greeting = '好'.repeat(1_001)
  input.userMemory = '忆'.repeat(1_201)
  const packets = []
  await runPersonaDialogueCheck(input, {
    env: {}, writeLine: () => {},
    fetchImpl: async (_url, options) => {
      input.trajectories[0].turns[1] = 'changed during fetch'
      input.persona.name = 'changed during fetch'
      if (options.method !== 'POST') return health()
      packets.push(JSON.parse(options.body))
      return ndjson(reply('actual'))
    },
  })
  assert.equal(packets[1].messages.at(-1).content, '后来呢？')
  assert.ok(packets.every(packet => packet.persona.name === '日和'))
  assert.equal(packets[0].persona.personality.length, 2_000)
  assert.equal(packets[0].persona.greeting.length, 1_000)
  assert.equal(packets[0].userMemory.length, 1_200)
})

test('retains a single failed event record and never relays failure text or starts later trajectories', async () => {
  for (const [events, kind] of [
    [[{ type: 'delta', content: '失败半句' }, { type: 'error', message: 'upstream stopped' }], 'stream-error'],
    [[{ type: 'delta', content: '缺少结束' }], 'incomplete'],
    [[{ type: 'done' }], 'empty'],
  ]) {
    const input = payload()
    input.trajectories.push({ id: 'never', turns: ['not sent'] })
    const lines = [], packets = []
    await assert.rejects(runPersonaDialogueCheck(input, {
      env: {}, writeLine: line => lines.push(JSON.parse(line)),
      fetchImpl: async (_url, options) => {
        if (options.method !== 'POST') return health()
        packets.push(JSON.parse(options.body))
        return ndjson(packets.length === 1 ? reply('真实第一答') : events)
      },
    }), /stopped at trajectory 1, turn 2/)
    assert.equal(packets.length, 2)
    assert.equal(lines.length, 2, 'no duplicate fake reply for the failed stream')
    assert.equal(lines[0].status, 'completed')
    assert.equal(lines[1].status, 'failed')
    assert.equal(lines[1].evidence.failure.kind, kind)
    assert.deepEqual(lines[1].evidence.serverEvents, events)
    assert.deepEqual(lines[1].content.context, [
      { role: 'user', content: '放学啦！' }, { role: 'assistant', content: '真实第一答' }, { role: 'user', content: '后来呢？' },
    ])
  }
})

test('records explicit safe HTTP, network, read, and malformed NDJSON failures without retrying', async () => {
  for (const [mode, kind] of [['http', 'http'], ['fetch', 'network'], ['body', 'read'], ['ndjson', 'ndjson']]) {
    const lines = []
    let requests = 0
    await assert.rejects(runPersonaDialogueCheck(payload(), {
      env: { AIRI_DEMO_ACCESS_CODE: 'hidden-code', DEEPSEEK_API_KEY: 'hidden-key', AIRI_SMOKE_URL: 'https://private.invalid/airi/api/chat?hidden-query' },
      writeLine: line => lines.push(JSON.parse(line)),
      fetchImpl: async (_url, options) => {
        if (options.method !== 'POST') return health()
        requests++
        if (requests === 1) return ndjson(reply('成功'))
        if (mode === 'http') return new Response('hidden-code hidden-key private.invalid hidden-query', { status: 429 })
        if (mode === 'fetch') throw new Error('hidden-code hidden-key private.invalid hidden-query')
        if (mode === 'body') return { ok: true, text: async () => { throw new Error('hidden-code hidden-key private.invalid hidden-query') } }
        return new Response('{invalid hidden-code hidden-key private.invalid hidden-query')
      },
    }), error => !/hidden-code|hidden-key|private\.invalid|hidden-query/.test(error.message))
    assert.equal(requests, 2)
    assert.equal(lines.length, 2)
    assert.equal(lines[1].status, 'failed')
    assert.equal(lines[1].content.text, '')
    assert.equal(lines[1].evidence.requestedModel, 'test-model')
    assert.equal(lines[1].evidence.failure.kind, kind)
    assert.deepEqual(lines[1].evidence.serverEvents, [])
    if (mode === 'http') assert.equal(lines[1].evidence.failure.httpStatus, 429)
    assert.ok(!/hidden-code|hidden-key|private\.invalid|hidden-query/.test(JSON.stringify(lines)))
  }
})

test('redacts known environment secrets even if received events echo them', async () => {
  const lines = []
  await assert.rejects(runPersonaDialogueCheck(payload(), {
    env: { AIRI_DEMO_ACCESS_CODE: 'hidden-code', DEEPSEEK_API_KEY: 'hidden-key', CUSTOM_TOKEN: 'hidden-token' },
    writeLine: line => lines.push(JSON.parse(line)),
    fetchImpl: async (_url, options) => options.method !== 'POST'
      ? health()
      : ndjson([{ type: 'delta', content: 'hidden-key' }, { type: 'error', message: 'hidden-code', details: { token: 'hidden-token', 'hidden-key': 'safe' } }]),
  }))
  assert.equal(lines.length, 1)
  assert.equal(lines[0].status, 'failed')
  assert.equal(lines[0].content.text, '[redacted]')
  assert.deepEqual(lines[0].evidence.serverEvents[1], {
    type: 'error', message: '[redacted]',
    details: { token: '[redacted]', '[redacted]': 'safe' },
  })
  assert.equal(lines[0].evidence.redactionApplied, true)
  assert.ok(!/hidden-code|hidden-key|hidden-token/.test(JSON.stringify(lines)))
})

test('a done-terminated credential echo is failed and never passed to another turn', async () => {
  const lines = [], packets = []
  await assert.rejects(runPersonaDialogueCheck(payload(), {
    env: { AIRI_DEMO_ACCESS_CODE: 'hidden-code', DEEPSEEK_API_KEY: 'hidden-key' },
    writeLine: line => lines.push(JSON.parse(line)),
    fetchImpl: async (_url, options) => {
      if (options.method !== 'POST') return health()
      packets.push(JSON.parse(options.body))
      return ndjson(reply('Do not relay hidden-key or hidden-code.'))
    },
  }), /stopped at trajectory 1, turn 1/)
  assert.equal(packets.length, 1)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].status, 'failed')
  assert.equal(lines[0].evidence.failure.kind, 'credential-echo')
  assert.equal(lines[0].evidence.redactionApplied, true)
  assert.equal(lines[0].content.text, 'Do not relay [redacted] or [redacted].')
  assert.ok(!/hidden-code|hidden-key/.test(JSON.stringify(lines)))
})

test('configuration parameters such as MAX_TOKENS are not mistaken for credentials', async () => {
  const lines = [], packets = []
  await runPersonaDialogueCheck(payload(), {
    env: { DEEPSEEK_MAX_TOKENS: '320', AIRI_DEMO_ACCESS_CODE: 'hidden-code' },
    writeLine: line => lines.push(JSON.parse(line)),
    fetchImpl: async (_url, options) => {
      if (options.method !== 'POST') return health()
      packets.push(JSON.parse(options.body))
      return ndjson(reply('普通数字 320。'))
    },
  })
  assert.equal(packets.length, 3)
  assert.ok(lines.every(line => line.status === 'completed'))
  assert.ok(lines.every(line => line.evidence.redactionApplied === undefined))
  assert.equal(lines[0].content.text, '普通数字 320。')
  assert.equal(packets[1].messages[1].content, '普通数字 320。')
})

test('records health and configuration failure safely without making a text request', async () => {
  for (const [env, makeHealth, kind, expectedCalls] of [
    [{}, () => health({ configured: false }), 'health', 1],
    [{}, () => health({ accessProtected: true }), 'health', 1],
    [{}, () => new Response('invalid secret body'), 'health-json', 1],
    [{ AIRI_SMOKE_URL: 'https://user:secret-password@example.invalid/api/chat' }, () => health(), 'configuration', 0],
  ]) {
    let calls = 0
    const lines = []
    await assert.rejects(runPersonaDialogueCheck(payload(), {
      env, writeLine: line => lines.push(JSON.parse(line)),
      fetchImpl: async () => { calls++; return makeHealth() },
    }), error => !error.message.includes('secret'))
    assert.equal(calls, expectedCalls)
    assert.equal(lines.length, 1)
    assert.equal(lines[0].status, 'failed')
    assert.equal(lines[0].evidence.failure.kind, kind)
    assert.ok(!/secret|example\.invalid/.test(JSON.stringify(lines)))
  }
})

const cliPath = fileURLToPath(new URL('./persona-dialogue-check.mjs', import.meta.url))
function mockCli(input, responseBody, env = {}) {
  const code = `
    process.argv[1] = ${JSON.stringify(cliPath)};
    globalThis.fetch = async (_url, options) => options.method !== 'POST'
      ? Response.json({configured:true,model:'cli-model',accessProtected:false})
      : new Response(${JSON.stringify(responseBody)});
    await import(${JSON.stringify(new URL('./persona-dialogue-check.mjs', import.meta.url).href)});
  `
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    input, encoding: 'utf8', env: { ...process.env, ...env },
  })
}

test('CLI accepts JSON stdin and marks successful records completed', () => {
  const input = { ...payload(), trajectories: [{ id: 'cli', turns: ['hello', 'next'] }] }
  const result = mockCli(JSON.stringify(input), reply('actual CLI answer').map(event => JSON.stringify(event)).join('\n'))
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  const lines = result.stdout.trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(lines.map(line => line.status), ['completed', 'completed'])
  assert.equal(lines[1].content.context[1].content, 'actual CLI answer')
  assert.equal(lines[1].evidence.requestedModel, 'cli-model')
})

test('CLI returns nonzero for invalid stdin and failed streams without leaking secrets', () => {
  const env = { AIRI_DEMO_ACCESS_CODE: 'secret-code', DEEPSEEK_API_KEY: 'secret-key' }
  const invalid = mockCli('{invalid secret-input', '', env)
  assert.equal(invalid.status, 1)
  assert.equal(invalid.stdout, '')
  assert.equal(invalid.stderr, 'Standard input must be valid JSON.\n')
  const failure = mockCli(JSON.stringify(payload()), '{invalid secret-code secret-key https://private.invalid', env)
  assert.equal(failure.status, 1)
  const lines = failure.stdout.trim().split('\n').map(line => JSON.parse(line))
  assert.equal(lines.length, 1)
  assert.equal(lines[0].status, 'failed')
  assert.equal(lines[0].evidence.failure.kind, 'ndjson')
  assert.match(failure.stderr, /stopped at trajectory 1, turn 1/)
  assert.ok(!/secret-code|secret-key|private\.invalid/.test(failure.stdout + failure.stderr))
})
