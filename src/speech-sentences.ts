import { normaliseActCues, normaliseEmotion } from '../shared/performance-cues.mjs'
import type { Act, ActCue } from '../shared/performance-cues.mjs'
import { chooseDelivery } from './delivery.ts'
import type { Delivery } from './delivery'
import { SentenceBuffer } from './sentence-buffer.ts'
import { cleanSpokenText, hasSpokenContent, SpokenTextFilter } from './spoken-text.ts'

export interface DeliveryCue {
  start: number // UTF-16 character offset in the visible reply.
  delivery: Delivery
}

export type { Act, ActCue }

export interface SpokenSentence {
  text: string
  delivery: Delivery
  // Performed just before this sentence's words. The key is present only
  // when there is an act, so plans compare equal across server and stage.
  act?: Act
}

// Old 'bright' cues are canonicalised before duplicates are merged, so a
// stored bright cue followed by a happy one is a single tone, not a split.
export function normaliseDeliveryCues(value: unknown, textLength: number): DeliveryCue[] {
  if (!Array.isArray(value))
    return []
  const cues = value.slice(0, 128)
    .filter(cue => cue && Number.isInteger(cue.start) && cue.start >= 0 && cue.start < textLength && normaliseEmotion(cue.delivery))
    .map(cue => ({ start: cue.start as number, delivery: normaliseEmotion(cue.delivery) as Delivery }))
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
  private requestedAct?: Act
  private pendingAct?: Act
  private actTaken = false

  constructor(userText = '', delivery?: Delivery) {
    this.userText = userText
    this.delivery = delivery
    this.requestedDelivery = delivery
  }

  private feed(sentences: string[]) {
    for (const text of sentences) {
      const spoken = cleanSpokenText(text)
      if (!hasSpokenContent(spoken))
        continue
      const sentence: SpokenSentence = { text: spoken, delivery: this.delivery ?? chooseDelivery(this.userText, spoken) }
      // An act belongs to the next sentence that has something to say; one
      // with nothing after it is dropped, the same on server and stage.
      if (this.pendingAct) {
        sentence.act = this.pendingAct
        this.pendingAct = undefined
      }
      this.queue.push(sentence)
    }
    this.wake?.()
    this.wake = null
  }

  // One boundary routine for tone changes and acts. The filter keeps a single
  // deferred boundary (a held keycap or "!"), so a later request replaces an
  // earlier one; reading the newest requested tone and act when it runs
  // means neither is lost.
  private boundary() {
    this.filter.atSentenceBoundary((pendingOutput) => {
      if (this.closed)
        return
      this.feed(this.buffer.push(pendingOutput))
      const delivery = this.requestedDelivery
      const act = this.requestedAct
      this.requestedAct = undefined
      if ((delivery !== undefined && this.delivery !== delivery) || act)
        this.feed(this.buffer.finish())
      if (delivery !== undefined)
        this.delivery = delivery
      if (act)
        this.pendingAct = act
    })
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
    // A held keycap base is a real old-tone digit or a silent emoji; ASCII !
    // is old-tone punctuation or the start of a silent Markdown image.
    // Resolve it before flushing the old clause, then apply the newest cue
    // before the next ordinary character is emitted by the filter.
    this.boundary()
  }

  // An act (a laugh, a sigh, a pause) starts a new sentence and is performed
  // just before it. Only the first act of a reply counts.
  setAct(act: Act) {
    if (this.closed || this.actTaken)
      return
    this.actTaken = true
    this.requestedAct = act
    this.boundary()
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

// The plan for a whole reply. The server's sentence allowance and the stage
// both run this, so they buy and speak the same sentences. At one offset a
// tone change applies before an act, so the act's sentence has the new tone.
export function replySentenceStream(text: string, delivery?: Delivery, cues: DeliveryCue[] = [], userText = '', acts: ActCue[] = []) {
  const stream = new SpeechSentenceStream(userText, normaliseEmotion(delivery) ?? undefined)
  const events = [
    ...normaliseDeliveryCues(cues, text.length).map(cue => ({ start: cue.start, order: 0, apply: () => stream.setDelivery(cue.delivery) })),
    ...normaliseActCues(acts, text.length).map(cue => ({ start: cue.start, order: 1, apply: () => stream.setAct(cue.act) })),
  ].sort((a, b) => a.start - b.start || a.order - b.order)
  let start = 0
  for (const event of events) {
    stream.push(text.slice(start, event.start))
    event.apply()
    start = event.start
  }
  stream.push(text.slice(start))
  stream.finish()
  return stream
}

export interface PlaybackCue {
  time: number // Seconds from the start of this audio source.
  delivery: Delivery
  act?: Act // Performed at this time (the start of an act sentence's clip).
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
