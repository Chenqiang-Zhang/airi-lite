import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { MAX_MESSAGE_CHARS, normaliseChatRequest } from '../shared/chat-request.mjs'
import { runPersonaSpotcheck } from './persona-spotcheck.mjs'

const PERSONA_FIELDS = [
  'name', 'personality', 'preferences', 'scenario', 'speakingStyle',
  'behaviorGuidelines', 'dialogueExamples', 'greeting',
]
const MAX_TRAJECTORIES = 4
const MAX_TURNS = 3
const MAX_TEXT_REQUESTS = 12

class DialogueCheckError extends Error {}

function prepareTrajectories(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || !payload.persona || typeof payload.persona !== 'object' || Array.isArray(payload.persona))
    throw new DialogueCheckError('Input must contain a persona object.')
  if (PERSONA_FIELDS.some(field => payload.persona[field] !== undefined && typeof payload.persona[field] !== 'string'))
    throw new DialogueCheckError('Known persona fields must be strings when provided.')
  if (payload.userMemory !== undefined && typeof payload.userMemory !== 'string')
    throw new DialogueCheckError('userMemory must be a string when provided.')
  if (!Array.isArray(payload.trajectories) || payload.trajectories.length < 1 || payload.trajectories.length > MAX_TRAJECTORIES)
    throw new DialogueCheckError('Input must contain between 1 and 4 trajectories.')

  const ids = new Set()
  let totalTurns = 0
  const trajectories = []
  let normalized
  for (const [index, trajectory] of payload.trajectories.entries()) {
    const id = typeof trajectory?.id === 'string' ? trajectory.id.trim() : ''
    if (!id || ids.has(id))
      throw new DialogueCheckError(`Trajectory ${index + 1} needs a nonempty, unique string id.`)
    ids.add(id)
    if (!Array.isArray(trajectory.turns) || trajectory.turns.length < 1 || trajectory.turns.length > MAX_TURNS)
      throw new DialogueCheckError(`Trajectory ${index + 1} must contain between 1 and 3 user turns.`)
    const turns = []
    for (const [turnIndex, content] of trajectory.turns.entries()) {
      if (typeof content !== 'string' || !content.trim() || content.trim().length > MAX_MESSAGE_CHARS)
        throw new DialogueCheckError(`Trajectory ${index + 1}, turn ${turnIndex + 1} needs a nonempty user string of at most 8000 characters.`)
      try {
        // Normalize every supplied turn before any health or chat request.
        // Persona/memory length behavior stays shared with the application.
        normalized = normaliseChatRequest({
          persona: payload.persona,
          userMemory: payload.userMemory,
          messages: [{ role: 'user', content }],
        })
      }
      catch {
        throw new DialogueCheckError(`Trajectory ${index + 1}, turn ${turnIndex + 1} has an invalid chat request.`)
      }
      turns.push(normalized.messages[0].content)
    }
    totalTurns += turns.length
    trajectories.push({ id, turns })
  }
  if (totalTurns > MAX_TEXT_REQUESTS)
    throw new DialogueCheckError('A dialogue check may make at most 12 text requests.')
  return { persona: normalized.persona, userMemory: normalized.userMemory, trajectories }
}

function secretValues(env) {
  return [...new Set(Object.entries(env)
    .filter(([name, value]) => /(?:^|_)(?:API_?KEY|ACCESS_?CODE|TOKEN|SECRET|PASSWORD|CREDENTIAL)$/i.test(name)
      && typeof value === 'string' && value)
    .map(([, value]) => value))].sort((left, right) => right.length - left.length)
}

function redact(value, secrets) {
  if (typeof value === 'string') {
    for (const secret of secrets)
      value = value.split(secret).join('[redacted]')
    return value
  }
  if (Array.isArray(value))
    return value.map(item => redact(item, secrets))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .map(([key, item]) => [redact(key, secrets), redact(item, secrets)]))
  }
  return value
}

function streamFailure(events, text) {
  if (events.some(event => event.type === 'error'))
    return { stage: 'chat', kind: 'stream-error' }
  if (events.at(-1)?.type !== 'done')
    return { stage: 'chat', kind: 'incomplete' }
  if (!text.trim())
    return { stage: 'chat', kind: 'empty' }
  return null
}

// Free-running means the next request includes the last successful *actual*
// assistant response. These bounded synthetic trajectories are evidence, not a
// listener rating, a human-likeness score, or a promise of conversational quality.
export async function runPersonaDialogueCheck(payload, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  writeLine = line => process.stdout.write(`${line}\n`),
  now = () => new Date().toISOString(),
  timeoutSignal = milliseconds => AbortSignal.timeout(milliseconds),
} = {}) {
  const prepared = prepareTrajectories(payload)
  const secrets = secretValues(env)
  const emit = record => {
    const sanitized = redact(record, secrets)
    if (JSON.stringify(sanitized) !== JSON.stringify(record))
      sanitized.evidence = { ...sanitized.evidence, redactionApplied: true }
    writeLine(JSON.stringify(sanitized))
  }

  for (const [trajectoryIndex, trajectory] of prepared.trajectories.entries()) {
    // No greeting or fixture assistant response, and no cross-trajectory history.
    const history = []
    for (const [turnIndex, userText] of trajectory.turns.entries()) {
      const turn = turnIndex + 1
      const id = `${trajectory.id}:turn-${turn}`
      let packet
      try {
        packet = normaliseChatRequest({
          persona: prepared.persona,
          userMemory: prepared.userMemory,
          messages: [...history, { role: 'user', content: userText }],
        })
      }
      catch {
        // No provider request is made for an unusable accumulated context.
        throw new DialogueCheckError(`Dialogue check could not prepare trajectory ${trajectoryIndex + 1}, turn ${turn}.`)
      }
      let recorded = false
      let successfulText
      let requestedModel = null
      let failure = { stage: 'configuration', kind: 'configuration' }

      const trackedFetch = async (url, options) => {
        const stage = options.method === 'POST' ? 'chat' : 'health'
        let response
        try {
          response = await fetchImpl(url, options)
        }
        catch (error) {
          failure = { stage, kind: 'network' }
          throw error // The existing runner sanitizes fetch exceptions.
        }
        if (!response.ok) {
          failure = { stage, kind: 'http' }
          if (Number.isInteger(response.status) && response.status >= 100 && response.status <= 599)
            failure.httpStatus = response.status
          return response
        }
        if (stage === 'health') {
          failure = { stage, kind: 'health' }
          return {
            ok: response.ok,
            status: response.status,
            json: async () => {
              let health
              try {
                health = await response.json()
              }
              catch (error) {
                failure = { stage, kind: 'health-json' }
                throw error
              }
              if (typeof health?.model === 'string' && health.model.trim())
                requestedModel = health.model
              return health
            },
          }
        }
        return {
          ok: response.ok,
          status: response.status,
          text: async () => {
            try {
              const body = await response.text()
              failure = { stage, kind: 'ndjson' }
              return body
            }
            catch (error) {
              failure = { stage, kind: 'read' }
              throw error
            }
          },
        }
      }

      try {
        await runPersonaSpotcheck({
          persona: packet.persona,
          userMemory: packet.userMemory,
          cases: [{ id, messages: packet.messages }],
        }, {
          env,
          fetchImpl: trackedFetch,
          now,
          timeoutSignal,
          writeLine: line => {
            const record = JSON.parse(line)
            let receivedFailure = streamFailure(record.evidence.serverEvents, record.content.text)
            if (!receivedFailure && secrets.some(secret => record.content.text.includes(secret)))
              receivedFailure = { stage: 'chat', kind: 'credential-echo' }
            recorded = true
            if (!receivedFailure)
              successfulText = record.content.text
            emit({
              ...record,
              trajectoryId: trajectory.id,
              turn,
              contextOrigin: 'free-running',
              status: receivedFailure ? 'failed' : 'completed',
              evidence: {
                ...record.evidence,
                ...(receivedFailure ? { failure: receivedFailure } : {}),
              },
            })
          },
        })
      }
      catch {
        if (!recorded) {
          // HTTP, unreadable bodies, and malformed NDJSON cannot be represented
          // as replies. Preserve the request and a safe failure classification;
          // never emit headers, endpoints, response bodies, or exception text.
          emit({
            id,
            trajectoryId: trajectory.id,
            turn,
            contextOrigin: 'free-running',
            status: 'failed',
            content: { context: packet.messages, text: '' },
            evidence: { observedAt: now(), requestedModel, serverEvents: [], failure },
          })
        }
        throw new DialogueCheckError(`Dialogue check stopped at trajectory ${trajectoryIndex + 1}, turn ${turn}; failure evidence was recorded.`)
      }
      if (!recorded || successfulText === undefined)
        throw new DialogueCheckError(`Dialogue check stopped at trajectory ${trajectoryIndex + 1}, turn ${turn}; no safe complete reply was recorded.`)
      // Only a fully read, nonempty, done-terminated response may continue.
      history.push({ role: 'user', content: userText }, { role: 'assistant', content: successfulText })
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    let payload
    try {
      payload = JSON.parse(readFileSync(0, 'utf8'))
    }
    catch {
      throw new DialogueCheckError('Standard input must be valid JSON.')
    }
    await runPersonaDialogueCheck(payload)
  }
  catch (error) {
    process.stderr.write(`${error instanceof DialogueCheckError ? error.message : 'Persona dialogue check failed.'}\n`)
    process.exitCode = 1
  }
}
