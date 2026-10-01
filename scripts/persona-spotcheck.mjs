import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { normaliseChatRequest } from '../shared/chat-request.mjs'

const DEFAULT_CHAT_URL = 'http://127.0.0.1:3001/airi/api/chat'
const TIMEOUT_MS = 90_000

class SpotcheckError extends Error {}

function prepareCases(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || !payload.persona || typeof payload.persona !== 'object' || Array.isArray(payload.persona))
    throw new SpotcheckError('Input must contain a persona object.')
  if (!Array.isArray(payload.cases) || payload.cases.length < 1 || payload.cases.length > 8)
    throw new SpotcheckError('Input must contain between 1 and 8 cases.')
  const ids = new Set()
  return payload.cases.map((sample, index) => {
    const id = typeof sample?.id === 'string' ? sample.id.trim() : ''
    if (!id || ids.has(id))
      throw new SpotcheckError(`Case ${index + 1} needs a nonempty, unique string id.`)
    ids.add(id)
    let request
    try {
      request = normaliseChatRequest({
        persona: payload.persona,
        userMemory: payload.userMemory,
        messages: sample.messages,
      })
    }
    catch {
      throw new SpotcheckError(`Case ${index + 1} has an invalid chat request.`)
    }
    return { id, request }
  })
}

function chatEndpoint(value) {
  try {
    const url = new URL(value || DEFAULT_CHAT_URL)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || !url.pathname.endsWith('/api/chat') || url.hash)
      throw new Error()
    return url
  }
  catch {
    throw new SpotcheckError('AIRI_SMOKE_URL must be an HTTP(S) /api/chat endpoint without embedded credentials.')
  }
}

async function request(fetchImpl, url, options, label) {
  let response
  try {
    response = await fetchImpl(url.href, { ...options, redirect: 'error' })
  }
  catch {
    // Fetch exceptions may contain request URLs or headers. Do not echo them.
    throw new SpotcheckError(`${label} request failed or timed out.`)
  }
  if (!response.ok)
    throw new SpotcheckError(`${label} request returned HTTP ${response.status}.`)
  return response
}

// Capture explicit, small synthetic cases. No scoring or naturalness claims.
// serverEvents are this application's NDJSON events, not raw provider events.
export async function runPersonaSpotcheck(payload, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  writeLine = line => process.stdout.write(`${line}\n`),
  now = () => new Date().toISOString(),
  timeoutSignal = milliseconds => AbortSignal.timeout(milliseconds),
} = {}) {
  // Validate the entire batch before even the read-only health request.
  const cases = prepareCases(payload)
  const chatUrl = chatEndpoint(env.AIRI_SMOKE_URL)
  const accessCode = env.AIRI_DEMO_ACCESS_CODE || ''
  if (accessCode && !/^[\x21-\x7e]{1,256}$/.test(accessCode))
    throw new SpotcheckError('AIRI_DEMO_ACCESS_CODE must contain 1–256 printable ASCII characters without spaces.')
  const healthUrl = new URL('health', chatUrl)
  const healthResponse = await request(fetchImpl, healthUrl, {
    signal: timeoutSignal(TIMEOUT_MS),
  }, 'Health')
  let health
  try {
    health = await healthResponse.json()
  }
  catch {
    throw new SpotcheckError('Health response was not valid JSON.')
  }
  if (health?.configured !== true || typeof health.model !== 'string' || !health.model.trim())
    throw new SpotcheckError('Health response must report a configured provider and a model.')
  if (health.accessProtected && !accessCode)
    throw new SpotcheckError('AIRI_DEMO_ACCESS_CODE is required by this server.')

  for (let index = 0; index < cases.length; index++) {
    const { id, request: packet } = cases[index]
    const label = `Case ${index + 1}`
    const response = await request(fetchImpl, chatUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(accessCode ? { 'X-Demo-Access-Code': accessCode } : {}),
      },
      body: JSON.stringify(packet),
      signal: timeoutSignal(TIMEOUT_MS),
    }, label)
    let body
    try {
      body = await response.text()
    }
    catch {
      throw new SpotcheckError(`${label} response could not be read or timed out.`)
    }
    let serverEvents
    try {
      serverEvents = body.split('\n').filter(line => line.trim()).map(line => JSON.parse(line))
      if (serverEvents.some(event => !event || typeof event !== 'object' || Array.isArray(event)
        || typeof event.type !== 'string'
        || (event.type === 'delta' && typeof event.content !== 'string')))
        throw new Error()
    }
    catch {
      throw new SpotcheckError(`${label} response was not valid server NDJSON.`)
    }
    const text = serverEvents.filter(event => event.type === 'delta').map(event => event.content).join('')
    writeLine(JSON.stringify({
      id,
      content: { context: packet.messages, text },
      evidence: { observedAt: now(), requestedModel: health.model, serverEvents },
    }))
    // Preserve received failure evidence, then stop the batch with a failing exit.
    if (serverEvents.some(event => event.type === 'error'))
      throw new SpotcheckError(`${label} server stream reported an error; received events were recorded.`)
    if (serverEvents.at(-1)?.type !== 'done' || !text.trim())
      throw new SpotcheckError(`${label} server stream was incomplete or empty; received events were recorded.`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    let payload
    try {
      payload = JSON.parse(readFileSync(0, 'utf8'))
    }
    catch {
      throw new SpotcheckError('Standard input must be valid JSON.')
    }
    await runPersonaSpotcheck(payload)
  }
  catch (error) {
    process.stderr.write(`${error instanceof SpotcheckError ? error.message : 'Persona spotcheck failed.'}\n`)
    process.exitCode = 1
  }
}
