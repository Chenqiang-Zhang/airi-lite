import { TtsBudgetError } from '../tts-budget.mjs'
import { buildLiveSystemPrompt, formatViewerBatch } from './live-prompt.mjs'
import { REPLY_CONTROL } from './text.mjs'

// Decides what the character says. One turn at a time: take approved
// candidates, ask the model once, screen the whole reply, then hand it to the
// stage and wait until the stage has finished before the next turn. Nothing
// is generated without a ready primary stage, while paused, or past the
// daily reply budget; nothing unscreened is ever spoken or captioned.
const SENTENCE_END = /[。！？!?…](?=[^。！？!?…]*$)/u

// A max_tokens cut leaves a dangling clause; keep only complete sentences.
export function cutToLastSentence(text) {
  const match = SENTENCE_END.exec(text)
  return match ? text.slice(0, match.index + 1) : ''
}

export function createLiveBrain({
  hub,
  queue,
  turns, // { canSpeak(): {ok, reason}, say(request): Promise<{ok, turnId?, code?}>, activity(state) }
  control, // { pause(reason) }
  deepseek, // { configured: boolean, open(messages, signal): Promise<{relay}> }
  // async ({text, delivery, cues}) => {ok, reason, ...}: screens both the
  // caption text and the sentences the stage will actually speak.
  screen,
  replyBudget, // { reserve(count, signal) }
  systemPrompt = buildLiveSystemPrompt(),
  now = Date.now,
  timers = { setTimeout, clearTimeout },
  historyRounds = 6,
  batchSize = 3,
  cooldownMs = 1_500,
  strikeLimit = 3,
  strikeWindowMs = 10 * 60_000,
  errorLimit = 3,
}) {
  let phase = 'idle' // idle | generating | speaking | cooldown
  let stopped = false
  let scheduled = false
  let generation = null // { abort: AbortController, batch }
  let speaking = null // { turnId, user, delivery, itemIds }
  let cooldown = null
  let strikes = []
  let consecutiveErrors = 0
  const history = []
  // This process only: `calls` completed, `failedCalls` errored or aborted
  // after the budget was reserved. The daily ledger is the durable count.
  const usage = { calls: 0, failedCalls: 0, promptTokens: 0, completionTokens: 0, cacheHitTokens: 0 }
  let lastBlock = null
  let lastError = null

  const unsubscribeTurns = hub.subscribe('turn.ended', event => onTurnEnded(event.data))
  const unsubscribeQueue = queue.onChange((_item, change) => {
    if (change === 'approved' || change === 'added')
      schedule()
  })

  function schedule() {
    if (scheduled || stopped)
      return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      void tick()
    })
  }

  function strike(reason) {
    const time = now()
    strikes = strikes.filter(at => time - at < strikeWindowMs)
    strikes.push(time)
    if (strikes.length >= strikeLimit) {
      strikes = []
      control.pause('strikes')
      hub.publish('brain.paused', { reason: 'strikes', after: reason }, { source: 'brain' })
    }
  }

  function messagesFor(batchText) {
    const messages = [{ role: 'system', content: systemPrompt }]
    for (const round of history.slice(-historyRounds)) {
      messages.push({ role: 'user', content: round.user })
      // Keep the tone cue on our own lines so the model keeps emitting it.
      messages.push({ role: 'assistant', content: `[[tone:${round.delivery}]]${round.assistant}` })
    }
    messages.push({ role: 'user', content: batchText })
    return messages
  }

  function finish(nextPhase = 'idle') {
    generation = null
    phase = nextPhase
    turns.activity('idle')
    if (nextPhase === 'idle')
      schedule()
  }

  async function tick() {
    if (stopped || phase !== 'idle' || !deepseek.configured)
      return
    if (!turns.canSpeak().ok || !queue.hasApproved())
      return

    const batch = queue.take(batchSize)
    if (!batch.length)
      return
    const ids = batch.map(item => item.id)
    const abort = new AbortController()
    generation = { abort, batch }
    phase = 'generating'
    turns.activity('thinking')
    const batchText = formatViewerBatch(batch)
    hub.publish('brain.generating', { itemIds: ids, prompt: batchText }, { source: 'brain' })

    try {
      await replyBudget.reserve(1, abort.signal)
    }
    catch (error) {
      queue.complete(ids, 'failed', abort.signal.aborted ? 'stopped' : 'reply-budget')
      if (!abort.signal.aborted && error instanceof TtsBudgetError && error.code !== 'TTS_CANCELLED') {
        const reason = error.code === 'TTS_DAILY_LIMIT' ? 'reply-budget' : 'reply-budget-unavailable'
        control.pause(reason)
        hub.publish('brain.paused', { reason }, { source: 'brain' })
      }
      return finish()
    }

    let text = ''
    const cues = []
    let result
    try {
      const stream = await deepseek.open(messagesFor(batchText), abort.signal)
      result = await stream.relay((event) => {
        if (event.type === 'delivery')
          cues.push({ start: text.length, delivery: event.value })
        // Stripped per delta, so cue offsets, the gate, captions and speech
        // all see the same text (no bidi tricks in captions).
        else if (event.type === 'delta')
          text += event.content.replace(REPLY_CONTROL, '')
      })
    }
    catch (error) {
      usage.failedCalls++
      if (abort.signal.aborted) {
        // The request may already be billed; its usage is unknown.
        hub.publish('brain.aborted', { itemIds: ids, usage: null }, { source: 'brain' })
        queue.complete(ids, 'failed', 'stopped')
        return finish()
      }
      consecutiveErrors++
      lastError = { message: String(error?.message ?? error).slice(0, 200), at: now() }
      queue.complete(ids, 'failed', 'upstream')
      hub.publish('brain.error', { itemIds: ids, message: lastError.message }, { source: 'brain' })
      if (consecutiveErrors >= errorLimit) {
        consecutiveErrors = 0
        control.pause('upstream-errors')
        hub.publish('brain.paused', { reason: 'upstream-errors' }, { source: 'brain' })
      }
      return finish()
    }
    consecutiveErrors = 0
    usage.calls++
    usage.promptTokens += Number(result.usage?.prompt_tokens) || 0
    usage.completionTokens += Number(result.usage?.completion_tokens) || 0
    usage.cacheHitTokens += Number(result.usage?.prompt_cache_hit_tokens) || 0
    // Exactly one usage record per completed (billed) call, whatever happens
    // to the reply next: summing these in the audit log gives the real cost.
    hub.publish('brain.usage', { itemIds: ids, usage: result.usage ?? null, truncated: Boolean(result.truncated) }, { source: 'brain' })

    const drop = (reason, extra = {}) => {
      hub.publish('brain.dropped', { itemIds: ids, reason, text, ...extra }, { source: 'brain' })
      queue.complete(ids, 'failed', reason)
      return finish()
    }
    if (abort.signal.aborted)
      return drop('stopped')
    if (result.truncated)
      text = cutToLastSentence(text)
    text = text.trimEnd()
    // Nothing usable (only a tone cue, or no complete sentence before the
    // cut) is a failed generation, not harmful output: no strike.
    if (!text.trim()) {
      queue.complete(ids, 'failed', result.truncated ? 'truncated' : 'empty-reply')
      hub.publish('brain.error', { itemIds: ids, message: 'empty reply' }, { source: 'brain' })
      return finish()
    }
    const kept = cues.filter(cue => cue.start < text.length)
    const delivery = kept[0]?.start === 0 ? kept[0].delivery : 'neutral'

    const verdict = await screen({ text, delivery, cues: kept })
    // Nothing speakable (e.g. only a code block) is not harmful: no strike.
    if (!verdict.ok && verdict.reason === 'empty')
      return drop('empty-reply')
    if (!verdict.ok) {
      lastBlock = { reason: verdict.reason, category: verdict.category ?? null, term: verdict.term ?? null, at: now() }
      queue.complete(ids, 'blocked', verdict.reason)
      hub.publish('brain.blocked', { itemIds: ids, text, ...lastBlock }, { source: 'brain' })
      strike(verdict.reason)
      return finish()
    }
    // The stage is briefly unavailable (a host line on stage, the OBS page
    // reloading, the source switched off the programme): give the items back,
    // approved, to be answered when it can speak again (one more model call)
    // instead of losing them. Pause and stop abort and are handled above.
    const release = (reason) => {
      hub.publish('brain.dropped', { itemIds: ids, reason, text, released: true }, { source: 'brain' })
      queue.release(ids)
      return finish()
    }
    if (abort.signal.aborted)
      return drop('stopped')
    const gate = turns.canSpeak()
    if (!gate.ok)
      return gate.reason === 'paused' ? drop('not-speakable', { gate: gate.reason }) : release(gate.reason)

    const said = await turns.say({ text, delivery, cues: kept, replyTo: ids, origin: 'brain' })
    if (!said.ok)
      return ['LIVE_TURN_ACTIVE', 'LIVE_NO_STAGE'].includes(said.code) ? release(said.code) : drop(said.code ?? 'say-refused')
    hub.publish('brain.reply', { itemIds: ids, turnId: said.turnId, text, usage: result.usage ?? null }, { source: 'brain' })
    // Items stay 'answering' until the stage reports what was actually heard.
    speaking = { turnId: said.turnId, user: batchText, delivery, itemIds: ids }
    generation = null
    phase = 'speaking'
    // The stage owns 'thinking' from here: captions and speech take over.
  }

  function onTurnEnded({ turnId, outcome, spoken }) {
    // Any other turn (the host's own line) ending frees the stage too.
    if (!speaking || speaking.turnId !== turnId) {
      schedule()
      return
    }
    const heard = Array.isArray(spoken) && spoken.length > 0
    queue.complete(speaking.itemIds, heard ? 'answered' : 'failed', heard
      ? (outcome === 'played' ? undefined : outcome)
      : `unspoken:${outcome}`)
    // Only sentences that were actually synthesised enter the context.
    if (heard) {
      history.push({ user: speaking.user, assistant: spoken.join(''), delivery: speaking.delivery })
      if (history.length > historyRounds)
        history.splice(0, history.length - historyRounds)
    }
    speaking = null
    phase = 'cooldown'
    cooldown = timers.setTimeout(() => {
      cooldown = null
      if (stopped) return
      phase = 'idle'
      schedule()
    }, cooldownMs)
    cooldown?.unref?.()
  }

  return {
    schedule,
    // stop / pause / panic: abort an in-flight generation; nothing it
    // produced is spoken. A turn already on stage is ended by the runtime.
    abortGeneration() {
      generation?.abort.abort()
    },
    resetStrikes() {
      strikes = []
      consecutiveErrors = 0
    },
    // Panic: nothing said before it should steer what is said after it.
    forgetContext() {
      history.length = 0
    },
    state() {
      return {
        configured: deepseek.configured,
        phase,
        strikes: strikes.filter(at => now() - at < strikeWindowMs).length,
        strikeLimit,
        historyRounds: history.length,
        usage: { ...usage },
        lastBlock,
        lastError,
      }
    },
    stop() {
      stopped = true
      generation?.abort.abort()
      if (cooldown) timers.clearTimeout(cooldown)
      unsubscribeTurns()
      unsubscribeQueue()
    },
  }
}
