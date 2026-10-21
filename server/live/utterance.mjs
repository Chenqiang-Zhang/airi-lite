import { groupSentences, joinSpokenText, replySentenceStream } from '../../src/speech-sentences.ts'
import { MAX_REPLY_CHARS, screenReply } from './moderation.mjs'

// Expands a reply exactly as the stage's speak() will (same splitter, same
// arguments as src/speech.ts speak(): userText is empty), so the server can
// allow-list the sentences the stage is about to buy. A sentence carries
// `act` only when one is performed before it, as the stage's plan does.
export async function planUtterance({ text, delivery = 'neutral', cues = [], acts = [] }) {
  const sentences = []
  for await (const sentence of replySentenceStream(text, delivery, cues, '', acts))
    sentences.push({ text: sentence.text, delivery: sentence.delivery, ...(sentence.act ? { act: sentence.act } : {}) })
  return sentences
}

// The clips the stage will buy: the planned sentences, same-tone runs joined
// by the rules in src/speech-sentences.ts (one clip per sentence when
// `join` is false). Each clip keeps its sentences as `parts`.
export async function planClips(utterance, { join = true } = {}) {
  return groupSentences(await planUtterance(utterance), join)
}

// A multiset of clips: a reply that repeats a clip may buy it that many
// times, never more, and never text the server did not plan, so a stage can
// neither buy one sentence of a joined clip alone nor join its own. The act
// is part of the key, so it can neither add a laugh nor drop a planned
// pause. take() returns the clip's sentences, or null.
export function createClipAllowance(clips) {
  const remaining = new Map()
  const key = clip => JSON.stringify([clip.delivery, clip.act ?? null, clip.text])
  for (const clip of clips) {
    const id = key(clip)
    remaining.set(id, [...(remaining.get(id) ?? []), [...(clip.parts ?? [clip.text])]])
  }
  return {
    take(clip) {
      const id = key(clip)
      const left = remaining.get(id)
      if (!left)
        return null
      const parts = left.shift()
      if (!left.length)
        remaining.delete(id)
      return parts
    },
    get remaining() {
      let total = 0
      for (const left of remaining.values())
        total += left.length
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

export async function screenUtterance({ text, delivery = 'neutral', cues = [], acts = [], firstPass = false }, options = {}) {
  if (firstPass)
    options = { ...options, maxChars: FIRST_PASS_MAX_CHARS, ttsControls: false, provider: null }
  const shown = await screenReply(text, options)
  if (!shown.ok)
    return { ...shown, part: 'caption' }
  // Acts split sentences too; what is heard is still the joined words. This
  // does not depend on how sentences are grouped into clips, so the brain's
  // screen and the turn's plan always agree.
  const sentences = await planUtterance({ text, delivery, cues, acts })
  if (!sentences.length)
    return { ok: false, reason: 'empty', part: 'speech' }
  const parts = sentences.map(sentence => sentence.text)
  const spoken = await screenReply(parts.join(''), options)
  if (!spoken.ok)
    return { ...spoken, part: 'speech' }
  // A joined clip puts a space between Latin sentences, which whole-word
  // rules see differently; the local rules check that form too.
  const spaced = joinSpokenText(parts)
  if (spaced !== parts.join('')) {
    const again = await screenReply(spaced, { ...options, provider: null,
      maxChars: (options.maxChars ?? MAX_REPLY_CHARS) + parts.length })
    if (!again.ok)
      return { ...again, part: 'speech' }
  }
  return { ok: true }
}
