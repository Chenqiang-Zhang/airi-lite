import { chooseDelivery } from './delivery.ts'
import type { Delivery } from './delivery'
import { SentenceBuffer } from './sentence-buffer.ts'
import { cleanSpokenText, hasSpokenContent, SpokenTextFilter } from './spoken-text.ts'

export interface DeliveryCue {
  start: number // UTF-16 character offset in the visible reply.
  delivery: Delivery
}

export interface SpokenSentence {
  text: string
  delivery: Delivery
}

const DELIVERIES = new Set<Delivery>(['neutral', 'soft', 'bright', 'curious'])

export function normaliseDeliveryCues(value: unknown, textLength: number): DeliveryCue[] {
  if (!Array.isArray(value))
    return []
  const cues = value.slice(0, 128)
    .filter(cue => cue && Number.isInteger(cue.start) && cue.start >= 0 && cue.start < textLength && DELIVERIES.has(cue.delivery))
    .map(cue => ({ start: cue.start as number, delivery: cue.delivery as Delivery }))
    .sort((a, b) => a.start - b.start)
  const result: DeliveryCue[] = []
  for (const cue of cues) {
    if (result.at(-1)?.start === cue.start)
      result[result.length - 1] = cue
    else if (result.at(-1)?.delivery !== cue.delivery)
      result.push(cue)
  }
  return result
}

// One producer (chat deltas) and one consumer (TTS). Closing from the controller
// wakes a consumer waiting between sentences, even when no audio was generated.
export class SpeechSentenceStream implements AsyncIterable<SpokenSentence> {
  private buffer = new SentenceBuffer()
  private filter = new SpokenTextFilter()
  private queue: SpokenSentence[] = []
  private closed = false
  private wake: (() => void) | null = null
  private resolveFinished!: () => void
  readonly finished = new Promise<void>(resolve => (this.resolveFinished = resolve))
  text = ''

  private userText: string
  private delivery?: Delivery
  private requestedDelivery?: Delivery

  constructor(userText = '', delivery?: Delivery) {
    this.userText = userText
    this.delivery = delivery
    this.requestedDelivery = delivery
  }

  private feed(sentences: string[]) {
    for (const text of sentences) {
      const spoken = cleanSpokenText(text)
      if (hasSpokenContent(spoken))
        this.queue.push({ text: spoken, delivery: this.delivery ?? chooseDelivery(this.userText, spoken) })
    }
    this.wake?.()
    this.wake = null
  }

  push(fragment: string) {
    if (this.closed)
      return
    this.text += fragment
    this.feed(this.buffer.push(this.filter.push(fragment)))
  }

  setDelivery(delivery: Delivery) {
    if (this.closed || this.requestedDelivery === delivery)
      return
    // Compare the latest request, not just the applied tone: a keycap may
    // defer the callback, and a newer cue must still be able to replace it.
    this.requestedDelivery = delivery
    // A held keycap base is either a real old-tone digit or a silent emoji.
    // Resolve it before flushing the old clause, then apply the newest cue
    // before the next ordinary character is emitted by the filter.
    this.filter.atSentenceBoundary(pendingOutput => {
      if (this.closed)
        return
      this.feed(this.buffer.push(pendingOutput))
      if (this.delivery !== delivery)
        this.feed(this.buffer.finish())
      this.delivery = delivery
    })
  }

  finish() {
    if (this.closed)
      return
    this.feed(this.buffer.push(this.filter.finish()))
    this.feed(this.buffer.finish())
    this.closed = true
    this.resolveFinished()
    this.wake?.()
    this.wake = null
  }

  cancel() {
    this.queue.length = 0
    this.filter.cancel()
    this.buffer.finish()
    this.closed = true
    this.resolveFinished()
    this.wake?.()
    this.wake = null
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      const sentence = this.queue.shift()
      if (sentence)
        yield sentence
      else if (this.closed)
        return
      else
        await new Promise<void>(resolve => (this.wake = resolve))
    }
  }
}

export function replySentenceStream(text: string, delivery?: Delivery, cues: DeliveryCue[] = [], userText = '') {
  const stream = new SpeechSentenceStream(userText, delivery)
  let start = 0
  for (const cue of normaliseDeliveryCues(cues, text.length)) {
    stream.push(text.slice(start, cue.start))
    stream.setDelivery(cue.delivery)
    start = cue.start
  }
  stream.push(text.slice(start))
  stream.finish()
  return stream
}

export interface PlaybackCue {
  time: number // Seconds from the start of this audio source.
  delivery: Delivery
}

export function deliveryAtTime(cues: PlaybackCue[], time: number): Delivery {
  let delivery: Delivery = 'neutral'
  for (const cue of cues) {
    if (cue.time > time)
      break
    delivery = cue.delivery
  }
  return delivery
}
