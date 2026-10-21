import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { isAct, normaliseActCues, normaliseEmotion, STAGE_PROTOCOL } from '../../shared/performance-cues.mjs'
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
import { createClipAllowance, planClips, screenUtterance } from './utterance.mjs'

const OUTCOMES = new Set(['played', 'partial', 'failed', 'cancelled', 'empty'])
const AVATAR_STATES = new Set(['loading', 'ready', 'failed'])
const INPUT_KINDS = { 'input.danmaku': 'danmaku', 'input.superchat': 'superchat', 'input.host': 'host' }
const MAX_SAY_CHARS = 200
const MAX_PROBLEM_CHARS = 120
const OUTDATED_RELOAD_INTERVAL_MS = 30_000
// When the voice provider refuses a clip for its per-minute request limit
// (MiniMax 1002, TTS_UPSTREAM_RATE_LIMITED), the stage route waits this long
// once and asks once more, instead of pacing requests ahead of time. Pacing
// needs the account's real limit: api.minimax.cn documents 10 RPM (free) or
// 20 (paid), and this account refused after about 14 requests in 25 s, so
// MiniMax does not count a plain 60 s window; a wrong local guess would
// either drop replies MiniMax would have voiced or change nothing. The
// refusal is MiniMax's own signal, and the 2026-10-21 check saw 2 of the next
// 8 requests pass and all 5 refused ones pass when rerun 6 s apart. 4 s is
// over one 20 RPM interval (3 s). Bounded: one wait and at most one more
// request per clip, which reserves again in .data/tts-budget.json (a refusal
// returns no audio but the local ledger never refunds). Meanwhile /api/speech
// keeps visitors off the account (UPSTREAM_BACKOFF_MS in server/speech.mjs).
// Every other failure is final, as before.
const RATE_LIMIT_RETRY_MS = 4_000
const RATE_LIMIT_NOTES = {
  waiting: `每分钟请求数到上限，${RATE_LIMIT_RETRY_MS / 1_000} 秒后重试这一段。`,
  recovered: '每分钟请求数到上限，重试后已出声。',
  lost: '每分钟请求数到上限，这一段没有声音。',
}
const isRateLimited = error => error instanceof SpeechProviderError && error.code === 'TTS_UPSTREAM_RATE_LIMITED'

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
  // The voice provider's rate limit, apart from the stage's own report of
  // the same clip ("云端语音失败…"), which would otherwise overwrite it.
  let lastSpeechProblem = null
  let rateLimitedClips = 0
  let lastOutdatedReload = -Infinity
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
  // Same-tone sentences are bought as one clip unless switched off; each say
  // tells the stage which way this server planned.
  const joinSentences = env.LIVE_JOIN_SENTENCES !== '0'
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
    lastOutcome = { turnId, outcome, at: now(), sentencesBought: ended.bought, sentencesPlanned: ended.planned,
      clipsBought: ended.clipsBought, clipsPlanned: ended.clipsPlanned }
    if (notifyStage)
      bus.publish('stop', { turnId })
    hub.publish('turn.ended', {
      turnId, outcome, origin: ended.origin, replyTo: ended.replyTo,
      planned: ended.planned, bought: ended.bought, spoken: [...ended.spoken],
      clipsPlanned: ended.clipsPlanned, clipsBought: ended.clipsBought,
    })
    return true
  }

  // Starts a turn for already-screened text. Returns {ok, turnId} or a
  // stable refusal code; callers decide how to surface it. `acts` travel
  // apart from the tone cues, to the stage and into the sentence plan.
  async function startTurn({ text, delivery = 'neutral', cues = [], acts = [], replyTo = null, origin = 'host' }) {
    const refuse = (status, code) => ({ ok: false, status, code })
    if (control !== 'running')
      return refuse(409, 'LIVE_PAUSED')
    if (!bus.hasReadyPrimary())
      return refuse(409, 'LIVE_NO_STAGE')
    if (turn)
      return refuse(409, 'LIVE_TURN_ACTIVE')
    // What the planner keeps anyway (at most one, inside the text), so the
    // stage is sent the very list the allowance was planned from.
    acts = normaliseActCues(acts, text.length)
    const clips = await planClips({ text, delivery, cues, acts }, { join: joinSentences })
    if (!clips.length)
      return refuse(400, 'LIVE_EMPTY')
    const planned = clips.reduce((count, clip) => count + clip.parts.length, 0)
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
      acts,
      origin,
      replyTo,
      startedAt: now(),
      allowance: createClipAllowance(clips),
      // planned/bought/spoken count sentences (the brain's history is by
      // sentence); clips count the requests the stage buys them in.
      planned,
      bought: 0,
      spoken: [],
      clipsPlanned: clips.length,
      clipsBought: 0,
      watchdog: timers.setTimeout(() => endTurn(turnId, 'timeout', { notifyStage: true }), watchdogMs),
    }
    turn.watchdog.unref?.()
    activity = 'idle'
    hub.publish('turn.started', { turnId, text, delivery, cues, acts, origin, replyTo, sentences: planned, clips: clips.length })
    bus.publish('say', { turnId, text, delivery, cues, acts, replyTo, join: joinSentences })
    // Publishing can drop a stalled primary, which cancels this very turn
    // (its lease handover runs one microtask later). Never report success
    // for it, and leave every page's last word "stop".
    await null
    if (turn?.turnId !== turnId) {
      bus.publish('stop', { turnId })
      return refuse(409, 'LIVE_NO_STAGE')
    }
    return { ok: true, turnId, sentences: planned }
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
        // Canonical, so a console still sending the old 'bright' says happy.
        // The host's lines carry no acts (and hostText refuses "[[").
        const delivery = normaliseEmotion(body.delivery ?? 'neutral')
        if (!delivery)
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
        // A page from before the current say payload would drop new tones or
        // buy sentences the server never planned: it reloads instead (at
        // most every 30 s, so a page that cannot update does not loop).
        if (body.protocol !== STAGE_PROTOCOL) {
          if (now() - lastOutdatedReload >= OUTDATED_RELOAD_INTERVAL_MS) {
            lastOutdatedReload = now()
            bus.publish('reload', {})
          }
          lastProblem = { message: '舞台页面版本过旧，已请它刷新。', at: now() }
          hub.publish('stage.outdated', { protocol: Number.isInteger(body.protocol) ? body.protocol : null }, { source: 'stage' })
          return sendJson(response, 409, { code: 'LIVE_STAGE_OUTDATED' })
        }
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
  // clips exist, each is bought at most once, and only by the primary.
  // The stage names an act, never its sound: each provider's own syntax,
  // and the pause length, are the server's and the player's.
  async function handleStageSpeech(request, response) {
    const body = await readSmallJson(request, 4_096)
    if (!bus.isPrimary(body.leaseId))
      return sendJson(response, 403, { code: 'LIVE_NOT_PRIMARY' })
    if (!turn || body.turnId !== turn.turnId)
      return sendJson(response, 409, { code: 'LIVE_TURN_MISMATCH' })
    const text = body.text
    const delivery = normaliseEmotion(body.delivery)
    const act = body.act ?? null
    const parts = typeof text === 'string' && delivery && (act === null || isAct(act))
      ? turn.allowance.take({ text, delivery, act }) : null
    if (!parts)
      return sendJson(response, 409, { code: 'LIVE_SENTENCE_NOT_ALLOWED' })
    const owner = turn
    owner.bought += parts.length
    owner.clipsBought++

    const cancelled = new AbortController()
    const abort = () => cancelled.abort()
    response.once('close', abort)
    const clip = { text, delivery, ...(act ? { act } : {}) }
    let limited = false
    try {
      let result
      try {
        result = await speech.synthesise(clip, { signal: cancelled.signal })
      }
      catch (error) {
        if (!isRateLimited(error) || cancelled.signal.aborted)
          throw error
        limited = true
        noteRateLimit('waiting')
        await wait(RATE_LIMIT_RETRY_MS, cancelled.signal)
        // The host may have stopped or skipped the turn meanwhile.
        if (turn !== owner) {
          noteRateLimit('lost')
          return sendJson(response, 409, { code: 'LIVE_TURN_MISMATCH' })
        }
        result = await speech.synthesise(clip, { signal: cancelled.signal })
      }
      if (limited)
        noteRateLimit('recovered')
      // Only audio that was actually produced enters the brain's history.
      owner.spoken.push(...parts)
      if (!response.destroyed && !response.writableEnded)
        sendJson(response, 200, result)
    }
    catch (error) {
      if (limited)
        noteRateLimit('lost')
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

  function wait(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted)
        return reject(signal.reason)
      const stop = () => {
        timers.clearTimeout(handle)
        reject(signal.reason)
      }
      const handle = timers.setTimeout(() => {
        signal.removeEventListener('abort', stop)
        resolve()
      }, ms)
      handle?.unref?.()
      signal.addEventListener('abort', stop, { once: true })
    })
  }

  // Shown to the host only; the stage and visitors get the stable code.
  function noteRateLimit(step) {
    if (step === 'waiting')
      rateLimitedClips++
    const provider = speech.health().provider === 'minimax' ? 'MiniMax ' : '语音服务'
    lastSpeechProblem = { code: 'TTS_UPSTREAM_RATE_LIMITED', message: provider + RATE_LIMIT_NOTES[step],
      at: now(), clips: rateLimitedClips }
    hub.publish('speech.rate_limited', { step, clips: rateLimitedClips })
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
        clipsPlanned: turn.clipsPlanned, clipsBought: turn.clipsBought,
      } : null,
      lastOutcome,
      lastProblem,
      lastSpeechProblem: lastSpeechProblem && { ...lastSpeechProblem, agoMs: now() - lastSpeechProblem.at },
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
