import { replySentenceStream } from '../../src/speech-sentences.ts'
import { screenReply } from './moderation.mjs'

// Expands a reply exactly as the stage's speak() will (same splitter, same
// arguments as src/speech.ts speak(): userText is empty), so the server can
// allow-list the sentences the stage is about to buy.
export async function planUtterance({ text, delivery = 'neutral', cues = [] }) {
  const sentences = []
  for await (const sentence of replySentenceStream(text, delivery, cues))
    sentences.push({ text: sentence.text, delivery: sentence.delivery })
  return sentences
}

// A multiset: a reply that repeats a sentence may buy it that many times,
// never more, and never a sentence the server did not plan.
export function createSentenceAllowance(sentences) {
  const remaining = new Map()
  const key = sentence => `${sentence.delivery}\u0000${sentence.text}`
  for (const sentence of sentences)
    remaining.set(key(sentence), (remaining.get(key(sentence)) ?? 0) + 1)
  return {
    take(sentence) {
      const id = key(sentence)
      const count = remaining.get(id) ?? 0
      if (!count)
        return false
      if (count === 1)
        remaining.delete(id)
      else
        remaining.set(id, count - 1)
      return true
    },
    get remaining() {
      let total = 0
      for (const count of remaining.values())
        total += count
      return total
    },
  }
}

// Screens both what viewers will read and what they will hear. The stage
// speaks the planned sentences, which drop Markdown link targets, images and
// some symbols; a term split by such markup ("[刷](a)礼物") reappears only in
// speech, so the caption text alone is not enough.
// `firstPass` (on the utterance, so an injected screen passes it through)
// screens a reply the live brain will still shorten: up to three times the
// spoken limit, prompt markup but not TTS asides (shaping removes those),
// and local rules only, so a paid provider runs once, on what is spoken.
export const FIRST_PASS_MAX_CHARS = 900

export async function screenUtterance({ text, delivery = 'neutral', cues = [], firstPass = false }, options = {}) {
  if (firstPass)
    options = { ...options, maxChars: FIRST_PASS_MAX_CHARS, ttsControls: false, provider: null }
  const shown = await screenReply(text, options)
  if (!shown.ok)
    return { ...shown, part: 'caption' }
  const sentences = await planUtterance({ text, delivery, cues })
  if (!sentences.length)
    return { ok: false, reason: 'empty', part: 'speech' }
  const spoken = await screenReply(sentences.map(sentence => sentence.text).join(''), options)
  return spoken.ok ? { ok: true } : { ...spoken, part: 'speech' }
}
