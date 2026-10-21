import { SOUND_TAG } from './moderation.mjs'

// Shapes a live reply before the output gate, so the stage sounds like a
// person chatting rather than a chatbot answering: markdown, emoji and TTS
// asides are removed, sentences with customer-service tells are dropped, and
// the reply is cut to whole sentences within the turn's length budget.
// Nothing here adds words. Tone cue offsets are remapped so each tone stays
// on the sentence it was written for, and an act (a laugh, a sigh, a pause)
// stays before its words or goes with them. What the safety rules require (an AI
// admission, a pointer to help) is never removed. Soft signals (a trailing
// question, the opening words, backstage words, claims to hear or play) are
// only reported.

// Sentence ends for budgeting. "…" and "~" are pauses inside a thought, not
// ends: "嗯……这种时候确实难熬。" is one sentence.
const TERMINAL = /[。！？!?]/u
const CLOSING = /[”’」』）)】"']/u
const COUNTED = /[\p{L}\p{N}]/gu
const CLAUSE_BREAK = /[，,；;：:、]/u
// A reaction ("诶？", "好耶！", "哈哈哈！") does not use up a sentence or
// count as an answer: two letters or fewer, or up to four reaction sounds.
const REACTION_SOUNDS = /^[哈嘿呵嗯诶欸啊哇呀哦噢喔嘛啦呜唔耶好的吧嗷嘻]+$/u

const HARD_RULES = Object.freeze([
  { id: 'hope-helpful', pattern: /希望(?:这|以上|我的(?:回答|建议))?(?:些|个)?(?:对[^，。！？!?]{0,6}|能|可以)?(?:有所|有)?帮(?:助|到)/u },
  { id: 'as-an-ai', pattern: /作为(?:一个|一名)?(?:AI|人工智能|虚拟助手)/iu },
  { id: 'offer-help', pattern: /(?:还)?有什么(?:我)?(?:可以|能)(?:帮|为)(?:你|您)/u },
  { id: 'at-service', pattern: /(?:很|非常)?(?:高兴|荣幸|乐意)(?:为|帮)(?:你|您)(?:服务|效劳)/u },
  { id: 'assistant', pattern: /语言模型|AI ?助手|人工智能助手|智能助手/iu },
  { id: 'summary', pattern: /总(?:的来说|而言之|结一下)|综上(?:所述)?/u },
  { id: 'canned-refusal', pattern: /(?:很|非常)?抱歉[，,]?\s*(?:我)?(?:无法|不能)(?:提供|回答|满足|协助)/u },
])

// What shaping must keep. Admitting to be AI when asked (LIVE_RULES): "AI"
// as its own word in any case, so "said" or "AIRI" is not one. Pointing a
// viewer to people they trust, a hotline or a professional. "家人们" is
// streamer slang for the audience, not family.
export const ADMISSION = /(?<![A-Za-z])AI(?![A-Za-z])|ＡＩ|人工智能|语言模型|大模型|不是(?:真人|人类)|虚拟(?:主播|角色|形象|偶像|人)|数字(?:角色|人)/iu
export const REFERRAL = /热线|心理(?:援助|咨询|老师|医生)|医生|信任的人|信得过|身边的人|家人(?!们)|朋友|找(?:个)?人(?:聊|说|陪)|拨打|(?<!\d)(?:12356|12320|110|120)(?!\d)|专业(?:的)?(?:人|帮助|机构)/u
export const PROTECTED = new RegExp(`${ADMISSION.source}|${REFERRAL.source}`, 'iu')

// Removed in place: they are never read aloud and only look machine-made.
// Backticks stay: a code block is unspeakable and the gate drops it as such.
// The passes repeat until nothing changes, so "( **laughs**)" loses its
// "**" and then its aside, and an invisible character or emoji inside a tag
// cannot hide it from shaping while the gate (which drops invisibles) sees it.
const FIXES = Object.freeze([
  { id: 'invisible', pattern: /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu },
  { id: 'markdown', pattern: /\*\*|__/gu },
  // "1. " or "1、" opening a line; "1.5 倍速" and a "3、2、1" countdown are
  // not lists.
  { id: 'list-marker', pattern: /^[ \t]*(?:#{1,6}[ \t]+|[-*•][ \t]+|\d{1,2}[.)）][ \t]+|\d{1,2}、(?!\d))/gmu },
  { id: 'emoji', pattern: /(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\u200d|\ufe0f)+/gu },
  // "（bushi）", "(laughs)", "<#0.5#>", "<laughter>", '<break time="2s"/>':
  // B站 asides, TTS controls and sound or SSML tags a speech provider would
  // act on. A laugh the model wrote itself is removed, never turned into an
  // act. "（AI）" is a word, not an aside; "1<2" and "<3" are not tags, and a
  // tag is only a name and name=value attributes, so "a<b and b>c" and
  // "<Hollow Knight>" are text. The output gate blocks the same shapes
  // (moderation.mjs TTS_MARKUP and SOUND_TAG).
  { id: 'aside', pattern: /[（(]\s*(?![Aa][Ii]\s*[)）])[A-Za-z][A-Za-z -]{1,24}\s*[)）]|<#\s*\d+(?:\.\d+)?\s*#>/gu },
  { id: 'aside', pattern: new RegExp(SOUND_TAG.source, 'giu') },
])
const MAX_FIX_PASSES = 4

// An act is performed before words; one with none after it has nothing to do.
const SPOKEN_AFTER = /[\p{L}\p{N}]/u
export const hasWordsAfter = (text, start) => SPOKEN_AFTER.test(text.slice(start))

const lettersOf = text => (String(text).match(COUNTED) ?? []).join('')

export function isReaction(sentence) {
  const value = lettersOf(sentence)
  return value.length <= 2 || (value.length <= 4 && REACTION_SOUNDS.test(value))
}

export function countChars(text) {
  return (String(text).match(COUNTED) ?? []).length
}

// Sentence spans over UTF-16 offsets (the unit cue offsets use). Each span
// includes its closing punctuation and any whitespace before the next one.
export function splitSentences(text) {
  const spans = []
  let start = 0
  let index = 0
  while (index < text.length) {
    if (text[index] === '\n' || TERMINAL.test(text[index])) {
      let end = index
      while (end < text.length && TERMINAL.test(text[end])) end++
      while (end < text.length && CLOSING.test(text[end])) end++
      while (end < text.length && /\s/u.test(text[end])) end++
      if (end === index) end++
      spans.push({ start, end })
      start = end
      index = end
      continue
    }
    index++
  }
  if (start < text.length)
    spans.push({ start, end: text.length })
  // Whitespace-only spans belong to the sentence before them.
  const merged = []
  for (const span of spans) {
    if (!text.slice(span.start, span.end).trim() && merged.length)
      merged.at(-1).end = span.end
    else
      merged.push(span)
  }
  return merged
}

// Removes the given spans, or replaces them with `replace`. A cue inside a
// changed span moves to where that span was, so it applies to whatever
// follows; of several cues landing on one offset, the last (the most recent
// tone) wins. Acts are a list of their own and never collapse with cues. A
// `drop` span takes words out (a chatbot sentence, one past the budget): an
// act inside it goes with them, as does one at its end when nothing follows,
// rather than moving onto a sentence it was not written for. Other spans
// (markup, emoji, leading space) move acts as they move cues.
export function removeRanges(text, cues, ranges, acts = []) {
  const sorted = ranges.filter(range => range.end > range.start).sort((a, b) => a.start - b.start)
  const merged = []
  for (const range of sorted) {
    const last = merged.at(-1)
    if (last && range.start <= last.end) {
      if (range.end >= last.end)
        last.replace = range.replace
      last.end = Math.max(last.end, range.end)
      last.drop ||= Boolean(range.drop)
    }
    else {
      merged.push({ ...range })
    }
  }
  const map = (position) => {
    let shift = 0
    for (const range of merged) {
      if (position >= range.end)
        shift += range.end - range.start - (range.replace?.length ?? 0)
      else if (position >= range.start)
        return range.start - shift
      else
        break
    }
    return position - shift
  }
  const dropped = position => merged.some(range => range.drop
    && ((position >= range.start && position < range.end) || (position === range.end && range.end === text.length)))
  let result = ''
  let last = 0
  for (const range of merged) {
    result += text.slice(last, range.start) + (range.replace ?? '')
    last = range.end
  }
  result += text.slice(last)
  const moved = []
  for (const cue of cues) {
    const start = map(cue.start)
    if (moved.length && moved.at(-1).start === start)
      moved[moved.length - 1] = { ...cue, start }
    else
      moved.push({ ...cue, start })
  }
  return {
    text: result,
    cues: moved.filter(cue => cue.start < result.length),
    acts: acts.filter(cue => !dropped(cue.start)).map(cue => ({ ...cue, start: map(cue.start) })).filter(cue => cue.start < result.length),
  }
}

// Whole sentences from the start while they fit: at most `sentences`
// counted sentences and `chars` letters/digits (with 20% slack, so a reply
// slightly over is not cut for a few characters). The first real answer is
// always kept, after a leading "哈哈哈！" too; one overlong sentence is left
// to the output gate. Once one sentence is dropped the rest go too, except
// one PROTECTED sentence (an AI admission, a pointer to help) within three
// budgets' worth of letters. `ranges` are the dropped spans (`drop`: their
// acts go with them).
export function fitToBudget(text, budget) {
  const charLimit = Math.round(budget.chars * 1.2)
  let chars = 0
  let sentences = 0
  let answered = false
  let full = false
  let rescued = 0
  const ranges = []
  for (const span of splitSentences(text)) {
    const sentence = text.slice(span.start, span.end)
    const length = countChars(sentence)
    const counts = isReaction(sentence) ? 0 : 1
    const fits = !full && sentences + counts <= budget.sentences && chars + length <= charLimit
    const firstAnswer = counts && !answered
    const rescue = !fits && !firstAnswer && rescued < 1 && PROTECTED.test(sentence) && chars + length <= budget.chars * 3
    if (fits || firstAnswer || rescue) {
      chars += length
      sentences += counts
      answered ||= Boolean(counts)
      rescued += rescue ? 1 : 0
    }
    else {
      ranges.push({ ...span, drop: true })
      full = true
    }
  }
  return { text: removeRanges(text, [], ranges).text.trimEnd(), dropped: ranges.length, ranges }
}

// For a PROTECTED sentence that also carries chatbot phrasing, the clauses
// that carry it go and the rest stays: "很抱歉，我无法回答，我只是个AI。"
// keeps "我只是个AI。". If the phrase is the whole sentence, nothing goes.
function clauseCut(text, span, from, to) {
  let bodyEnd = span.end
  while (bodyEnd > span.start && /[\s。！？!?”’」』）)】"']/u.test(text[bodyEnd - 1])) bodyEnd--
  const clauses = []
  let start = span.start
  for (let index = span.start; index < bodyEnd; index++) {
    if (CLAUSE_BREAK.test(text[index])) {
      clauses.push({ start, end: index + 1 })
      start = index + 1
    }
  }
  clauses.push({ start, end: bodyEnd })
  const hit = clauses.filter(clause => clause.end > from && clause.start < to)
  if (!hit.length || hit.length === clauses.length)
    return null
  if (hit.at(-1) === clauses.at(-1)) {
    // The last clause goes: end the sentence after the clause before it.
    let spaceStart = span.end
    while (spaceStart > span.start && /\s/u.test(text[spaceStart - 1])) spaceStart--
    return { start: hit[0].start - 1, end: span.end, replace: `。${text.slice(spaceStart, span.end)}` }
  }
  return { start: hit[0].start, end: hit.at(-1).end }
}

// Chatbot phrasing per sentence. An unprotected sentence with a tell is
// dropped; in a protected one only the clauses carrying it are; the
// "assistant" wording in an AI admission ("我是个AI助手") is the honest
// answer and is only reported.
export function lintStyle(text) {
  const hits = []
  for (const span of splitSentences(text)) {
    const sentence = text.slice(span.start, span.end)
    for (const rule of HARD_RULES) {
      const match = rule.pattern.exec(sentence)
      if (!match)
        continue
      const hit = { rule: rule.id, sentence: sentence.trim() }
      if (rule.id === 'assistant' && ADMISSION.test(sentence))
        hits.push({ ...hit, dropped: false, start: span.start, end: span.start })
      else if (!PROTECTED.test(sentence))
        hits.push({ ...hit, dropped: true, start: span.start, end: span.end })
      else {
        const cut = clauseCut(text, span, span.start + match.index, span.start + match.index + match[0].length)
        hits.push(cut ? { ...hit, dropped: true, ...cut } : { ...hit, dropped: false, start: span.start, end: span.start })
      }
    }
  }
  return hits
}

// Report-only: words about the pipeline rather than the viewer ("这一轮弹幕",
// "转过来的"), and joking claims to hear, sing along or play. A hit is worth
// a human look, not a deletion.
export const META_WORDS = /弹幕|这一?轮|转(?:过来|给我)/u
export const SENSE_CLAIMS = /我(?:的)?耳朵|听着就想|手(?:有点)?痒|小本本|打拍子|跟着(?:晃|唱|哼)/u

// Everyday two-character words that say nothing about a habit.
export const COMMON_PAIRS = new Set(['弹幕', '不过', '就是', '什么', '这么', '没有', '自己', '我们', '你们', '这个', '那个', '一下', '一个', '一点', '有点', '会儿', '不了', '不会', '不是', '可以', '还是', '但是', '因为', '所以', '真的', '已经', '我是', '你的', '我的', '你这', '我这', '谢谢', '容易', '今天', '今晚', '晚上', '现在', '来了', '来啦', '这样', '怎么', '还有'])

// Distinct Han n-grams of a text, taken inside runs of Han characters so a
// phrase never spans punctuation.
export function hanGrams(text, minLength = 2, maxLength = 4) {
  const grams = new Set()
  for (const run of String(text).match(/\p{Script=Han}+/gu) ?? []) {
    for (let length = minLength; length <= maxLength; length++) {
      for (let index = 0; index + length <= run.length; index++)
        grams.add(run.slice(index, index + length))
    }
  }
  return grams
}

// Phrases the character keeps reusing across her recent replies: two
// characters from three replies (not everyday words), three or four from
// two. `exclude` is text the current viewers wrote, so echoing them back is
// never discouraged, and PROTECTED clauses are skipped, so she is never
// told to stop admitting she is AI or pointing someone to help. Only
// fragments of her own, already screened, lines are returned, so they
// cannot carry viewer instructions.
export function withoutProtected(text) {
  let kept = ''
  for (const span of splitSentences(text)) {
    const sentence = text.slice(span.start, span.end)
    if (!PROTECTED.test(sentence)) {
      kept += sentence
      continue
    }
    // Only the clause carrying the required wording is left out, so a habit
    // elsewhere in the sentence ("作为一个AI，…") is still seen.
    for (const clause of sentence.split(/(?<=[，,；;：:、])/u))
      kept += PROTECTED.test(clause) ? '\n' : clause
  }
  return kept
}

export function repeatedPhrases(replies, { exclude = '', max = 3 } = {}) {
  const seen = new Map()
  replies.forEach((reply, index) => {
    for (const gram of hanGrams(withoutProtected(String(reply)))) {
      if (exclude.includes(gram) || (gram.length === 2 && COMMON_PAIRS.has(gram)))
        continue
      if (!seen.has(gram)) seen.set(gram, new Set())
      seen.get(gram).add(index)
    }
  })
  const frequent = [...seen].filter(([gram, ids]) => ids.size >= (gram.length === 2 ? 3 : 2))
  return frequent
    .filter(([gram, ids]) => !frequent.some(([other, otherIds]) => other !== gram && other.includes(gram) && otherIds.size >= ids.size))
    .sort((a, b) => b[1].size - a[1].size || b[0].length - a[0].length)
    .slice(0, max)
    .map(([gram]) => gram)
}

const LEADING = /^[\s\p{P}\p{S}]+/u

// The first two letters, ignoring punctuation: enough to notice a reply
// habit such as always opening with "哈哈".
export function openerOf(text) {
  const letters = String(text).replace(LEADING, '').match(/[\p{L}\p{N}]/gu) ?? []
  return letters.slice(0, 2).join('')
}

export function shapeReply(text, cues, budget, acts = []) {
  const fixed = []
  let current = { text, cues, acts }
  for (let pass = 0; pass < MAX_FIX_PASSES; pass++) {
    const fixRanges = []
    for (const fix of FIXES) {
      for (const match of current.text.matchAll(fix.pattern)) {
        fixRanges.push({ start: match.index, end: match.index + match[0].length })
        if (!fixed.includes(fix.id))
          fixed.push(fix.id)
      }
    }
    if (!fixRanges.length)
      break
    current = removeRanges(current.text, current.cues, fixRanges, current.acts)
  }

  const hits = lintStyle(current.text)
  current = removeRanges(current.text, current.cues, hits.filter(hit => hit.dropped).map(({ start, end, replace }) => ({ start, end, replace, drop: true })), current.acts)
  // A dropped middle sentence can leave a leading space or doubled newline.
  const trimmedStart = current.text.length - current.text.trimStart().length
  if (trimmedStart)
    current = removeRanges(current.text, current.cues, [{ start: 0, end: trimmedStart }], current.acts)

  const fitted = fitToBudget(current.text, budget)
  current = removeRanges(current.text, current.cues, fitted.ranges, current.acts)
  const finalText = current.text.trimEnd()
  const finalCues = current.cues.filter(cue => cue.start < finalText.length)
  const finalActs = current.acts.filter(cue => cue.start < finalText.length && hasWordsAfter(finalText, cue.start))
  return {
    text: finalText,
    cues: finalCues,
    acts: finalActs,
    report: {
      charsBefore: countChars(text),
      charsAfter: countChars(finalText),
      // Nothing left to say (empty, or only punctuation and spaces).
      speakable: countChars(finalText) > 0,
      // A real answer is left, not only a reaction such as "诶？".
      answered: splitSentences(finalText).some(span => !isReaction(finalText.slice(span.start, span.end))),
      budget,
      fixed,
      hits: hits.map(({ rule, sentence, dropped }) => ({ rule, sentence, dropped })),
      droppedByStyle: hits.filter(hit => hit.dropped).length,
      droppedForBudget: fitted.dropped,
      questionEnding: /[？?][”’」』）)】"']*\s*$/u.test(finalText),
      opener: openerOf(finalText),
      metaWords: META_WORDS.test(finalText),
      senseClaim: SENSE_CLAIMS.test(finalText),
      // The acts left to perform, and how many went with removed words.
      acts: finalActs.map(cue => cue.act),
      actsDropped: acts.length - finalActs.length,
    },
  }
}
