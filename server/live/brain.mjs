import { TtsBudgetError } from '../tts-budget.mjs'
import { buildLiveSystemPrompt, formatViewerBatch, GUIDE_MARKERS, leaksPrompt, needsTimeOfDay, partOfDay, promptLeakCorpus, replyGuide, replyLengthBudget, speakName, topicHints } from './live-prompt.mjs'
import { openerOf, repeatedPhrases, shapeReply } from './style.mjs'
import { REPLY_CONTROL } from './text.mjs'

// Decides what the character says. One turn at a time: take approved
// candidates, ask the model (a second time only if shaping left nothing),
// fit the reply to the turn's length, screen the whole of it, then hand it to the
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
  openerWindow = 8,
  openerRepeats = 3,
  phraseWindow = 16,
  timeZone = 'Asia/Shanghai', // the stream's, for the time-of-day hint
  promptCorpus = promptLeakCorpus(),
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
  const openings = [] // opening words of the most recent replies said
  const openingShapes = [] // and whether each opened with a name or an echo
  const recentReplies = [] // their text, for the repeated-phrase hint
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

  // Opening words used at least `openerRepeats` times in the last replies:
  // the next turn's guide asks for a different start.
  function repeatedOpeners() {
    const counts = new Map()
    for (const opener of openings)
      counts.set(opener, (counts.get(opener) ?? 0) + 1)
    return [...counts].filter(([opener, count]) => opener && count >= openerRepeats).map(([opener]) => opener)
  }

  // Opening shapes no single word gives away: the viewer's nickname first
  // (a different name each time), or an echoed keyword with "啊……".
  function openingShape(text, batch) {
    const start = text.replace(/^[\s\p{P}\p{S}]+/u, '')
    const names = batch.map(item => item.user?.name).filter(Boolean).flatMap(name => [name, speakName(name)])
    return {
      // A one-character name counts only when a comma follows ("甲，…").
      name: names.some(name => start.startsWith(name) && (name.length >= 2 || /^[，,！!、]/u.test(start.slice(name.length)))),
      echo: /^[\p{L}\p{N}]{1,6}啊(?:……|…|，)/u.test(start),
    }
  }

  function repeatedHabits() {
    return ['name', 'echo'].filter(shape => openingShapes.filter(item => item[shape]).length >= openerRepeats)
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
    const lengthBudget = replyLengthBudget(batch)
    const openers = repeatedOpeners()
    const habits = repeatedHabits()
    // What these viewers wrote may be echoed back; it is never a habit.
    const phrases = repeatedPhrases(recentReplies, { exclude: batch.map(item => `${item.text ?? ''} ${item.user?.name ?? ''}`).join(' ') })
    const timeOfDay = needsTimeOfDay(batch) ? partOfDay(new Date(now()), timeZone) : ''
    // A rule the reply must follow, stated for this turn (not an example line).
    const topics = topicHints(batch)
    hub.publish('brain.generating', { itemIds: ids, prompt: batchText }, { source: 'brain' })

    let text = ''
    let kept = []
    let result
    const drop = (reason, extra = {}) => {
      hub.publish('brain.dropped', { itemIds: ids, reason, text, ...extra }, { source: 'brain' })
      queue.complete(ids, 'failed', reason)
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
    const block = (verdict) => {
      lastBlock = { reason: verdict.reason, category: verdict.category ?? null, term: verdict.term ?? null, at: now() }
      queue.complete(ids, 'blocked', verdict.reason)
      hub.publish('brain.blocked', { itemIds: ids, text, ...lastBlock }, { source: 'brain' })
      strike(verdict.reason)
      return finish()
    }
    // A second call only when shaping dropped every sentence as a chatbot
    // tell: it is billed and reserves its own reply, so it is made only if
    // the stage can still speak.
    for (let attempt = 0; ; attempt++) {
      if (attempt > 0) {
        if (abort.signal.aborted)
          return drop('stopped')
        const gate = turns.canSpeak()
        if (!gate.ok)
          return gate.reason === 'paused' ? drop('not-speakable', { gate: gate.reason }) : release(gate.reason)
      }
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

      text = ''
      const cues = []
      const guide = replyGuide(lengthBudget, { timeOfDay, topics, openers, habits, phrases, retry: attempt > 0 })
      try {
        const stream = await deepseek.open(messagesFor(`${batchText}\n${guide}`), abort.signal)
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

      if (abort.signal.aborted)
        return drop('stopped')
      text = text.trimEnd()
      // The reply as the model wrote it, a max_tokens tail included, is
      // screened first: what the cut or shaping would remove still counts (a
      // strike, the audit log), and the host's blocklist sees emoji before
      // they go. Its length (up to three times the spoken limit) and TTS
      // asides are not held against it, since shaping deals with both, and
      // only local rules run. Copying out the instructions, or this turn's
      // guide wording, is a leak however short the copy; saying what the
      // guide asked for ("找身边信得过的人") is not.
      if (text.trim()) {
        if (leaksPrompt(text, promptCorpus) || GUIDE_MARKERS.test(text))
          return block({ reason: 'prompt-leak' })
        const wholeCues = cues.filter(cue => cue.start < text.length)
        const whole = await screen({ text, delivery: wholeCues[0]?.start === 0 ? wholeCues[0].delivery : 'neutral', cues: wholeCues, firstPass: true })
        // Nothing speakable (only a code block) is not harmful: no strike;
        // the final screen drops it.
        if (!whole.ok && whole.reason !== 'empty')
          return block(whole)
        if (abort.signal.aborted)
          return drop('stopped')
      }
      if (result.truncated)
        text = cutToLastSentence(text).trimEnd()
      // Nothing usable (only a tone cue, or no complete sentence before the
      // cut) is a failed generation, not harmful output: no strike.
      if (!text.trim()) {
        queue.complete(ids, 'failed', result.truncated ? 'truncated' : 'empty-reply')
        hub.publish('brain.error', { itemIds: ids, message: 'empty reply' }, { source: 'brain' })
        return finish()
      }
      // Fit the turn's length and drop chatbot phrasing, so a long but
      // harmless reply is shortened rather than counted a strike.
      const shaped = shapeReply(text, cues.filter(cue => cue.start < text.length), lengthBudget)
      hub.publish('brain.style', { itemIds: ids, attempt, ...shaped.report }, { source: 'brain' })
      // Ask again only when chatbot phrasing took the answer and left at
      // most a reaction ("诶？").
      if (!shaped.report.answered && shaped.report.droppedByStyle && attempt === 0)
        continue
      if (!shaped.report.speakable) {
        // Emoji or markup only is an empty reply, not chatbot phrasing.
        const reason = shaped.report.droppedByStyle ? 'style-empty' : 'empty-reply'
        queue.complete(ids, 'failed', reason)
        hub.publish('brain.error', { itemIds: ids, message: reason === 'style-empty' ? 'only chatbot phrasing' : 'empty reply' }, { source: 'brain' })
        return finish()
      }
      text = shaped.text
      kept = shaped.cues
      break
    }
    const delivery = kept[0]?.start === 0 ? kept[0].delivery : 'neutral'

    // And again as it will be spoken and captioned.
    const verdict = await screen({ text, delivery, cues: kept })
    if (!verdict.ok && verdict.reason === 'empty')
      return drop('empty-reply')
    if (!verdict.ok)
      return block(verdict)
    if (abort.signal.aborted)
      return drop('stopped')
    const gate = turns.canSpeak()
    if (!gate.ok)
      return gate.reason === 'paused' ? drop('not-speakable', { gate: gate.reason }) : release(gate.reason)

    const said = await turns.say({ text, delivery, cues: kept, replyTo: ids, origin: 'brain' })
    if (!said.ok)
      return ['LIVE_TURN_ACTIVE', 'LIVE_NO_STAGE'].includes(said.code) ? release(said.code) : drop(said.code ?? 'say-refused')
    hub.publish('brain.reply', { itemIds: ids, turnId: said.turnId, text, usage: result.usage ?? null }, { source: 'brain' })
    openings.push(openerOf(text))
    openingShapes.push(openingShape(text, batch))
    recentReplies.push(text)
    for (const [list, size] of [[openings, openerWindow], [openingShapes, openerWindow], [recentReplies, phraseWindow]]) {
      if (list.length > size)
        list.splice(0, list.length - size)
    }
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
      openings.length = 0
      openingShapes.length = 0
      recentReplies.length = 0
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
