import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { openDeepSeekStream } from '../deepseek.mjs'
import { SpeechProviderError } from '../speech-error.mjs'
import { speechErrorResponse } from '../speech.mjs'
import { createTtsBudget, TtsBudgetError } from '../tts-budget.mjs'
import { createAuditLog } from './audit-log.mjs'
import { createLiveBrain } from './brain.mjs'
import { createHub } from './hub.mjs'
import { checkLocalRequest, LiveRequestError, readSmallJson } from './local-request.mjs'
import { loadRules, parseRules } from './moderation.mjs'
import { countRuleTerms, runPreflight } from './preflight.mjs'
import { createCandidateQueue } from './queue.mjs'
import { createSseChannel } from './sse.mjs'
import { createStageBus, STAGE_ROLES } from './stage-bus.mjs'
import { HOST_CONTROL } from './text.mjs'
import { createSentenceAllowance, planUtterance, screenUtterance } from './utterance.mjs'

const DELIVERIES = new Set(['neutral', 'soft', 'bright', 'curious'])
const OUTCOMES = new Set(['played', 'partial', 'failed', 'cancelled', 'empty'])
const AVATAR_STATES = new Set(['loading', 'ready', 'failed'])
const INPUT_KINDS = { 'input.danmaku': 'danmaku', 'input.superchat': 'superchat', 'input.host': 'host' }
const MAX_SAY_CHARS = 200
const MAX_PROBLEM_CHARS = 120

// A process-local daily counter for tests and runs without a data directory.
export function createMemoryReplyBudget({ dailyLimit, now = Date.now }) {
  let day = ''
  let used = 0
  return {
    async reserve(count, signal) {
      if (signal?.aborted)
        throw new TtsBudgetError('TTS_CANCELLED')
      const today = new Date(now()).toISOString().slice(0, 10)
      if (today !== day) { day = today; used = 0 }
      if (used + count > dailyLimit)
        throw new TtsBudgetError('TTS_DAILY_LIMIT')
      used += count
      return { day, reserved: used }
    },
    async peek() {
      const today = new Date(now()).toISOString().slice(0, 10)
      return { day: today, reserved: today === day ? used : 0 }
    },
  }
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = typeof value === 'string' && value.trim() ? Number(value) : Number.NaN
  return Number.isInteger(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback
}

// The live subsystem: stage bus and turns (M1), plus the brain that answers
// approved viewer messages (M2). Sources publish `input.*` events into the
// hub; the host approves candidates in the console; the brain asks DeepSeek,
// screens the whole reply and starts a turn the stage then speaks.
export function createLiveRuntime({
  speech,
  env = {},
  config = {},
  root = null, // repository root: enables .data ledgers, blocklist and audit log
  fetchImpl = fetch,
  now = Date.now,
  timers = { setTimeout, clearTimeout, setInterval, clearInterval },
  newId = randomUUID,
  heartbeatMs = 15_000,
  // Own id spaces: event and item ids never shift lease or turn ids.
  hub = createHub({ now }),
  replyBudget = null,
  audit = null,
  rules = null,
  moderationProvider = null,
  sources = [],
  // The go-live checklist's local TTS reachability probe (never DeepSeek).
  probeFetch = fetch,
  preflightFs = undefined,
  // Boot paused ('startup'), so the first go-live is a `resume` and passes
  // the checklist like any other (live mode and mock-live set this).
  startPaused = false,
} = {}) {
  if (!speech?.synthesise)
    throw new TypeError('createLiveRuntime requires a speech handler with synthesise()')

  let control = startPaused ? 'paused' : 'running' // running | paused | panic
  let pauseReason = startPaused ? 'startup' : null
  let mode = 'live' // live | brb
  let turn = null
  let lastOutcome = null
  let lastProblem = null
  let lastHostBlock = null
  let stopped = false
  let activeRules = rules ?? parseRules('')
  let rulesProblem = null
  let rulesLoaded = Boolean(rules) || !root
  // Every control change bumps this, so a resume that waited for the
  // checklist never overrides a pause or panic pressed meanwhile.
  let controlVersion = 0
  let lastPreflightKey = null

  const sse = createSseChannel({ heartbeatMs, timers })
  let activity = 'idle'
  const bus = createStageBus({ sse, newId, now, getMode: () => mode, getActivity: () => activity })
  const queue = createCandidateQueue({ now, newId: randomUUID })
  const dataDirectory = root ? join(root, '.data') : null
  const auditLog = audit ?? (dataDirectory ? createAuditLog({ directory: join(dataDirectory, 'live-logs'), now }) : null)
  const detachAudit = auditLog?.attach(hub)
  const dailyReplies = boundedInteger(env.LIVE_DAILY_REPLY_LIMIT, 250, 1, 5_000)
  const budget = replyBudget ?? (dataDirectory
    // The TTS ledger counts "characters"; here each unit is one model reply.
    ? createTtsBudget({ path: join(dataDirectory, 'live-reply-budget.json'), dailyLimit: dailyReplies, now })
    : createMemoryReplyBudget({ dailyLimit: dailyReplies, now }))

  // Caption text and the spoken sentences, for brain replies and host lines.
  const screen = utterance => screenUtterance(utterance, { rules: activeRules, provider: moderationProvider })
  // The durable daily count, shown in the console. Refreshed after every
  // reservation and on start; display only, never used to decide spending.
  let ledger = null
  const refreshLedger = async () => {
    try { ledger = await budget.peek?.() ?? ledger }
    catch { ledger = null }
  }
  const countedBudget = {
    async reserve(count, signal) {
      try {
        const result = await budget.reserve(count, signal)
        if (result && typeof result.reserved === 'number')
          ledger = result
        return result
      }
      catch (error) {
        if (error instanceof TtsBudgetError && error.code === 'TTS_DAILY_LIMIT')
          await refreshLedger()
        throw error
      }
    },
  }
  const rulesReady = Promise.all([
    rules || !dataDirectory
      ? null
      : loadRules(join(dataDirectory, 'moderation', 'blocklist.txt')).then(({ rules: loaded, problem }) => {
          activeRules = loaded
          rulesProblem = problem
          rulesLoaded = true
        }),
    refreshLedger(),
  ])
  const apiKey = env.DEEPSEEK_API_KEY?.trim() ?? ''
  const brain = createLiveBrain({
    hub,
    queue,
    turns: {
      canSpeak,
      say: startTurn,
      activity(state) {
        activity = state
        bus.publish('activity', { state })
      },
    },
    control: { pause },
    deepseek: {
      configured: Boolean(apiKey),
      open: (messages, signal) => openDeepSeekStream({
        apiKey,
        baseUrl: config.baseUrl ?? 'https://api.deepseek.com',
        model: config.model ?? 'deepseek-flash',
        messages,
        maxTokens: boundedInteger(env.LIVE_MAX_TOKENS, 160, 32, 400),
        temperature: 0.8,
        signal,
        fetchImpl,
      }),
    },
    screen,
    replyBudget: countedBudget,
    now,
    timers,
  })

  // A new primary never inherits an old page's half-spoken turn.
  bus.onPrimaryChange(() => {
    if (turn)
      endTurn(turn.turnId, 'cancelled', { notifyStage: true })
    brain.schedule()
  })

  const detachInputs = hub.subscribe('input', (event) => {
    const kind = INPUT_KINDS[event.type]
    if (kind)
      queue.add({ ...event.data, kind })
  })
  const startedSources = sources.map(createSource => createSource({
    publish: (event, name = 'source') => hub.publish(`input.${event.type}`, event, { source: name }),
  }))
  for (const source of startedSources)
    source.start?.()

  function setControl(next, reason = null) {
    controlVersion++
    control = next
    pauseReason = next === 'running' ? null : reason
    hub.publish('control.changed', { control, reason: pauseReason, mode })
  }

  function pause(reason) {
    brain.abortGeneration()
    if (control === 'running')
      setControl('paused', reason)
  }

  function canSpeak() {
    if (stopped || control !== 'running')
      return { ok: false, reason: 'paused' }
    if (!bus.hasReadyPrimary())
      return { ok: false, reason: 'no-stage' }
    if (turn)
      return { ok: false, reason: 'turn-active' }
    // OBS reports when the source is not on the programme output.
    if (bus.summary().primary?.obs?.active === false)
      return { ok: false, reason: 'obs-inactive' }
    return { ok: true }
  }

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
    hub.publish('turn.ended', {
      turnId, outcome, origin: ended.origin, replyTo: ended.replyTo,
      planned: ended.planned, bought: ended.bought, spoken: [...ended.spoken],
    })
    return true
  }

  // Starts a turn for already-screened text. Returns {ok, turnId} or a
  // stable refusal code; callers decide how to surface it.
  async function startTurn({ text, delivery = 'neutral', cues = [], replyTo = null, origin = 'host' }) {
    const refuse = (status, code) => ({ ok: false, status, code })
    if (control !== 'running')
      return refuse(409, 'LIVE_PAUSED')
    if (!bus.hasReadyPrimary())
      return refuse(409, 'LIVE_NO_STAGE')
    if (turn)
      return refuse(409, 'LIVE_TURN_ACTIVE')
    const sentences = await planUtterance({ text, delivery, cues })
    if (!sentences.length)
      return refuse(400, 'LIVE_EMPTY')
    // Re-check after the await: a concurrent say may have started a turn,
    // the stage may have gone, or the host may have paused meanwhile.
    if (stopped || control !== 'running')
      return refuse(409, 'LIVE_PAUSED')
    if (!bus.hasReadyPrimary())
      return refuse(409, 'LIVE_NO_STAGE')
    if (turn)
      return refuse(409, 'LIVE_TURN_ACTIVE')

    const turnId = newId()
    const watchdogMs = Math.min(90_000, 15_000 + 350 * text.length)
    turn = {
      turnId,
      text,
      delivery,
      origin,
      replyTo,
      startedAt: now(),
      allowance: createSentenceAllowance(sentences),
      planned: sentences.length,
      bought: 0,
      spoken: [],
      watchdog: timers.setTimeout(() => endTurn(turnId, 'timeout', { notifyStage: true }), watchdogMs),
    }
    turn.watchdog.unref?.()
    activity = 'idle'
    hub.publish('turn.started', { turnId, text, delivery, cues, origin, replyTo, sentences: sentences.length })
    bus.publish('say', { turnId, text, delivery, cues, replyTo })
    // Publishing can drop a stalled primary, which cancels this very turn
    // (its lease handover runs one microtask later). Never report success
    // for it, and leave every page's last word "stop".
    await null
    if (turn?.turnId !== turnId) {
      bus.publish('stop', { turnId })
      return refuse(409, 'LIVE_NO_STAGE')
    }
    return { ok: true, turnId, sentences: sentences.length }
  }

  function hostText(value) {
    const text = typeof value === 'string' ? value.replace(HOST_CONTROL, '').trim() : ''
    return text && text.length <= MAX_SAY_CHARS && text.isWellFormed() && !text.includes('[[') && !text.includes(']]')
      ? text : null
  }

  // null: the ledger could not be read (shown as unknown).
  function repliesReservedToday() {
    return ledger && ledger.day === new Date(now()).toISOString().slice(0, 10) ? ledger.reserved : ledger ? 0 : null
  }

  async function preflight() {
    await refreshLedger()
    return runPreflight({
      env,
      deepseek: { configured: Boolean(apiKey), model: config.model ?? 'deepseek-flash' },
      speech: speech.health(),
      dataDirectory,
      replies: { limit: dailyReplies, reserved: repliesReservedToday() },
      moderation: {
        loaded: rulesLoaded,
        problem: rulesProblem,
        terms: countRuleTerms(activeRules),
        ignored: activeRules.ignored?.length ?? 0,
      },
      stage: bus.summary().primary,
      stageUrl: `http://127.0.0.1:${config.port ?? 5173}/airi/stage.html?role=obs`,
      probe: probeFetch,
      ...(preflightFs ? { fs: preflightFs } : {}),
      now,
    })
  }

  // The audit log records every resume attempt, and a console check only
  // when its outcome changed (the console re-checks every few seconds).
  function recordPreflight(result, { trigger, skipped = false }) {
    const key = JSON.stringify([result.profile, result.checks.map(check => [check.id, check.ok])])
    if (trigger === 'check' && key === lastPreflightKey)
      return
    lastPreflightKey = key
    hub.publish('preflight.checked', {
      trigger,
      profile: result.profile,
      ok: result.ok,
      skipped,
      failed: result.checks.filter(check => !check.ok).map(check => check.id),
      checks: result.checks.map(({ id, ok, detail }) => ({ id, ok, detail })),
    })
  }

  async function handleControl(request, response) {
    const body = await readSmallJson(request)
    switch (body.action) {
      case 'say': {
        const text = hostText(body.text)
        if (!text)
          return sendJson(response, 400, { code: 'LIVE_INVALID_TEXT' })
        const delivery = body.delivery ?? 'neutral'
        if (!DELIVERIES.has(delivery))
          return sendJson(response, 400, { code: 'LIVE_INVALID_DELIVERY' })
        // The host's own words pass the same output gate (without a strike).
        const verdict = await screen({ text, delivery })
        if (!verdict.ok && verdict.reason === 'empty')
          return sendJson(response, 400, { code: 'LIVE_EMPTY' })
        if (!verdict.ok) {
          lastHostBlock = { reason: verdict.reason, term: verdict.term ?? null, at: now() }
          hub.publish('control.say-blocked', { text, ...lastHostBlock })
          return sendJson(response, 400, { code: 'LIVE_BLOCKED', reason: verdict.reason })
        }
        const result = await startTurn({ text, delivery, origin: 'host' })
        return result.ok
          ? sendJson(response, 200, { turnId: result.turnId, sentences: result.sentences })
          : sendJson(response, result.status, { code: result.code })
      }
      case 'inject': {
        const text = hostText(body.text)
        if (!text)
          return sendJson(response, 400, { code: 'LIVE_INVALID_TEXT' })
        const event = hub.publish('input.host', { type: 'host', msgId: null, user: null, text }, { source: 'console' })
        return sendJson(response, 200, { eventId: event.id })
      }
      case 'approve':
      case 'reject': {
        const done = typeof body.itemId === 'string'
          && (body.action === 'approve' ? queue.approve(body.itemId) : queue.reject(body.itemId))
        if (!done)
          return sendJson(response, 404, { code: 'LIVE_ITEM_NOT_FOUND' })
        hub.publish(`queue.${body.action}d`, { itemId: body.itemId })
        return sendJson(response, 200, state())
      }
      case 'stop':
        brain.abortGeneration()
        if (turn)
          endTurn(turn.turnId, 'stopped', { notifyStage: true })
        return sendJson(response, 200, state())
      case 'pause':
        pause('host')
        return sendJson(response, 200, state())
      case 'resume': {
        // Resuming starts a public broadcast: the checklist must pass, or
        // the host must say explicitly that they are skipping it.
        const skip = body.skipPreflight === true
        const version = controlVersion
        const result = await preflight()
        if (stopped)
          return sendJson(response, 409, { code: 'LIVE_PAUSED' })
        recordPreflight(result, { trigger: 'resume', skipped: skip && !result.ok })
        if (!result.ok && !skip)
          return sendJson(response, 409, { code: 'LIVE_PREFLIGHT_FAILED', preflight: result })
        if (controlVersion !== version)
          return sendJson(response, 409, { code: 'LIVE_CONTROL_CHANGED' })
        setControl('running')
        setMode('live')
        brain.resetStrikes()
        brain.schedule()
        return sendJson(response, 200, state())
      }
      case 'panic':
        // Everything stops and nothing from before resumes: the interrupted
        // reply leaves the context and waiting candidates are dropped.
        brain.abortGeneration()
        if (turn)
          endTurn(turn.turnId, 'stopped', { notifyStage: true })
        brain.forgetContext()
        queue.clearOpen('panic')
        setControl('panic', 'panic')
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
        brain.schedule()
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
          ? body.message.replace(HOST_CONTROL, '').trim().slice(0, MAX_PROBLEM_CHARS) : ''
        if (!message)
          return sendJson(response, 400, { code: 'LIVE_INVALID_REPORT' })
        bus.updatePrimaryStatus(body.leaseId, {})
        lastProblem = { message, at: now() }
        hub.publish('stage.problem', { message })
        break
      }
      case 'obs': {
        const flag = value => (typeof value === 'boolean' ? value : null)
        bus.updatePrimaryStatus(body.leaseId, {
          obs: { active: flag(body.active), visible: flag(body.visible), streaming: flag(body.streaming) },
        })
        brain.schedule()
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
    const owner = turn
    owner.bought++

    const cancelled = new AbortController()
    const abort = () => cancelled.abort()
    response.once('close', abort)
    try {
      const result = await speech.synthesise({ text: body.text, delivery: body.delivery }, { signal: cancelled.signal })
      // Only audio that was actually produced enters the brain's history.
      owner.spoken.push(body.text)
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
      pauseReason,
      mode,
      stage: bus.summary(),
      turn: turn ? {
        turnId: turn.turnId, text: turn.text, delivery: turn.delivery, origin: turn.origin,
        startedAgoMs: now() - turn.startedAt, sentencesPlanned: turn.planned, sentencesBought: turn.bought,
      } : null,
      lastOutcome,
      lastProblem,
      lastHostBlock,
      queue: queue.snapshot(),
      brain: {
        ...brain.state(),
        dailyReplyLimit: dailyReplies,
        // null: the ledger could not be read (shown as unknown).
        dailyRepliesReserved: repliesReservedToday(),
      },
      moderation: {
        rulesProblem,
        ignoredTerms: activeRules.ignored ?? [],
        provider: Boolean(moderationProvider),
      },
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
      if (request.method === 'GET' && pathname === '/api/live/preflight') {
        const result = await preflight()
        recordPreflight(result, { trigger: 'check' })
        sendJson(response, 200, result)
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
    hub,
    // Resolves once the host's blocklist has been read (tests and startup).
    ready: rulesReady,
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
      for (const source of startedSources)
        source.stop?.()
      brain.stop()
      if (turn)
        endTurn(turn.turnId, 'stopped', { notifyStage: true })
      detachInputs()
      bus.closeAll()
      await auditLog?.flush()
      detachAudit?.()
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
