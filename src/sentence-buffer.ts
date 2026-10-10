const SENTENCE_END = /[。！？!?；;\n]/
const CLOSING_MARK = /[)\]}）］｝》〉」』】〕〗〙〛”’»›]/
const ASCII_WORD = /[A-Za-z0-9_]/
const MAX_BUFFER = 180

interface QuoteState {
  double: boolean
  single: boolean
}

// SSE deltas can end in the middle of a word. Keep raw text intact until a
// sentence boundary so voice normalization sees complete names and URLs.
export class SentenceBuffer {
  private pending = ''
  private quotes: QuoteState = { double: false, single: false }
  private previous = ''

  push(fragment: string): string[] {
    this.pending += fragment
    return this.drain(false)
  }

  private quotesAfter(text: string, following = ''): QuoteState {
    const quotes = { ...this.quotes }
    let previous = this.previous
    for (let index = 0; index < text.length; index++) {
      const char = text[index]!
      if (char === '"')
        quotes.double = !quotes.double
      else if (char === "'" && !(ASCII_WORD.test(previous) && ASCII_WORD.test(text[index + 1] ?? following)))
        quotes.single = !quotes.single
      previous = char
    }
    return quotes
  }

  private drain(flush: boolean): string[] {
    const ready: string[] = []

    while (this.pending) {
      const match = SENTENCE_END.exec(this.pending)
      let sentenceEnd = match ? match.index + 1 : 0
      let lineBreak = match?.[0] === '\n'
      if (sentenceEnd && sentenceEnd <= MAX_BUFFER) {
        const quotes = this.quotesAfter(this.pending.slice(0, sentenceEnd), this.pending[sentenceEnd])
        // A terminal run is one prosodic ending: ?! and its closing quote or
        // bracket belong to the preceding words, not a silent next sentence.
        // Scan only one unit beyond the cap; even huge punctuation runs stay
        // bounded rather than repeatedly scanning the entire remaining reply.
        while (!lineBreak && sentenceEnd < this.pending.length && sentenceEnd <= MAX_BUFFER) {
          const char = this.pending[sentenceEnd]!
          if (SENTENCE_END.test(char) || CLOSING_MARK.test(char)) {
            sentenceEnd++
            lineBreak = char === '\n'
          }
          else if ((char === '"' && quotes.double) || (char === "'" && quotes.single)) {
            if (char === '"') quotes.double = false
            else quotes.single = false
            sentenceEnd++
          }
          else {
            break
          }
        }
        // Observe just the next available character, without a timer or
        // waiting for the full reply. finish/tone-change commits the ending.
        // A newline is a definite structural break, not an ambiguous terminal
        // continuation. Submit it now so a following silent code block cannot
        // delay the preceding spoken sentence until the whole reply finishes.
        if (!flush && !lineBreak && sentenceEnd === this.pending.length && sentenceEnd <= MAX_BUFFER)
          break
      }
      let end: number
      if (sentenceEnd && sentenceEnd <= MAX_BUFFER) {
        end = sentenceEnd
      }
      else if (this.pending.length > MAX_BUFFER) {
        // Apply the bound before extracting a complete long sentence too.
        // Otherwise its synthesis input depends on the SSE delta packaging.
        // The comma itself must fit inside the bound (index 179, not 180).
        const comma = Math.max(this.pending.lastIndexOf('，', MAX_BUFFER - 1), this.pending.lastIndexOf(',', MAX_BUFFER - 1))
        end = comma >= 60 ? comma + 1 : MAX_BUFFER
        // Even after emoji removal, supplementary-plane letters can occupy two
        // UTF-16 units. Do not send a lone half to the voice phonemizer.
        if (/[\uD800-\uDBFF]/.test(this.pending[end - 1] ?? '')
          && /[\uDC00-\uDFFF]/.test(this.pending[end] ?? ''))
          end--
      }
      else if (flush) {
        end = this.pending.length
      }
      else {
        break
      }
      const raw = this.pending.slice(0, end)
      const sentence = raw.trim()
      this.quotes = this.quotesAfter(raw, this.pending[end])
      this.previous = raw.at(-1) ?? this.previous
      this.pending = this.pending.slice(end)
      if (sentence)
        ready.push(sentence)
    }

    return ready
  }

  finish(): string[] {
    const ready = this.drain(true)
    this.quotes = { double: false, single: false }
    this.previous = ''
    return ready
  }
}
