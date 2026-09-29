const SENTENCE_END = /[。！？!?；;\n]/
const MAX_BUFFER = 180

// SSE deltas can end in the middle of a word. Keep raw text intact until a
// sentence boundary so voice normalization sees complete names and URLs.
export class SentenceBuffer {
  private pending = ''

  push(fragment: string): string[] {
    this.pending += fragment
    const ready: string[] = []

    while (true) {
      const match = SENTENCE_END.exec(this.pending)
      if (!match)
        break
      const end = match.index + 1
      const sentence = this.pending.slice(0, end).trim()
      this.pending = this.pending.slice(end)
      if (sentence)
        ready.push(sentence)
    }

    while (this.pending.length > MAX_BUFFER) {
      const comma = Math.max(this.pending.lastIndexOf('，', MAX_BUFFER), this.pending.lastIndexOf(',', MAX_BUFFER))
      const end = comma >= 60 ? comma + 1 : MAX_BUFFER
      ready.push(this.pending.slice(0, end).trim())
      this.pending = this.pending.slice(end)
    }

    return ready
  }

  finish(): string[] {
    const tail = this.pending.trim()
    this.pending = ''
    return tail ? [tail] : []
  }
}
