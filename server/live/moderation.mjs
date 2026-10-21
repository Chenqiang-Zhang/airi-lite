import { readFile } from 'node:fs/promises'

import { hasProviderSyntax } from '../speech-syntax.mjs'

// The output gate: a whole reply is screened before anything is spoken or
// captioned. Built-in checks catch leaked markup, links, contact details and
// gift solicitation; the host extends them in .data/moderation/blocklist.txt.
// An optional provider (a cloud moderation API, M6) runs last and fails
// closed on error or timeout.
// Matching copies only (the spoken text is never rewritten here): after NFKC,
// drop every control, format and default-ignorable code point, so joiners,
// tag characters, bidi marks or variation selectors cannot split a term.
const IGNORABLE = /[\p{Cc}\p{Cf}\p{Co}\p{Default_Ignorable_Code_Point}]/gu
export const MAX_REPLY_CHARS = 300
const PROVIDER_TIMEOUT_MS = 1_500

// Traditional forms of the characters used by the built-in terms and common
// host lists, so "求打賞" matches "求打赏". Not a general converter.
const TRADITIONAL = new Map([...'禮礼賞赏艦舰長长開开關关點点個个給给轉转賬账帳账進进號号羣群記记'.match(/../gu)]
  .map(pair => [pair[0], pair[1]]))

// Kept narrow on purpose: every hit silences a reply and counts a strike.
export const BUILT_IN_TERMS = Object.freeze([
  '刷礼物', '刷个礼物', '求礼物', '求打赏', '打赏我', '给我打赏', '上舰长', '开舰长', '求上舰',
  '求关注', '点个关注', '充值', '转账', '加微信', '加我微信', '加qq', '加我qq', '私信我', '进群',
])

// Leaked prompt markup, plus the TTS provider's own in-text controls: MiniMax
// reads <#0.5#> as a pause and "(laughs)"-style tags as sounds, and sound or
// SSML tags ("<laughter>", '<break time="2s"/>') are read as markup by some
// engines, so they would change what is heard without changing what the gate
// saw. Acts reach a provider only as structured requests, never as text. The
// live brain's first pass checks only the prompt markup (`ttsControls: false`):
// shaping removes such asides before anything is spoken, and the final pass
// checks both.
const PROMPT_MARKUP = /<\/?\s*(?:viewer_message|reply_guide|user_memory|system)\b|\[\[|\]\]/i
// "(AI)" is a word, not a sound tag; spaces inside the brackets do not make
// "( laughs)" text.
const TTS_MARKUP = /<#|#>|\(\s*(?!ai\s*\))[a-z][a-z -]{1,24}\s*\)/i
// A sound or SSML tag: "<laughter>", "</b>", '<break time="2s"/>' — a tag
// name and only name=value attributes. "1<2", "<3", "a<b and b>c" and
// "<Hollow Knight>" are text. Matched on the text as written (invisible
// characters dropped, no width folding); style.mjs strips the same shape.
export const SOUND_TAG = /<\/?[a-z][\w-]*(?:\s+[\w-]+=(?:"[^"<>]*"|'[^'<>]*'|[^\s<>"']+))*\s*\/?>/i
const URL_PATTERN = /https?:\/\/|www\.|\b[a-z0-9-]{2,}\.(?:com|cn|net|org|top|xyz|io|cc|me|tv|vip|link)\b/i
// Contact checks run on a dedicated copy: accents and other combining marks
// removed (so "examplé.com" and keycap digits fold), all spacing removed (so
// "微 信" is 微信), Chinese numerals read as digits, and any non-alphanumeric
// run between two digits removed (so "138、1234/5678" is one number). There is
// deliberately no rule for long numbers on their own: "666666", years, dates
// and decimals are ordinary speech, and every hit counts a strike.
const CHINESE_DIGITS = new Map([...'零0〇0一1幺1二2两2三3四4五5六6七7八8九9'.match(/../gu)].map(pair => [pair[0], pair[1]]))
const CONTACT_PATTERNS = [
  /(?<!\d)1[3-9]\d{9}(?!\d)/, // mainland mobile
  /(?<!\d)0\d{9,11}(?!\d)/, // landline with area code
  // Digits right after a contact word: "加我 12345678", "QQ号是12345678".
  /(?:(?<![a-z])qq|扣扣|企鹅号|企鹅群|电话|手机|号码|联系方式|(?<![a-z])tel|加我|私信|群号|账号)\D{0,4}\d{5,}/i,
  // A WeChat ID always has a digit or underscore; "微信 android 版" is not one.
  /(?:微信|v信|威信|(?<![a-z])(?:vx|wx))(?:号码?|id)?(?:是|为|:)?(?=[a-z0-9_-]*[\d_])[a-z][a-z0-9_-]{5,19}/i,
]

function contactCopy(normalized) {
  return normalized.normalize('NFKD').replace(/\p{M}/gu, '').normalize('NFC')
    .replace(/\s+/g, '')
    .replace(/./gu, character => CHINESE_DIGITS.get(character) ?? character)
    .replace(/(?<=\d)[^\p{L}\p{N}]+(?=\d)/gu, '')
}

export function normalizeText(text) {
  return String(text ?? '').normalize('NFKC').replace(IGNORABLE, '')
    .replace(/./gu, character => TRADITIONAL.get(character) ?? character)
    .toLowerCase().replace(/\s+/g, ' ').trim()
}

// Spacing, punctuation, symbols and combining marks removed, so "刷 礼·物"
// and "刷́礼物" still match "刷礼物".
export function compactText(text) {
  return normalizeText(text).replace(/[\s\p{P}\p{S}\p{M}]/gu, '')
}

// One term per line: `drop: 词`, `avoid: 词` or `crisis: 词`; a bare line is
// `drop`; `#` starts a comment. The output gate blocks any listed term.
// Terms are matched with spacing and punctuation folded; a term that folding
// would shrink to almost nothing ("+v", an emoji) is matched literally
// instead, and a term that is nothing at all is reported, never dropped
// silently.
export function parseRules(source) {
  const rules = { drop: [], avoid: [], crisis: [], literal: [], word: [], ignored: [] }
  for (const raw of String(source ?? '').split('\n')) {
    const line = raw.replace(/#.*/, '').trim()
    if (!line)
      continue
    const match = /^(drop|avoid|crisis)\s*[:：]\s*(.+)$/i.exec(line)
    const category = match ? match[1].toLowerCase() : 'drop'
    const original = match ? match[2] : line
    const compact = compactText(original)
    const plain = normalizeText(original).replace(/\s/g, '')
    const add = (list, entry) => {
      if (!list.some(existing => JSON.stringify(existing) === JSON.stringify(entry)))
        list.push(entry)
    }
    if (!compact) {
      // Only symbols or emoji: match exactly as written.
      if (plain) add(rules.literal, { category, term: plain })
      else rules.ignored.push(original.trim())
    }
    else if (/^[a-z0-9]{1,3}$/.test(compact)) {
      // Short Latin terms ("sb", "+v") would hit inside ordinary words:
      // match "+v" literally, and bare letters only as a whole word.
      if (plain !== compact) add(rules.literal, { category, term: plain })
      else add(rules.word, { category, term: compact })
    }
    else {
      add(rules[category], compact)
    }
  }
  return rules
}

// A missing file just means "built-ins only"; an unreadable one, or terms
// that could not be used, are reported so the host is not silently running
// without their own list.
export async function loadRules(path, { read = readFile } = {}) {
  let rules
  try {
    rules = parseRules(await read(path, 'utf8'))
  }
  catch (error) {
    return { rules: parseRules(''), problem: error?.code === 'ENOENT' ? null : 'blocklist-unreadable' }
  }
  return { rules, problem: rules.ignored.length ? 'blocklist-terms-ignored' : null }
}

// A higher `maxChars` screens a reply that will still be shortened (the live
// brain's first pass): every other check runs on all of it.
export async function screenReply(text, { rules = parseRules(''), provider = null, signal, maxChars = MAX_REPLY_CHARS, ttsControls = true } = {}) {
  const normalized = normalizeText(text)
  if (!normalized)
    return { ok: false, reason: 'empty' }
  if (normalized.length > maxChars)
    return { ok: false, reason: 'too-long' }
  if (PROMPT_MARKUP.test(normalized)
    || (ttsControls && (TTS_MARKUP.test(normalized) || SOUND_TAG.test(String(text).replace(IGNORABLE, ''))
      // Whatever a speech adapter would delete is refused, never spliced.
      || hasProviderSyntax(String(text).replace(IGNORABLE, '')))))
    return { ok: false, reason: 'markup' }
  const contact = contactCopy(normalized)
  if (URL_PATTERN.test(normalized) || URL_PATTERN.test(contact))
    return { ok: false, reason: 'url' }
  if (CONTACT_PATTERNS.some(pattern => pattern.test(contact)))
    return { ok: false, reason: 'contact' }
  const compact = compactText(text)
  for (const [category, terms] of [['built-in', BUILT_IN_TERMS.map(compactText)], ['drop', rules.drop],
    ['avoid', rules.avoid], ['crisis', rules.crisis]]) {
    const term = terms.find(candidate => candidate && compact.includes(candidate))
    if (term)
      return { ok: false, reason: 'blocklist', category, term }
  }
  const plain = normalized.replace(/\s/g, '')
  const literal = (rules.literal ?? []).find(entry => plain.includes(entry.term))
  if (literal)
    return { ok: false, reason: 'blocklist', category: literal.category, term: literal.term }
  const words = normalized.replace(/[\p{P}\p{S}\p{M}]/gu, '')
  const word = (rules.word ?? []).find(entry => new RegExp(`(?<![a-z0-9])${entry.term}(?![a-z0-9])`).test(words))
  if (word)
    return { ok: false, reason: 'blocklist', category: word.category, term: word.term }
  if (provider)
    return screenWithProvider(text, provider, signal)
  return { ok: true }
}

async function screenWithProvider(text, provider, signal) {
  const timeout = AbortSignal.timeout(PROVIDER_TIMEOUT_MS)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  try {
    const verdict = await Promise.race([
      provider.check(text, { signal: combined }),
      new Promise((_, reject) => combined.addEventListener('abort', () => reject(combined.reason), { once: true })),
    ])
    return verdict?.ok === true ? { ok: true } : { ok: false, reason: 'provider', label: String(verdict?.label ?? '') }
  }
  catch {
    return { ok: false, reason: timeout.aborted ? 'provider-timeout' : 'provider-error' }
  }
}
