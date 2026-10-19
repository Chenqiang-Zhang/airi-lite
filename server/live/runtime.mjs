import { randomUUID } from 'node:crypto'

import { SpeechProviderError } from '../speech-error.mjs'
import { speechErrorResponse } from '../speech.mjs'
import { checkLocalRequest, LiveRequestError, readSmallJson } from './local-request.mjs'
import { createSseChannel } from './sse.mjs'
import { createStageBus, STAGE_ROLES } from './stage-bus.mjs'
import { createSentenceAllowance, planUtterance } from './utterance.mjs'

const DELIVERIES = new Set(['neutral', 'soft', 'bright', 'curious'])
const OUTCOMES = new Set(['played', 'partial', 'failed', 'cancelled', 'empty'])
const AVATAR_STATES = new Set(['loading', 'ready', 'failed'])
const MAX_SAY_CHARS = 200
const MAX_PROBLEM_CHARS = 120
// C0/C1 controls and bidi overrides/isolates: never forwarded to captions/TTS.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g

// M1 of the live plan: the host's console says a line, the OBS stage speaks it.
// Later milestones replace only who decides what to say (the brain).
export function createLiveRuntime({
  speech,
  now = Date.now,
  timers = { setTimeout, clearTimeout, setInterval, clearInterval },
  newId = randomUUID,
  heartbeatMs = 15_000,
} = {}) {
  if (!speech?.synthesise)
    throw new TypeError('createLiveRuntime requires a speech handler with synthesise()')

  let control = 'running' // running | paused | panic
  let mode = 'live' // live | brb
  let turn = null
  let lastOutcome = null
  let lastProblem = null
  let stopped = false

  const sse = createSseChannel({ heartbeatMs, timers })
  const bus = createStageBus({ sse, newId, now, getMode: () => mode })
  // A new primary never inherits an old page's half-spoken turn.
  bus.onPrimaryChange(() => {
    if (turn)
      endTurn(turn.turnId, 'cancelled', { notifyStage: true })
  })

  function endTurn(turnId, outcome, { notifyStage = false } = {}) {
    if (!turn || turn.turnId !== turnId)
      return false
    // Detach before publishing: a publish can close a stalled primary, whose
    // lease change re-enters endTurn() synchronously and must find no turn.
    const ended = turn
    turn = null
    timers.clearTimeout(ended.watchdog)
    lastOutcome = { turnId, outcome, at: now(), sentencesBought: ended.bought, sentencesPlanned: ended.planned }
    if (notifyStage)
      bus.publish('stop', { turnId })
    return true
  }

  async function startTurn({ text, delivery }) {
    if (control !== 'running')
      return { status: 409, body: { code: 'LIVE_PAUSED' } }
    if (!bus.hasReadyPrimary())
      return { status: 409, body: { code: 'LIVE_NO_STAGE' } }
    if (turn)
      return { status: 409, body: { code: 'LIVE_TURN_ACTIVE' } }
    const sentences = await planUtterance({ text, delivery })
    if (!sentences.length)
      return { status: 400, body: { code: 'LIVE_EMPTY' } }
    // Re-check after the await: a concurrent say may have started a turn,
    // the stage may have gone, or the host may have paused meanwhile.
    if (stopped || control !== 'running')
      return { status: 409, body: { code: 'LIVE_PAUSED' } }
    if (!bus.hasReadyPrimary())
      return { status: 409, body: { code: 'LIVE_NO_STAGE' } }
    if (turn)
      return { status: 409, body: { code: 'LIVE_TURN_ACTIVE' } }

    const turnId = newId()
    const watchdogMs = Math.min(90_000, 15_000 + 350 * text.length)
    turn = {
      turnId,
      text,
      delivery,
      startedAt: now(),
      allowance: createSentenceAllowance(sentences),
      planned: sentences.length,
      bought: 0,
      watchdog: timers.setTimeout(() => endTurn(turnId, 'timeout', { notifyStage: true }), watchdogMs),
    }
    turn.watchdog.unref?.()
    bus.publish('say', { turnId, text, delivery, cues: [], replyTo: null })
    // Publishing can drop a stalled primary, which cancels this very turn
    // (its lease handover runs one microtask later). Never report success
    // for it, and leave every page's last word "stop".
    await null
    if (turn?.turnId !== turnId) {
      bus.publish('stop', { turnId })
      return { status: 409, body: { code: 'LIVE_NO_STAGE' } }
    }
    return { status: 200, body: { turnId, sentences: sentences.length } }
  }

  async function handleControl(request, response) {
    const body = await readSmallJson(request)
    switch (body.action) {
      case 'say': {
        const text = typeof body.text === 'string' ? body.text.replace(CONTROL_CHARACTERS, '').trim() : ''
        if (!text || text.length > MAX_SAY_CHARS || !text.isWellFormed() || text.includes('[[') || text.includes(']]'))
          return sendJson(response, 400, { code: 'LIVE_INVALID_TEXT' })
        const delivery = body.delivery ?? 'neutral'
        if (!DELIVERIES.has(delivery))
          return sendJson(response, 400, { code: 'LIVE_INVALID_DELIVERY' })
        const result = await startTurn({ text, delivery })
        return sendJson(response, result.status, result.body)
      }
      case 'stop':
        if (turn)
          endTurn(turn.turnId, 'stopped', { notifyStage: true })
        return sendJson(response, 200, state())
      case 'pause':
        if (control === 'running')
          control = 'paused'
        return sendJson(response, 200, state())
      case 'resume':
        control = 'running'
        setMode('live')
        return sendJson(response, 200, state())
      case 'panic':
        if (turn)
          endTurn(turn.turnId, 'stopped', { notifyStage: true })
        control = 'panic'
        setMode('brb')
        return sendJson(response, 200, state())
      case 'reload-stage':
        bus.publish('reload', {})
        return sendJson(response, 200, state())
      default:
        return sendJson(response, 400, { code: 'LIVE_INVALID_ACTION' })
    }
  }

  function setMode(next) {
    if (mode === next)
      return
    mode = next
    bus.publish('mode', { mode })
  }

  async function handleReport(request, response) {
    const body = await readSmallJson(request)
    if (!bus.isPrimary(body.leaseId))
      return sendJson(response, 403, { code: 'LIVE_NOT_PRIMARY' })
    switch (body.type) {
      case 'ready':
        bus.updatePrimaryStatus(body.leaseId, { ready: true })
        break
      case 'avatar':
        if (!AVATAR_STATES.has(body.status))
          return sendJson(response, 400, { code: 'LIVE_INVALID_REPORT' })
        bus.updatePrimaryStatus(body.leaseId, { avatar: body.status })
        break
      case 'ended':
        if (typeof body.turnId !== 'string' || !OUTCOMES.has(body.outcome))
          return sendJson(response, 400, { code: 'LIVE_INVALID_REPORT' })
        bus.updatePrimaryStatus(body.leaseId, {})
        // A late report for a turn the host already stopped is harmless.
        endTurn(body.turnId, body.outcome)
        break
      case 'problem': {
        const message = typeof body.message === 'string'
          ? body.message.replace(CONTROL_CHARACTERS, '').trim().slice(0, MAX_PROBLEM_CHARS) : ''
        if (!message)
          return sendJson(response, 400, { code: 'LIVE_INVALID_REPORT' })
        bus.updatePrimaryStatus(body.leaseId, {})
        lastProblem = { message, at: now() }
        break
      }
      case 'obs': {
        const flag = value => (typeof value === 'boolean' ? value : null)
        bus.updatePrimaryStatus(body.leaseId, {
          obs: { active: flag(body.active), visible: flag(body.visible), streaming: flag(body.streaming) },
        })
        break
      }
      default:
        return sendJson(response, 400, { code: 'LIVE_INVALID_REPORT' })
    }
    response.writeHead(204, { 'Cache-Control': 'no-store' })
    response.end()
  }

  // The only route the stage uses to buy audio: the server decides which
  // sentences exist, each is bought at most once, and only by the primary.
  async function handleStageSpeech(request, response) {
    const body = await readSmallJson(request, 4_096)
    if (!bus.isPrimary(body.leaseId))
      return sendJson(response, 403, { code: 'LIVE_NOT_PRIMARY' })
    if (!turn || body.turnId !== turn.turnId)
      return sendJson(response, 409, { code: 'LIVE_TURN_MISMATCH' })
    if (typeof body.text !== 'string' || !DELIVERIES.has(body.delivery)
      || !turn.allowance.take({ text: body.text, delivery: body.delivery }))
      return sendJson(response, 409, { code: 'LIVE_SENTENCE_NOT_ALLOWED' })
    turn.bought++

    const cancelled = new AbortController()
    const abort = () => cancelled.abort()
    response.once('close', abort)
    try {
      const result = await speech.synthesise({ text: body.text, delivery: body.delivery }, { signal: cancelled.signal })
      if (!response.destroyed && !response.writableEnded)
        sendJson(response, 200, result)
    }
    catch (error) {
      if (cancelled.signal.aborted || response.destroyed || response.writableEnded)
        return
      // Same stable codes as /api/speech; never echo text or provider detail.
      if (error instanceof SpeechProviderError && (error.code === 'TTS_BUSY' || error.code === 'TTS_NOT_CONFIGURED'))
        return sendJson(response, 503, { code: error.code })
      const { status, code } = speechErrorResponse(error)
      sendJson(response, status, { code })
    }
    finally {
      response.removeListener('close', abort)
    }
  }

  function state() {
    return {
      control,
      mode,
      stage: bus.summary(),
      turn: turn ? {
        turnId: turn.turnId, text: turn.text, delivery: turn.delivery,
        startedAgoMs: now() - turn.startedAt, sentencesPlanned: turn.planned, sentencesBought: turn.bought,
      } : null,
      lastOutcome,
      lastProblem,
      speech: speech.health(),
    }
  }

  async function handle(request, response, pathname) {
    if (stopped)
      return false
    const rejection = checkLocalRequest(request)
    if (rejection) {
      sendJson(response, rejection.status, { code: rejection.code })
      return true
    }
    try {
      if (request.method === 'GET' && pathname === '/api/live/stage/events') {
        const role = new URL(request.url ?? '/', 'http://localhost').searchParams.get('role') ?? 'preview'
        if (!STAGE_ROLES.has(role))
          sendJson(response, 400, { code: 'LIVE_INVALID_ROLE' })
        else
          bus.connect(request, response, role)
        return true
      }
      if (request.method === 'GET' && pathname === '/api/live/state') {
        sendJson(response, 200, state())
        return true
      }
      if (request.method === 'POST' && pathname === '/api/live/stage/report') {
        await handleReport(request, response)
        return true
      }
      if (request.method === 'POST' && pathname === '/api/live/stage/speech') {
        await handleStageSpeech(request, response)
        return true
      }
      if (request.method === 'POST' && pathname === '/api/live/control') {
        await handleControl(request, response)
        return true
      }
      return false
    }
    catch (error) {
      if (!(error instanceof LiveRequestError))
        throw error
      if (!response.headersSent)
        sendJson(response, error.status, { code: error.code })
      return true
    }
  }

  return {
    handle,
    // Non-secret status for /api/health.
    health() {
      const summary = bus.summary()
      return {
        enabled: true,
        control,
        mode,
        stageOnline: Boolean(summary.primary),
        stageReady: Boolean(summary.primary?.ready),
        avatar: summary.primary?.avatar ?? null,
        lastReportAgoMs: summary.primary?.lastReportAgoMs ?? null,
      }
    },
    async stop() {
      if (stopped)
        return
      stopped = true
      if (turn)
        endTurn(turn.turnId, 'stopped', { notifyStage: true })
      bus.closeAll()
    },
  }
}

function sendJson(response, status, payload) {
  if (response.destroyed || response.writableEnded)
    return
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(JSON.stringify(payload))
}
