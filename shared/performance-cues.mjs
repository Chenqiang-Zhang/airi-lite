// The character's performance vocabulary, shared by the server (prompt,
// parser, live pipeline, speech providers) and the browser (sentence
// planner, speech, avatar). A tone is a state that lasts until the next
// tone; an act is a one-off sound or pause performed just before a
// sentence. Both are cues for voice and face, not claims about feelings.
//
// 'bright' was the old name for happy. It is accepted where data comes in
// (old [[tone:bright]] tags, stored chats, cached pages) and never emitted.
export const EMOTIONS = Object.freeze(['neutral', 'happy', 'soft', 'curious', 'surprised', 'sad', 'pout', 'shy'])
export const EMOTION_ALIASES = Object.freeze({ bright: 'happy' })

const EMOTION_SET = new Set(EMOTIONS)

export function isEmotion(value) {
  return typeof value === 'string' && EMOTION_SET.has(value)
}

// The canonical emotion, or null for anything else ('__proto__' included).
export function normaliseEmotion(value) {
  if (isEmotion(value))
    return value
  return typeof value === 'string' && Object.hasOwn(EMOTION_ALIASES, value) ? EMOTION_ALIASES[value] : null
}

// The stage page's version of the say payload (tones, acts, sentence plan).
// A page reporting another version, or none (loaded before acts existed),
// would buy sentences the server never planned or drop new tones, so it is
// told to reload instead of going live. Bump it with any such change.
// 3: same-tone sentences are bought as one clip (the join rules in
// src/speech-sentences.ts), and say carries `join`.
export const STAGE_PROTOCOL = 3

export const ACTS = Object.freeze(['laugh', 'sigh', 'pause'])
export const MAX_ACTS_PER_REPLY = 1
// A pause is silence the player puts before the sentence, the same for every
// speech engine (MiniMax's own pause marker is not allowed at the start of
// a request, and local engines have none).
export const ACT_PAUSE_SECONDS = 0.4

const ACT_SET = new Set(ACTS)

export function isAct(value) {
  return typeof value === 'string' && ACT_SET.has(value)
}

// Acts of one reply: {start, act} with start a UTF-16 offset in the visible
// text (the act is performed before the character there), earliest first,
// at most MAX_ACTS_PER_REPLY.
export function normaliseActCues(value, textLength) {
  if (!Array.isArray(value))
    return []
  const acts = []
  for (const cue of value.slice(0, 16)) {
    if (cue && typeof cue === 'object' && Number.isInteger(cue.start) && cue.start >= 0 && cue.start < textLength && isAct(cue.act))
      acts.push({ start: cue.start, act: cue.act })
  }
  return acts.sort((a, b) => a.start - b.start).slice(0, MAX_ACTS_PER_REPLY)
}
