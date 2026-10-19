import { replySentenceStream } from '../../src/speech-sentences.ts'

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
