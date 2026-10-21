// How the live prompt and reply shaping sound on a fixed set of danmaku,
// without a stage or TTS, then measured for length, chatbot phrasing, copied
// example lines, repeated phrases and per-case rules.
//
//   node scripts/live-style-eval.mjs [--real] [--samples=N] [--session] [--time=晚上]
//                                    [--out=DIR] [--cases=FILE] [--only=id,id] [--limit=N]
//   node scripts/live-style-eval.mjs --from=DIR/results.jsonl   (re-measure a saved run, no calls)
//
// Both modes drive the real live brain (prompt, per-turn guide, both gate
// passes, shaping, retry), so the eval cannot drift from what goes on air.
// Independent mode (default) gives every case a fresh brain with no history;
// --samples=N answers each case N times. --session runs one brain over the
// cases in order as one stream, with its history and repeated-opener/phrase
// hints, which is the only way to see her repeat herself. The gate here has
// the built-in rules only (no host blocklist), and a strike pause does not
// stop the run.
//
// Offline by default: the canned fake model checks the pipeline, not the
// wording, and costs nothing. --real calls DeepSeek with the live settings
// (DEEPSEEK_API_KEY from .env.local via `node --env-file-if-exists=.env.local`)
// and is billed per call. --out writes report.md and results.jsonl there; for
// --real the default is a new docs/reviews/<date>-live-style[-N] directory.
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { readServerConfig } from '../server/app.mjs'
import { openDeepSeekStream } from '../server/deepseek.mjs'
import { createLiveBrain } from '../server/live/brain.mjs'
import { createFakeDeepSeek } from '../server/live/fake-deepseek.mjs'
import { createHub } from '../server/live/hub.mjs'
import { buildLiveSystemPrompt, formatViewerBatch, LIVE_PERSONA_OVERRIDES, replyLengthBudget } from '../server/live/live-prompt.mjs'
import { createCandidateQueue } from '../server/live/queue.mjs'
import { COMMON_PAIRS, countChars, hanGrams, lintStyle, META_WORDS, openerOf, SENSE_CLAIMS, shapeReply, withoutProtected } from '../server/live/style.mjs'
import { REPLY_CONTROL } from '../server/live/text.mjs'
import { planUtterance, screenUtterance } from '../server/live/utterance.mjs'
import { normaliseActCues } from '../shared/performance-cues.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
export const DEFAULT_CASES = join(root, 'server/live/fixtures/style-cases.jsonl')
// Stage-2 plan targets (P1), plus the checks added after the first real run
// (2026-10-20) copied example lines, reused comfort phrases and narrated the
// pipeline. recentRepeat is measured in --session mode only.
export const TARGETS = Object.freeze({
  withinBudget: 0.9,
  hardHitsAfter: 0,
  questionEnding: 0.3,
  topOpenerShare: 0.2,
  copiedExample: 0.05,
  exampleReuse: 0.1,
  sharedPhrases: 3,
  groupTemplates: 0,
  ruleFailures: 0,
  metaWords: 0.1,
  senseClaims: 0,
  recentRepeat: 0.15,
})
// A reply this close to an example line (letter-bigram Dice) is a copy.
const COPY_SIMILARITY = 0.6
// Example inputs this close to a case's input make that case a recall test.
const OVERLAP_SIMILARITY = 0.5
// Things no live reply may contain: soliciting support, or prompt text.
export const GLOBAL_MUST_NOT = /(?:求|记得|快|帮我|点(?:个|点)?|来(?:个|点)?)(?:点|给|刷)?(?:个|下|波)?(?:关注|三连|投币|礼物|火箭|上舰|舰长|充电)|点个关注|关注一下主播|投喂(?:一下|主播)|打赏(?:一下|一波|支持)|刷(?:个|点|波)?礼物|礼物刷起来|上舰吧|你现在以角色|人格倾向|行为边界|稳定偏好与小习惯|reply_guide|viewer_message/u
const RECENT_WINDOW = 8

const letters = text => (String(text).match(/[\p{L}\p{N}]/gu) ?? []).join('')
const share = (count, total) => (total ? count / total : 0)

// Acts written into the transcript where they are performed, so a blind
// reviewer reading it "hears" the laugh, sigh or pause too.
export const ACT_LABELS = Object.freeze({ laugh: '〔笑〕', sigh: '〔叹气〕', pause: '〔停顿〕' })
export function renderActs(text, actCues = []) {
  let rendered = String(text)
  for (const cue of normaliseActCues(actCues, rendered.length).reverse())
    rendered = `${rendered.slice(0, cue.start)}${ACT_LABELS[cue.act]}${rendered.slice(cue.start)}`
  return rendered
}

// The character's own lines, and the viewer side, of the live examples.
export function exampleReplies(examples = LIVE_PERSONA_OVERRIDES.dialogueExamples) {
  return examples.split('\n').filter(line => line.startsWith('日和：')).map(line => line.slice(3))
}
export function exampleInputs(examples = LIVE_PERSONA_OVERRIDES.dialogueExamples) {
  return examples.split('\n\n').map(block => block.split('\n')
    .filter(line => !line.startsWith('日和：'))
    .map(line => line.replace(/^[^：]*：/u, ''))
    .join('\n'))
}

function bigramCounts(text) {
  const value = letters(text)
  const counts = new Map()
  for (let index = 0; index + 1 < value.length; index++) {
    const pair = value.slice(index, index + 2)
    counts.set(pair, (counts.get(pair) ?? 0) + 1)
  }
  return counts
}

// Dice coefficient over letter bigrams (with repeats): 1 for the same
// letters in the same order, 0 for nothing in common.
export function similarity(a, b) {
  const left = bigramCounts(a)
  const right = bigramCounts(b)
  let total = 0
  let shared = 0
  for (const [pair, count] of left) {
    total += count
    shared += Math.min(count, right.get(pair) ?? 0)
  }
  for (const count of right.values())
    total += count
  return total ? (2 * shared) / total : 0
}

export function closestExample(text, examples = exampleReplies()) {
  let best = { example: '', similarity: 0 }
  for (const example of examples) {
    const score = similarity(text, example)
    if (score > best.similarity)
      best = { example, similarity: score }
  }
  return best
}

const caseText = testCase => testCase.batch.map(item => item.text).join('\n')

// Cases whose input an example already answers: those would measure recall
// of the example line, not how she handles a new message. A one-symbol
// input such as "？" has no letters, so it is compared as written.
export function exampleInputOverlaps(cases, examples = LIVE_PERSONA_OVERRIDES.dialogueExamples) {
  // Each example as a whole and each of its viewer lines alone, so a case
  // equal to one line of a several-danmaku example is caught too.
  const inputs = [...new Set(exampleInputs(examples).flatMap(input => [input, ...input.split('\n')]))]
  const overlaps = []
  for (const testCase of cases) {
    let best = null
    // The case as a whole and each of its messages alone.
    for (const text of new Set([caseText(testCase), ...testCase.batch.map(item => item.text)])) {
      for (const input of inputs) {
        const score = similarity(text, input)
        const symbolic = letters(text).length < 2 && text.replace(/\s/gu, '') === input.replace(/\s/gu, '')
        if ((score >= OVERLAP_SIMILARITY || symbolic) && (!best || score > best.similarity))
          best = { id: testCase.id, example: input, similarity: Number(score.toFixed(2)) }
      }
    }
    if (best)
      overlaps.push(best)
  }
  return overlaps
}

export function parseCases(text) {
  const cases = []
  const ids = new Set()
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.trim()
    if (!line || line.startsWith('//'))
      continue
    const value = JSON.parse(line)
    if (typeof value.id !== 'string' || !value.id || ids.has(value.id))
      throw new Error(`line ${index + 1}: a case needs a unique id`)
    if (!Array.isArray(value.batch) || !value.batch.length || value.batch.length > 3
      || value.batch.some(item => !['danmaku', 'superchat', 'host'].includes(item?.kind) || typeof item.text !== 'string' || !item.text.trim()))
      throw new Error(`line ${index + 1}: batch must hold 1–3 danmaku/superchat/host items with text`)
    for (const key of ['must', 'mustNot']) {
      if (value.expect?.[key] !== undefined)
        new RegExp(value.expect[key], 'u') // throws on an invalid pattern
    }
    ids.add(value.id)
    cases.push(value)
  }
  return cases
}

// The words this case's viewers wrote, names included: echoing them back is
// never a habit or a copy.
const viewerText = testCase => testCase.batch.map(item => `${item.text} ${item.user?.name ?? ''}`).join('\n')

export function checkRules(final, testCase) {
  if (!final)
    return ['empty']
  const failures = []
  if (testCase.expect?.must && !new RegExp(testCase.expect.must, 'u').test(final))
    failures.push(`must /${testCase.expect.must}/`)
  if (testCase.expect?.mustNot && new RegExp(testCase.expect.mustNot, 'u').test(final))
    failures.push(`mustNot /${testCase.expect.mustNot}/`)
  if (GLOBAL_MUST_NOT.test(final))
    failures.push('global')
  return failures
}

// One result from what the model said first (`raw`, with the acts it wrote,
// `rawActCues`) and what would be spoken (`final`, with the acts performed,
// `actCues`). Everything derived is recomputed here, so a saved run can be
// re-measured with newer checks.
export function measure(testCase, { sample = 0, raw, final, delivery = 'neutral', actCues = [], rawActCues = [], attempts = 1, gate = 'ok', blocked = false, usage = [] }, { replies = exampleReplies() } = {}) {
  const budget = replyLengthBudget(testCase.batch)
  const first = raw ? shapeReply(raw, [], budget).report : null
  const echoed = viewerText(testCase)
  const metaPattern = new RegExp(META_WORDS.source, 'gu')
  // An honest answer ("我只读得到弹幕") is required wording, not backstage talk.
  const meta = [...withoutProtected(String(final ?? '')).matchAll(metaPattern)].some(match => !echoed.includes(match[0]))
  const performed = normaliseActCues(actCues, String(final ?? '').length)
  return {
    id: testCase.id,
    sample,
    group: testCase.group ?? '',
    focus: testCase.focus ?? '',
    batch: formatViewerBatch(testCase.batch),
    viewerText: echoed,
    budget,
    raw: raw ?? '',
    final: final ?? '',
    delivery,
    actCues: performed,
    rawActCues: normaliseActCues(rawActCues, String(raw ?? '').length),
    // The kinds performed ('laugh', 'sigh', 'pause'), at most one.
    acts: performed.map(cue => cue.act),
    // Shaping removed an aside the model wrote itself ("（bushi）", or a
    // sound such as "(laughs)" or "<laughter>" where the prompt asks for
    // [[act:…]]).
    rawAside: Boolean(first?.fixed.includes('aside')),
    attempts,
    // The model's own first reply already fitted the turn, before shaping.
    rawWithinBudget: Boolean(first && first.droppedForBudget === 0 && !first.hits.length
      && first.charsBefore <= Math.round(budget.chars * 1.2)),
    rawHits: first?.hits.map(hit => hit.rule) ?? [],
    // Chatbot sentences still spoken (a protected AI admission is not one).
    hardHitsAfter: final ? lintStyle(final).filter(hit => hit.dropped).length : 0,
    rawChars: first?.charsBefore ?? 0,
    finalChars: countChars(final ?? ''),
    questionEnding: Boolean(final) && /[？?][”’」』）)】"']*\s*$/u.test(final),
    opener: final ? openerOf(final) : '',
    gate,
    blocked: Boolean(blocked),
    closestExample: final ? closestExample(final, replies) : { example: '', similarity: 0 },
    ruleFailures: checkRules(final, testCase),
    metaWords: meta,
    senseClaim: SENSE_CLAIMS.test(final ?? ''),
    spoken: /哈哈|^(?:嗯|诶|欸|啊|哇|呃)|……|(\p{Script=Han}{2})\1/u.test(final ?? ''),
    laughs: /哈哈/u.test(final ?? ''),
    usage,
  }
}

// A real brain wired for evaluation: the stage always speaks and finishes
// at once, the gate is the built-in screenUtterance, and the model's raw
// first reply and usage are recorded per case. `ask(testCase)` resolves
// with one measured result.
function createEvalBrain(open, { systemPrompt, now }) {
  let id = 0
  let turnId = 0
  let cooldown = null
  let current = null
  const hub = createHub({ now })
  const queue = createCandidateQueue({ now, newId: () => `i${++id}` })
  const brain = createLiveBrain({
    hub,
    queue,
    systemPrompt,
    now,
    cooldownMs: 0,
    timers: { setTimeout: (callback) => { cooldown = callback; return {} }, clearTimeout() {} },
    turns: {
      canSpeak: () => ({ ok: true }),
      say: async (request) => {
        current.said = request
        return { ok: true, turnId: `t${++turnId}` }
      },
      activity() {},
    },
    control: { pause() {} },
    replyBudget: { reserve: async () => {} },
    screen: utterance => screenUtterance(utterance),
    deepseek: {
      configured: true,
      async open(messages) {
        const call = { raw: '', acts: [], usage: null }
        current.calls.push(call)
        const stream = await open(messages)
        return {
          async relay(onEvent) {
            const result = await stream.relay((event) => {
              // Stripped per delta like the brain, so act offsets line up.
              if (event.type === 'delta')
                call.raw += event.content.replace(REPLY_CONTROL, '')
              else if (event.type === 'act')
                call.acts.push({ start: call.raw.length, act: event.value })
              onEvent(event)
            })
            call.usage = result.usage ?? null
            return result
          },
        }
      },
    },
  })
  const FINAL_EVENTS = ['brain.reply', 'brain.blocked', 'brain.error', 'brain.dropped', 'brain.aborted']
  async function ask(testCase, { sample = 0, replies } = {}) {
    current = { calls: [], said: null }
    const done = new Promise((resolve) => {
      const unsubscribe = hub.subscribe('brain', (event) => {
        if (FINAL_EVENTS.includes(event.type)) {
          unsubscribe()
          resolve(event)
        }
      })
    })
    const added = testCase.batch.map((item, index) => queue.add({ kind: item.kind, msgId: `${testCase.id}:${sample}:${index}`, user: item.user ?? null, text: item.text, amountCny: item.amountCny ?? 0 }))
    if (!added.some(Boolean))
      throw new Error(`case ${testCase.id}: the queue took none of its messages`)
    for (const item of added.filter(Boolean))
      queue.approve(item.id)
    const outcome = await done
    const said = outcome.type === 'brain.reply' ? current.said : null
    const result = measure(testCase, {
      sample,
      raw: current.calls[0]?.raw.trimEnd() ?? '',
      final: said?.text ?? '',
      delivery: said?.delivery ?? 'neutral',
      actCues: said?.acts ?? [],
      rawActCues: current.calls[0]?.acts ?? [],
      attempts: current.calls.length,
      gate: said ? 'ok' : outcome.data.reason ?? (outcome.type === 'brain.error' ? outcome.data.message : outcome.type),
      blocked: outcome.type === 'brain.blocked',
      usage: current.calls.map(call => call.usage),
    }, replies ? { replies } : undefined)
    if (said) {
      // The stage reports the sentences it synthesised; history keeps those.
      const spoken = (await planUtterance({ text: said.text, delivery: said.delivery, cues: said.cues, acts: said.acts })).map(sentence => sentence.text)
      hub.publish('turn.ended', { turnId: `t${turnId}`, outcome: 'played', spoken })
      cooldown?.()
      cooldown = null
    }
    return result
  }
  return { ask, stop: () => brain.stop() }
}

// The hour a --time label stands for, in Shanghai (UTC+8).
export const TIME_OF_DAY_HOURS = Object.freeze({ 早上: 7, 上午: 10, 中午: 12, 下午: 15, 晚上: 20, 深夜: 1 })
const at = (timeOfDay, minutes = 0) => Date.parse(`2026-10-20T${String(TIME_OF_DAY_HOURS[timeOfDay] ?? 20).padStart(2, '0')}:00:00+08:00`) + minutes * 60_000

// `open(messages)` resolves to {relay(onEvent)} like openDeepSeekStream.
// Every case (and sample) gets a fresh brain: no history, no hints.
export async function evaluateCases(cases, open, { systemPrompt = buildLiveSystemPrompt(), samples = 1, timeOfDay = '晚上' } = {}) {
  const results = []
  for (const testCase of cases) {
    for (let sample = 0; sample < samples; sample++) {
      const evalBrain = createEvalBrain(open, { systemPrompt, now: () => at(timeOfDay) })
      try { results.push(await evalBrain.ask(testCase, { sample })) }
      finally { evalBrain.stop() }
    }
  }
  return { results, summary: summarise(results), mode: { samples, session: false } }
}

// One brain answering the cases in order as one stream, a minute apart from
// 20:00 Shanghai time, with its history and its repeated-opener/phrase hints.
export async function runSession(cases, open, { systemPrompt = buildLiveSystemPrompt(), timeOfDay = '晚上' } = {}) {
  let minute = 0
  const evalBrain = createEvalBrain(open, { systemPrompt, now: () => at(timeOfDay, minute) })
  const results = []
  try {
    for (const testCase of cases) {
      minute++
      results.push(await evalBrain.ask(testCase))
    }
  }
  finally {
    evalBrain.stop()
  }
  return { results, summary: summarise(results, { session: true }), mode: { samples: 1, session: true } }
}

// Letter n-grams that turn up in several different cases' replies: a habit
// a viewer hears over a stream ("不用硬撑" four times). Three to 24 letters
// count from `min` cases; two letters, which recur by chance more often,
// from `pairMin` and not for everyday words. Samples of one case count once.
// An n-gram in that case's own viewer messages is an echo, not a habit. A
// phrase inside a longer one with the same cases is not listed twice.
export function sharedPhrases(results, { min = 3, pairMin = 4, maxLength = 24 } = {}) {
  const seen = new Map()
  for (const result of results) {
    // Required wording (an AI admission, a pointer to help) is not a habit.
    const reply = letters(withoutProtected(result.final))
    const echoed = letters(result.viewerText ?? result.batch)
    for (let length = 2; length <= maxLength; length++) {
      for (let index = 0; index + length <= reply.length; index++) {
        const gram = reply.slice(index, index + length)
        if (echoed.includes(gram))
          continue
        if (!seen.has(gram)) seen.set(gram, new Set())
        seen.get(gram).add(result.id)
      }
    }
  }
  const frequent = [...seen].filter(([gram, ids]) => gram.length > 2
    ? ids.size >= min
    : ids.size >= pairMin && !COMMON_PAIRS.has(gram))
  return frequent
    .filter(([gram, ids]) => !frequent.some(([other, otherIds]) => other !== gram && other.includes(gram) && otherIds.size === ids.size))
    .map(([phrase, ids]) => ({ phrase, ids: [...ids] }))
    .sort((a, b) => b.ids.length - a.ids.length || b.phrase.length - a.phrase.length)
}

export function sharedThresholds(cases) {
  return { min: Math.max(3, Math.ceil(cases * 0.1)), pairMin: Math.max(4, Math.ceil(cases * 0.15)) }
}

// The same situation answered with the same words: within each group of at
// least three cases, a Han phrase used by at least half of them (and by two
// or more). Everyday two-character words and the viewers' own words do not
// count; samples of one case count once.
export function groupTemplates(results) {
  const byGroup = new Map()
  for (const result of results.filter(result => result.group && result.final)) {
    if (!byGroup.has(result.group)) byGroup.set(result.group, [])
    byGroup.get(result.group).push(result)
  }
  const templates = []
  for (const [group, members] of byGroup) {
    const size = new Set(members.map(result => result.id)).size
    if (size < 3)
      continue
    const seen = new Map()
    for (const result of members) {
      for (const gram of hanGrams(withoutProtected(result.final), 2, 6)) {
        if (result.viewerText.includes(gram) || (gram.length === 2 && COMMON_PAIRS.has(gram)))
          continue
        if (!seen.has(gram)) seen.set(gram, new Set())
        seen.get(gram).add(result.id)
      }
    }
    const needed = Math.max(2, Math.ceil(size / 2))
    const frequent = [...seen].filter(([, ids]) => ids.size >= needed)
    for (const [phrase, ids] of frequent) {
      if (!frequent.some(([other, otherIds]) => other !== phrase && other.includes(phrase) && otherIds.size === ids.size))
        templates.push({ group, phrase, ids: [...ids], of: size })
    }
  }
  return templates.sort((a, b) => b.ids.length - a.ids.length || b.phrase.length - a.phrase.length)
}

// Partial reuse of an example line that whole-reply similarity misses: a
// four-character Han phrase from an example reply ("在这儿待", "不念不念").
export function exampleReuse(result, replies = exampleReplies()) {
  const fromExamples = new Set(replies.flatMap(reply => [...hanGrams(reply, 4, 4)]))
  return [...hanGrams(withoutProtected(result.final), 4, 4)].filter(gram => fromExamples.has(gram) && !result.viewerText.includes(gram))
}

// --session only: a reply sharing a three-character phrase with one of the
// previous eight (not the viewers' own words).
export function recentRepeats(results, window = RECENT_WINDOW) {
  const hits = []
  results.forEach((result, index) => {
    if (!result.final) return
    const earlier = new Set(results.slice(Math.max(0, index - window), index).flatMap(previous => [...hanGrams(withoutProtected(previous.final), 3, 3)]))
    const repeated = [...hanGrams(withoutProtected(result.final), 3, 3)].filter(gram => earlier.has(gram) && !result.viewerText.includes(gram))
    if (repeated.length)
      hits.push({ id: result.id, phrases: repeated })
  })
  return hits
}

const quantile = (values, q) => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
}

export function summarise(results, { session = false, replies = exampleReplies() } = {}) {
  const answered = results.filter(result => result.final)
  const openers = new Map()
  for (const result of answered)
    openers.set(result.opener, (openers.get(result.opener) ?? 0) + 1)
  const topOpeners = [...openers].sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([opener, count]) => ({ opener, count, share: share(count, answered.length) }))
  const reused = answered.map(result => ({ id: result.id, sample: result.sample, phrases: exampleReuse(result, replies) })).filter(item => item.phrases.length)
  const repeats = session ? recentRepeats(results) : null
  const usage = results.flatMap(result => result.usage)
  const summary = {
    results: results.length,
    cases: new Set(results.map(result => result.id)).size,
    calls: results.reduce((sum, result) => sum + result.attempts, 0),
    answered: answered.length,
    withinBudget: share(results.filter(result => result.rawWithinBudget).length, results.length),
    rawHitCases: results.filter(result => result.rawHits.length).length,
    hardHitsAfter: results.reduce((sum, result) => sum + result.hardHitsAfter, 0),
    questionEnding: share(answered.filter(result => result.questionEnding).length, answered.length),
    topOpeners,
    topOpenerShare: topOpeners[0]?.share ?? 0,
    rawChars: { median: quantile(results.map(result => result.rawChars), 0.5), p90: quantile(results.map(result => result.rawChars), 0.9) },
    finalChars: { median: quantile(answered.map(result => result.finalChars), 0.5), p90: quantile(answered.map(result => result.finalChars), 0.9) },
    gateBlocked: results.filter(result => result.blocked).length,
    copiedExample: share(answered.filter(result => result.closestExample.similarity >= COPY_SIMILARITY).length, answered.length),
    exampleReuse: share(reused.length, answered.length),
    exampleReused: reused,
    // A habit is a phrase in at least a tenth of the cases (two letters: 15%).
    sharedPhrases: sharedPhrases(answered, sharedThresholds(new Set(answered.map(result => result.id)).size)),
    groupTemplates: groupTemplates(answered),
    ruleFailures: results.filter(result => result.ruleFailures.length).map(result => ({ id: result.id, sample: result.sample, failures: result.ruleFailures })),
    metaWords: share(answered.filter(result => result.metaWords).length, answered.length),
    senseClaims: answered.filter(result => result.senseClaim).map(result => result.id),
    spoken: share(answered.filter(result => result.spoken).length, answered.length),
    laughs: answered.filter(result => result.laughs).length,
    // Most replies should have no act; these are for a human to judge.
    actShare: share(answered.filter(result => result.acts?.length).length, answered.length),
    actKinds: Object.fromEntries(Object.keys(ACT_LABELS).map(act => [act, answered.filter(result => result.acts?.includes(act)).length])),
    rawAsides: results.filter(result => result.rawAside).length,
    recentRepeat: repeats ? share(repeats.length, answered.length) : null,
    recentRepeats: repeats,
    promptTokens: usage.reduce((sum, item) => sum + (Number(item?.prompt_tokens) || 0), 0),
    cacheHitTokens: usage.reduce((sum, item) => sum + (Number(item?.prompt_cache_hit_tokens) || 0), 0),
    completionTokens: usage.reduce((sum, item) => sum + (Number(item?.completion_tokens) || 0), 0),
  }
  summary.passes = {
    withinBudget: summary.withinBudget >= TARGETS.withinBudget,
    hardHitsAfter: summary.hardHitsAfter <= TARGETS.hardHitsAfter,
    questionEnding: summary.questionEnding <= TARGETS.questionEnding,
    topOpenerShare: summary.topOpenerShare <= TARGETS.topOpenerShare,
    copiedExample: summary.copiedExample <= TARGETS.copiedExample,
    exampleReuse: summary.exampleReuse <= TARGETS.exampleReuse,
    sharedPhrases: summary.sharedPhrases.length <= TARGETS.sharedPhrases,
    groupTemplates: summary.groupTemplates.length <= TARGETS.groupTemplates,
    ruleFailures: summary.ruleFailures.length <= TARGETS.ruleFailures,
    metaWords: summary.metaWords <= TARGETS.metaWords,
    senseClaims: summary.senseClaims.length <= TARGETS.senseClaims,
    ...(repeats ? { recentRepeat: summary.recentRepeat <= TARGETS.recentRepeat } : {}),
  }
  return summary
}

const percent = value => `${Math.round(value * 100)}%`
const mark = ok => (ok ? '达标' : '未达标')
const cell = text => String(text).replaceAll('|', '\\|').replaceAll('\n', ' ')

export function formatReport({ results, summary, mode = { samples: 1, session: false } }, { run, model, date, overlaps = [] }) {
  const label = mode.session ? '整场模式（真实 brain，按顺序带上下文）' : `独立模式（每个场景单独回答${mode.samples > 1 ? `，各采样 ${mode.samples} 次` : ''}）`
  const rows = [
    ['模型原回复就在长度预算内', percent(summary.withinBudget), `≥${percent(TARGETS.withinBudget)}`, 'withinBudget'],
    ['整形后仍有客服腔', `${summary.hardHitsAfter} 句`, `${TARGETS.hardHitsAfter}`, 'hardHitsAfter'],
    ['以问句结尾', percent(summary.questionEnding), `≤${percent(TARGETS.questionEnding)}`, 'questionEnding'],
    ['最常见开头占比', percent(summary.topOpenerShare), `≤${percent(TARGETS.topOpenerShare)}`, 'topOpenerShare'],
    [`整句照搬示例（相似度 ≥${COPY_SIMILARITY}）`, percent(summary.copiedExample), `≤${percent(TARGETS.copiedExample)}`, 'copiedExample'],
    ['借用示例里的四字短语', percent(summary.exampleReuse), `≤${percent(TARGETS.exampleReuse)}`, 'exampleReuse'],
    ['多个场景共用的短语（≥10% 场景）', `${summary.sharedPhrases.length} 个`, `≤${TARGETS.sharedPhrases}`, 'sharedPhrases'],
    ['同类场景套同一句', `${summary.groupTemplates.length} 个`, `${TARGETS.groupTemplates}`, 'groupTemplates'],
    ['违反场景规则', `${summary.ruleFailures.length} 条`, `${TARGETS.ruleFailures}`, 'ruleFailures'],
    ['讲后台流程（弹幕、这一轮、转过来）', percent(summary.metaWords), `≤${percent(TARGETS.metaWords)}`, 'metaWords'],
    ['假装能听、能玩', `${summary.senseClaims.length} 条`, `${TARGETS.senseClaims}`, 'senseClaims'],
    ...(summary.recentRepeat === null ? [] : [['和前 8 条重复三字短语', percent(summary.recentRepeat), `≤${percent(TARGETS.recentRepeat)}`, 'recentRepeat']]),
  ]
  const lines = [
    `# 直播口吻评测（${date}${run ? ` · ${run}` : ''}）`,
    '',
    `${label}；${model ? `模型 ${model}` : '离线假模型'}。${summary.cases} 个场景、${summary.results} 条回复、${summary.calls} 次调用（含重试），输入 ${summary.promptTokens}（缓存命中 ${summary.cacheHitTokens}）/ 输出 ${summary.completionTokens} tokens。`,
    model ? '数字只对这组场景成立，不是"像真人"的证明；措辞好坏仍要人听。' : '离线模式用的是固定假回复，只验证流程，不代表真实措辞。',
    `示例与场景重叠：${overlaps.length ? overlaps.map(item => `${item.id}（${item.similarity}）`).join('，') : '无'}。`,
    '',
    '| 指标 | 结果 | 目标 | |',
    '|---|---|---|---|',
    ...rows.map(([name, value, target, key]) => `| ${name} | ${value} | ${target} | ${mark(summary.passes[key])} |`),
    '',
    `原回复命中客服腔：${summary.rawHitCases} 条；被输出闸门拦下：${summary.gateBlocked} 条；没有可说内容：${summary.results - summary.answered} 条。`,
    `字数（字母和数字）：原回复中位数 ${summary.rawChars.median}、P90 ${summary.rawChars.p90}；最终中位数 ${summary.finalChars.median}、P90 ${summary.finalChars.p90}。`,
    `口语痕迹（哈哈、嗯/诶开头、……、叠词）：${percent(summary.spoken)}，其中带「哈哈」${summary.laughs} 条（仅供参考）。`,
    `副语言动作：${percent(summary.actShare)} 的回复带一个（笑 ${summary.actKinds.laugh}、叹气 ${summary.actKinds.sigh}、停顿 ${summary.actKinds.pause}），逐条里写作${Object.values(ACT_LABELS).join('')}；模型自己写出、被整形删掉的旁白或音效：${summary.rawAsides} 条。`,
    `常见开头：${summary.topOpeners.map(item => `「${item.opener || '（空）'}」${item.count}`).join('，') || '无'}。`,
    `共用短语：${summary.sharedPhrases.slice(0, 10).map(item => `「${item.phrase}」${item.ids.length}`).join('，') || '无'}。`,
    `同类套话：${summary.groupTemplates.map(item => `${item.group}「${item.phrase}」${item.ids.length}/${item.of}`).join('，') || '无'}。`,
    `借用示例短语：${summary.exampleReused.slice(0, 10).map(item => `${item.id}「${item.phrases.join('」「')}」`).join('，') || '无'}。`,
    `违反规则：${summary.ruleFailures.map(item => `${item.id}${item.sample ? `#${item.sample + 1}` : ''}（${item.failures.join('、')}）`).join('，') || '无'}。`,
    ...(summary.recentRepeats ? [`和前文重复：${summary.recentRepeats.slice(0, 12).map(item => `${item.id}「${item.phrases.slice(0, 3).join('」「')}」`).join('，') || '无'}。`] : []),
    '',
    '## 逐条',
    '',
    '| 场景 | 弹幕 | 最终回复 | 字数 | 备注 |',
    '|---|---|---|---|---|',
    ...results.map((result) => {
      const final = renderActs(result.final, result.actCues)
      const raw = renderActs(result.raw, result.rawActCues)
      const notes = [
        final !== raw && `原文：${raw || '（空）'}`,
        result.rawHits.length && `命中 ${result.rawHits.join('、')}`,
        result.attempts > 1 && '重试过',
        result.gate !== 'ok' && `闸门：${result.gate}`,
        result.closestExample.similarity >= COPY_SIMILARITY && `像示例：${result.closestExample.example}`,
        result.ruleFailures.length && result.final && `规则：${result.ruleFailures.join('、')}`,
        result.senseClaim && '假装能听/能玩',
        result.rawAside && '删了模型自己写的旁白或音效',
      ].filter(Boolean).join('；')
      const batch = result.batch.replace(/<viewer_message from="([^"]*)" kind="(\w+)"(?: amount="([^"]*)")?>/g, (_, from, kind, amount) => `${kind === 'superchat' ? `SC ${amount}` : kind === 'host' ? '' : '弹幕'}（${from}）：`).replaceAll('</viewer_message>', ' ')
      const name = mode.samples > 1 ? `${result.id}#${result.sample + 1}` : result.id
      return `| ${cell(name)} | ${cell(batch.trim())} | ${cell(final || '（无）')} | ${result.finalChars} | ${cell(notes)} |`
    }),
    '',
  ]
  return lines.join('\n')
}

const VALUE_FLAGS = ['from', 'cases', 'only', 'limit', 'samples', 'time', 'out']
const SWITCHES = ['real', 'session']

// Unknown flags and "--limit 5" (a space instead of "=") are refused, so a
// typo can never turn a small paid run into a full one.
export function parseArguments(argv) {
  const options = {}
  for (const value of argv) {
    const match = /^--([a-z]+)(?:=(.*))?$/u.exec(value)
    if (!match || (match[2] === undefined ? !SWITCHES.includes(match[1]) : !VALUE_FLAGS.includes(match[1])))
      throw new Error(`unknown or malformed argument: ${value} (use --name=value)`)
    options[match[1]] = match[2] ?? true
  }
  for (const [name, minimum, maximum] of [['limit', 1, 10_000], ['samples', 1, 5]]) {
    if (options[name] === undefined) continue
    const number = Number(options[name])
    if (!Number.isInteger(number) || number < minimum || number > maximum)
      throw new Error(`--${name} must be an integer from ${minimum} to ${maximum}`)
    options[name] = number
  }
  if (options.time !== undefined && !Object.hasOwn(TIME_OF_DAY_HOURS, options.time))
    throw new Error(`--time must be one of ${Object.keys(TIME_OF_DAY_HOURS).join(' ')}`)
  if (options.session && options.samples > 1)
    throw new Error('--samples applies to independent mode only')
  return options
}

async function freshDirectory(base) {
  for (let index = 1; ; index++) {
    const candidate = index === 1 ? base : `${base}-${index}`
    try { await access(candidate) }
    catch { return candidate }
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const cases = parseCases(await readFile(options.cases ?? DEFAULT_CASES, 'utf8'))
  const overlaps = exampleInputOverlaps(cases)
  const from = options.from
  if (from) {
    // Re-measure a saved run with today's checks; cases are matched by id.
    // Copies are judged against the examples that run was given (saved as
    // examples.txt next to it), not today's.
    // The run's own cases (cases.jsonl) when saved, so rules are checked
    // against what was asked; a saved batch that differs is skipped.
    const runCases = await readFile(join(dirname(resolve(from)), 'cases.jsonl'), 'utf8').then(parseCases).catch(() => null)
    const byId = new Map((runCases ?? cases).map(testCase => [testCase.id, testCase]))
    const saved = (await readFile(from, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
    const changed = saved.filter(result => byId.has(result.id) && result.batch && formatViewerBatch(byId.get(result.id).batch) !== result.batch)
    if (changed.length)
      console.warn(`Skipping ${changed.length} saved results whose case text has changed: ${changed.map(result => result.id).join(', ')}`)
    const runExamples = await readFile(join(dirname(resolve(from)), 'examples.txt'), 'utf8').catch(() => null)
    const examples = runExamples ?? LIVE_PERSONA_OVERRIDES.dialogueExamples
    const replies = exampleReplies(examples)
    const results = saved.filter(result => byId.has(result.id) && !changed.includes(result)).map(result => measure(byId.get(result.id), result, { replies }))
    const header = (await readFile(join(dirname(resolve(from)), 'report.md'), 'utf8').catch(() => ''))
    const model = /模型 ([\w.-]+)/u.exec(header)?.[1] ?? ''
    const session = header.includes('整场模式')
    const samples = Math.max(1, ...results.map(result => (result.sample ?? 0) + 1))
    const date = /(\d{4}-\d{2}-\d{2})/.exec(resolve(from))?.[1] ?? new Date().toISOString().slice(0, 10)
    const measuredCases = [...byId.values()].filter(testCase => results.some(result => result.id === testCase.id))
    const report = formatReport({ results, summary: summarise(results, { session, replies }), mode: { samples, session } },
      { run: runExamples ? '用当时的示例重新测量' : '重新测量（没有 examples.txt，按现在的示例比）', model, date, overlaps: exampleInputOverlaps(measuredCases, examples) })
    await writeFile(join(dirname(resolve(from)), 'report.md'), report)
    console.log(`Rebuilt ${join(dirname(resolve(from)), 'report.md')} from ${results.length} saved results (no model calls).`)
    return
  }
  const real = Boolean(options.real)
  const session = Boolean(options.session)
  const samples = options.samples ?? 1
  const only = options.only ? new Set(options.only.split(',').map(id => id.trim()).filter(Boolean)) : null
  const unknown = only ? [...only].filter(id => !cases.some(testCase => testCase.id === id)) : []
  if (unknown.length)
    throw new Error(`--only names unknown cases: ${unknown.join(', ')}`)
  const selected = cases.filter(testCase => !only || only.has(testCase.id)).slice(0, options.limit ?? Infinity)
  const timeOfDay = options.time ?? '晚上'
  const date = new Date().toISOString().slice(0, 10)
  let open
  let model = ''
  if (real) {
    const apiKey = process.env.DEEPSEEK_API_KEY?.trim()
    if (!apiKey) {
      console.error('--real needs DEEPSEEK_API_KEY (run with node --env-file-if-exists=.env.local).')
      process.exitCode = 1
      return
    }
    const config = readServerConfig(process.env)
    model = config.model
    const maxTokens = Number.parseInt(process.env.LIVE_MAX_TOKENS ?? '', 10)
    const planned = session ? selected.length : selected.length * samples
    console.log(`Calling ${model}: ${planned} replies (at most ${planned * 2} calls).`)
    open = messages => openDeepSeekStream({
      apiKey, baseUrl: config.baseUrl, model, messages,
      maxTokens: Number.isInteger(maxTokens) ? Math.min(400, Math.max(32, maxTokens)) : 160,
      temperature: 0.8,
    })
  }
  else {
    const fake = createFakeDeepSeek()
    open = messages => openDeepSeekStream({ apiKey: 'offline', baseUrl: 'https://fake.invalid', model: 'fake', messages, maxTokens: 160, temperature: 0.8, fetchImpl: fake.fetch })
  }
  const evaluation = session
    ? await runSession(selected, open, { timeOfDay })
    : await evaluateCases(selected, open, { samples, timeOfDay })
  const report = formatReport(evaluation, { model, date, overlaps })
  const out = options.out
    ? resolve(options.out)
    : real ? await freshDirectory(join(root, 'docs/reviews', `${date}-live-style${session ? '-session' : ''}`)) : undefined
  if (out) {
    await mkdir(out, { recursive: true })
    await writeFile(join(out, 'report.md'), report)
    await writeFile(join(out, 'results.jsonl'), `${evaluation.results.map(result => JSON.stringify(result)).join('\n')}\n`)
    // What this run was given, so it can be re-measured faithfully later.
    await writeFile(join(out, 'examples.txt'), LIVE_PERSONA_OVERRIDES.dialogueExamples)
    await writeFile(join(out, 'cases.jsonl'), `${selected.map(testCase => JSON.stringify(testCase)).join('\n')}\n`)
    await writeFile(join(out, 'system-prompt.txt'), buildLiveSystemPrompt())
    console.log(`Wrote ${join(out, 'report.md')}`)
  }
  else {
    console.log(report)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main().catch((error) => {
    console.error(`live-style-eval: ${error.message}`)
    process.exitCode = 1
  })
}
