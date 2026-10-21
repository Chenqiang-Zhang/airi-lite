// MiniMax T2A v2 pronunciation_dict rules, owned by this server and never
// taken from a client or the LLM. A rule is "key/replacement": Chinese
// replacements are tone-numbered pinyin, one bracket group per syllable
// ("处理/(chu3)(li3)", 5 = neutral tone); kana is allowed for Japanese
// ("東京/トウキョウ"). Seen on one real speech-2.8-hd request (2026-10-21,
// server/fixtures/minimax-2.8-pronunciation.sse): the rule was not billed and
// subtitle offsets still indexed the text as sent. Still UNVERIFIED: whether
// rules match substrings or are case-sensitive. The adapter sends only the
// rules whose key occurs in the text, and keeps reserving their characters
// and relaxing the subtitle bound until more than one request agrees.

// The character's name: 和 is polyphonic (he2 / he4 / huo2 / huo4 / hu2).
// Chosen by ear on 2026-10-21 (.data/p5b-check/names-compare.html): rì hé
// for both spellings; without a rule MiniMax reads Hiyori letter by letter,
// and ひより was the other candidate.
export const MINIMAX_PRONUNCIATION = Object.freeze([
  '日和/(ri4)(he2)',
  'Hiyori/(ri4)(he2)',
])

// Enable one of these only after a misreading has actually been heard:
//   '弹幕/(dan4)(mu4)',
//   '睡不着/(shui4)(bu5)(zhao2)',
//   '卡壳/(qia3)(ke2)',
//   '发型/(fa4)(xing2)',
//   '吐槽/(tu3)(cao2)',
//   '绷不住/(beng1)(bu5)(zhu4)',
//   '很丧/(hen3)(sang4)',
// Never add SC, AI, QQ, yyds, J-pop, doge or 诶: their reading depends on
// context, or they are letters a fixed respelling would only make worse.

const MAX_RULES = 32
const MAX_KEY_UNITS = 16
// Bounds a non-Han key's respelling the way kana is bounded.
const MAX_SYLLABLES = 16
const PINYIN = /^(?:\([a-z]{1,6}[1-5]\))+$/
const KANA = /^[\u3040-\u30ff]{1,16}$/
const HAN = /^\p{Script=Han}+$/u
// Whitespace and control characters cannot be matched reliably, '/' splits
// the rule, and ()[]<># are MiniMax syntax (the literal text never contains
// a half-width bracket, so such a key could never match anyway).
const BAD_KEY = /[\s\u0000-\u001f\u007f-\u009f/()[\]<>#]/

export function isPronunciationRule(rule) {
  if (typeof rule !== 'string')
    return false
  const parts = rule.split('/')
  if (parts.length !== 2)
    return false
  const [key, value] = parts
  if (!key.length || key.length > MAX_KEY_UNITS || !key.isWellFormed() || BAD_KEY.test(key))
    return false
  if (KANA.test(value))
    return true
  if (!PINYIN.test(value))
    return false
  const syllables = value.split('(').length - 1
  // One syllable per Han character, so a typo cannot shift every tone after it.
  return HAN.test(key) ? syllables === [...key].length : syllables <= MAX_SYLLABLES
}

const keyOf = rule => rule.slice(0, rule.indexOf('/'))

// Throws on anything the adapter could send ambiguously: a bad rule, the
// same key twice, or one key inside another (which rule would win is not
// documented). Case is ignored because matching ignores it.
export function validatePronunciationTable(rules) {
  if (!Array.isArray(rules))
    throw new TypeError('pronunciation table must be an array')
  if (rules.length > MAX_RULES)
    throw new RangeError(`pronunciation table has ${rules.length} rules (at most ${MAX_RULES})`)
  const keys = []
  for (const [index, rule] of rules.entries()) {
    if (!isPronunciationRule(rule))
      throw new TypeError(`pronunciation rule ${index} is invalid`)
    keys.push(keyOf(rule).toLowerCase())
  }
  for (const [index, key] of keys.entries()) {
    for (const [other, otherKey] of keys.entries()) {
      if (index === other)
        continue
      if (key === otherKey)
        throw new TypeError(`pronunciation rules ${Math.min(index, other)} and ${Math.max(index, other)} share a key`)
      if (otherKey.includes(key))
        throw new TypeError(`pronunciation rule ${index}'s key is inside rule ${other}'s`)
    }
  }
  return rules
}

// A bad edit to the shipped table fails at startup, not on air.
validatePronunciationTable(MINIMAX_PRONUNCIATION)

// Non-overlapping occurrences, case-insensitive (lowercasing leaves Han and
// kana unchanged, so only Latin-like keys are affected).
function occurrences(text, key) {
  const haystack = String(text).toLowerCase()
  const needle = key.toLowerCase()
  let count = 0
  for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, index + needle.length))
    count++
  return count
}

// The rules whose key occurs in the text, in table order. Invalid rules and
// repeated keys are skipped defensively, since a hand-built config is not
// validated.
export function matchPronunciation(text, rules) {
  const seen = new Set()
  const matched = []
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (!isPronunciationRule(rule))
      continue
    const key = keyOf(rule)
    if (seen.has(key.toLowerCase()) || !occurrences(text, key))
      continue
    seen.add(key.toLowerCase())
    matched.push(rule)
  }
  return matched
}

// The text's length if every occurrence of each matched key were replaced by
// its value. Only relaxes the subtitle bound, in case MiniMax indexes the
// substituted text; occurrences are counted in the original text.
export function substitutedLength(text, rules) {
  let length = String(text).length
  for (const rule of matchPronunciation(text, rules)) {
    const key = keyOf(rule)
    const value = rule.slice(key.length + 1)
    length += occurrences(text, key) * (value.length - key.length)
  }
  return length
}
