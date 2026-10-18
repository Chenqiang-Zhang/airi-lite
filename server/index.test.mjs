import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// Run the real server process against a local DeepSeek stand-in. The child gets
// an explicit env only, so no real key or provider URL can leak in.
const entry = fileURLToPath(new URL('./index.mjs', import.meta.url))
const accessCode = 'local-test-access-code'

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server.address().port
}

async function startUpstream(handler) {
  const requests = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request)
      chunks.push(chunk)
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    handler(response)
  })
  const port = await listen(server)
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

async function startApp(env) {
  const probe = createServer()
  const port = await listen(probe)
  await new Promise(resolve => probe.close(resolve))
  const child = spawn(process.execPath, [entry], {
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(port),
      AIRI_DEMO_ACCESS_CODE: accessCode,
      DEEPSEEK_API_KEY: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  await new Promise((resolve, reject) => {
    const onData = (chunk) => {
      output += chunk
      if (output.includes('AIRI Lite running'))
        resolve()
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', chunk => (output += chunk))
    child.once('exit', code => reject(new Error(`server exited (${code}): ${output}`)))
  })
  return {
    url: `http://127.0.0.1:${port}`,
    stop: async () => {
      if (child.exitCode === null) {
        child.kill()
        await once(child, 'exit')
      }
    },
  }
}

const sse = chunk => `data: ${JSON.stringify(chunk)}\n\n`

function postChat(app) {
  return fetch(`${app.url}/airi/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Demo-Access-Code': accessCode },
    body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }], persona: {} }),
  })
}

const events = async response => (await response.text()).trim().split('\n').map(line => JSON.parse(line))

test('a length-capped DeepSeek reply ends with a truncated done event; an empty max_tokens env keeps the default', async () => {
  let finishReason = 'length'
  const upstream = await startUpstream((response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.write(sse({ choices: [{ delta: { content: '写到一半' }, finish_reason: null }] }))
    response.write(sse({ choices: [{ delta: {}, finish_reason: finishReason }] }))
    response.write(sse({ choices: [], usage: { completion_tokens: 320 } }))
    response.end('data: [DONE]\n\n')
  })
  const app = await startApp({
    DEEPSEEK_API_KEY: 'local-test-key',
    DEEPSEEK_BASE_URL: upstream.url,
    DEEPSEEK_MAX_TOKENS: '',
  })
  try {
    const truncated = await postChat(app)
    assert.equal(truncated.status, 200)
    assert.deepEqual(await events(truncated), [
      { type: 'delta', content: '写到一半' },
      { type: 'done', truncated: true },
    ])
    assert.equal(upstream.requests[0].max_tokens, 320)

    finishReason = 'stop'
    const complete = await postChat(app)
    assert.deepEqual((await events(complete)).at(-1), { type: 'done' })
  }
  finally {
    await app.stop()
    await upstream.close()
  }
})

test('a busy server and an unconfigured DeepSeek answer 503 with distinct codes', async () => {
  const held = []
  const upstream = await startUpstream((response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.write(sse({ choices: [{ delta: { content: '稍等' } }] }))
    held.push(response)
  })
  const app = await startApp({ DEEPSEEK_API_KEY: 'local-test-key', DEEPSEEK_BASE_URL: upstream.url })
  const unconfigured = await startApp({})
  try {
    const active = await Promise.all(Array.from({ length: 4 }, () => postChat(app)))
    assert.equal(upstream.requests.length, 4)

    const busy = await postChat(app)
    assert.equal(busy.status, 503)
    assert.equal((await busy.json()).code, 'CHAT_BUSY')

    for (const response of held)
      response.end('data: [DONE]\n\n')
    for (const response of active)
      assert.deepEqual((await events(response)).at(-1), { type: 'done' })

    const missingKey = await postChat(unconfigured)
    assert.equal(missingKey.status, 503)
    assert.equal((await missingKey.json()).code, 'DEEPSEEK_NOT_CONFIGURED')
  }
  finally {
    for (const response of held)
      response.destroy()
    await app.stop()
    await unconfigured.stop()
    await upstream.close()
  }
})
