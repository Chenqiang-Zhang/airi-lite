const MAX_URL_TAIL = 16
const URL_SCHEMES = ['http://', 'https://']
const WORD = /[\p{L}\p{N}]/u
const ASCII_WORD = /[A-Za-z0-9_]/
const EMOJI_COMPONENT = /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\uFE0E\uFE0F\u200D\u20E3]/u

// Clean complete spoken clauses, not individual incoming characters: keycap
// emoji contain ordinary digits, and ZWJ/surrogate sequences can cross deltas.
// Never use this on the display text.
export function cleanSpokenText(text: string): string {
  return text.replace(/[0-9#*]\uFE0F?\u20E3/gu, '')
    .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\uFE0E\uFE0F\u200D\u20E3]/gu, '')
    .trim()
}

export function hasSpokenContent(text: string): boolean {
  return WORD.test(cleanSpokenText(text))
}

/**
 * A bounded, incremental Markdown-to-speech filter, not a Markdown renderer.
 * Display text never passes through this class. Destinations and fenced bodies
 * are discarded as they arrive; even unfinished constructs cannot retain an
 * entire reply. Call finish only at the end of a reply, not at a tone boundary.
 *
 * Unfinished labels are read as labels (images are silent); unfinished code
 * fences and destinations remain silent. Inline backticks/emphasis markers are
 * omitted conservatively, so malformed markup may lose a literal marker.
 */
export class SpokenTextFilter {
  private output = ''
  private keycapCandidate = ''
  private keycapVariation = false
  private pendingBoundary: ((pendingOutput: string) => void) | null = null
  private finished = false
  private highSurrogate = ''
  private leading = true
  private prefix = ''
  private quoteSpace = false
  private quoteDepth = 0
  private skipFenceLF = false
  private lastText = ''
  private escaped = false
  private bang = false
  private underscore = false
  private underscorePrevious = ''
  private ticks = 0
  private inlineCode = 0

  private fence: {
    char: string
    length: number
    opening: boolean
    openingRun: boolean
    spaces: number
    run: number
    candidate: boolean
    tail: boolean
    quoteDepth: number
    quotesRemaining: number
    quoteSpace: boolean
  } | null = null

  private link: {
    image: boolean
    depth: number
    escaped: boolean
    stage: 'label' | 'after-label' | 'destination' | 'reference'
    destinationDepth: number
    quote: string
    titleMayStart: boolean
  } | null = null

  private scheme = ''
  private url: { parentheses: number, brackets: number, tail: string } | null = null

  push(fragment: string): string {
    if (this.finished)
      return ''
    let text = this.highSurrogate + fragment
    this.highSurrogate = ''
    // A transport may split even a surrogate pair. Retain at most one code unit.
    if (text.length && /[\uD800-\uDBFF]/.test(text.at(-1)!)) {
      this.highSurrogate = text.at(-1)!
      text = text.slice(0, -1)
    }
    for (const char of text)
      this.consume(char)
    return this.take()
  }

  // A boundary cannot commit an undecided keycap digit. Retain one callback,
  // replacing repeated boundaries on the same candidate with the newest one.
  // The caller still owns its old delivery until this callback drains the old
  // output; no delivery metadata or unbounded queue lives in the parser.
  atSentenceBoundary(callback: (pendingOutput: string) => void): void {
    if (this.finished)
      return
    if (/^ {0,3}\d{1,9}[.)]?$/.test(this.prefix)) {
      // A cue inside an undecided numeric list prefix is not a normal Markdown
      // sentence cue. Preserve its readable number conservatively instead of
      // assigning the earlier digits to the later delivery.
      const prefix = this.prefix
      this.prefix = ''
      this.leading = false
      for (const char of prefix)
        this.inline(char)
    }
    if (this.keycapCandidate)
      this.pendingBoundary = callback
    else
      callback(this.take())
  }

  cancel(): void {
    this.finished = true
    this.pendingBoundary = null
    this.output = ''
    this.keycapCandidate = ''
    this.keycapVariation = false
    this.highSurrogate = ''
    this.prefix = ''
    this.scheme = ''
    this.link = null
    this.fence = null
    this.url = null
  }

  finish(): string {
    if (this.finished)
      return ''
    this.finished = true
    this.highSurrogate = ''
    if (!this.fence) {
      if (this.link) {
        if (!this.link.image && (this.link.stage === 'label' || this.link.stage === 'after-label'))
          this.flushInlineTail()
        this.link = null
      }
      if (this.prefix) {
        const prefix = this.prefix
        this.prefix = ''
        this.leading = false
        for (const char of prefix)
          this.inline(char)
      }
      if (this.scheme) {
        this.emit(this.scheme)
        this.scheme = ''
      }
      if (this.url) {
        this.emit(this.url.tail)
        this.url = null
      }
      if (this.bang)
        this.emit('!')
      // Unterminated emphasis/code markers and a final escape have no useful
      // speech of their own. Their already emitted body is still available.
    }
    this.fence = null
    this.bang = false
    this.underscore = false
    this.ticks = 0
    this.flushSpokenCandidate()
    return this.take()
  }

  private take(): string {
    const result = this.output
    this.output = ''
    return result
  }

  private emit(text: string) {
    // Keep parser lookbehind lexical, not dependent on the speech sink's
    // delayed keycap candidate. Otherwise a held digit could change URL or
    // underscore parsing in the next incoming character.
    if (text)
      this.lastText = [...text].at(-1)!
    for (const char of text)
      this.emitSpokenCharacter(char)
  }

  private flushSpokenCandidate() {
    this.output += this.keycapCandidate
    this.keycapCandidate = ''
    this.keycapVariation = false
    this.resolveBoundary()
  }

  private resolveBoundary() {
    const callback = this.pendingBoundary
    this.pendingBoundary = null
    callback?.(this.take())
  }

  private emitSpokenCharacter(char: string) {
    if (this.keycapCandidate) {
      if (!this.keycapVariation && (char === '\uFE0F' || char === '\uFE0E')) {
        this.keycapVariation = true
        return
      }
      if (char === '\u20E3') {
        this.keycapCandidate = ''
        this.keycapVariation = false
        this.resolveBoundary()
        return
      }
      this.flushSpokenCandidate()
    }
    if (/^[0-9#*]$/.test(char)) {
      // At most one ASCII base and one variation flag. Hold across push/tone
      // boundaries so SentenceBuffer cannot commit the digit of a later keycap.
      this.keycapCandidate = char
      return
    }
    if (EMOJI_COMPONENT.test(char) || /^[\uD800-\uDFFF]$/u.test(char))
      return
    this.output += char
  }

  private flushInlineTail() {
    if (this.scheme)
      this.emit(this.scheme)
    if (this.url)
      this.emit(this.url.tail)
    if (this.bang)
      this.emit('!')
    this.scheme = ''
    this.url = null
    this.bang = false
    this.underscore = false
    this.inlineCode = 0
    this.ticks = 0
  }

  private consume(char: string) {
    if (this.skipFenceLF) {
      this.skipFenceLF = false
      if (char === '\n')
        return
    }
    if (this.fence) {
      this.inFence(char)
      return
    }
    if (this.link) {
      this.inLink(char)
      return
    }
    if (this.url || this.scheme || this.inlineCode || this.ticks || this.escaped || this.bang || this.underscore) {
      this.inline(char)
      return
    }
    if (!this.leading) {
      this.inline(char)
      return
    }

    if (this.quoteSpace) {
      this.quoteSpace = false
      if (char === ' ' || char === '\t')
        return
    }

    this.prefix += char
    const prefix = this.prefix
    const rest = prefix.replace(/^ {0,3}/, '')
    if (!rest)
      return
    if (rest === '\n' || rest === '\r') {
      this.prefix = ''
      this.emit(char)
      return
    }
    if (/^([`~])\1{2}$/.test(rest)) {
      this.prefix = ''
      this.fence = {
        char: rest[0]!, length: 3, opening: true, openingRun: true,
        spaces: 0, run: 0, candidate: true, tail: false,
        quoteDepth: this.quoteDepth, quotesRemaining: this.quoteDepth, quoteSpace: false,
      }
      return
    }
    if (/^[`~]{1,2}$/.test(rest) && [...rest].every(item => item === rest[0]))
      return
    if (rest === '>') {
      this.prefix = ''
      this.quoteSpace = true
      this.quoteDepth = Math.min(Number.MAX_SAFE_INTEGER, this.quoteDepth + 1)
      // Re-enter the same prefix recognizer for nested quotes, lists/headings,
      // and fences. Indentation preceding the quote is formatting too.
      return
    }
    if (/^#{1,6}$/.test(rest) || /^[-+*]$/.test(rest) || /^\d{1,9}[.)]?$/.test(rest))
      return
    if (/^(?:#{1,6}|[-+*]|\d{1,9}[.)])[\t ]$/.test(rest)) {
      this.prefix = ''
      this.leading = false
      return
    }

    this.prefix = ''
    this.leading = false
    for (const item of prefix)
      this.inline(item)
  }

  private inFence(char: string) {
    const fence = this.fence!
    if (fence.opening) {
      if (char === '\n' || char === '\r') {
        fence.opening = false
        fence.openingRun = false
        fence.spaces = 0
        fence.run = 0
        fence.candidate = true
        fence.tail = false
        fence.quotesRemaining = fence.quoteDepth
        fence.quoteSpace = false
      }
      else if (fence.openingRun && char === fence.char) {
        fence.length = Math.min(Number.MAX_SAFE_INTEGER, fence.length + 1)
      }
      else {
        fence.openingRun = false
      }
      return
    }
    if (char === '\n' || char === '\r') {
      if (fence.candidate && fence.run >= fence.length) {
        this.fence = null
        this.leading = true
        this.quoteDepth = 0
        this.skipFenceLF = char === '\r'
        this.emit('\n')
      }
      else {
        fence.spaces = 0
        fence.run = 0
        fence.candidate = true
        fence.tail = false
        fence.quotesRemaining = fence.quoteDepth
        fence.quoteSpace = false
      }
      return
    }
    if (!fence.candidate)
      return
    if (fence.quoteSpace) {
      fence.quoteSpace = false
      if (char === ' ' || char === '\t')
        return
    }
    if (fence.quotesRemaining) {
      if (char === ' ' && fence.spaces < 3) {
        fence.spaces++
      }
      else if (char === '>') {
        fence.quotesRemaining--
        fence.spaces = 0
        fence.quoteSpace = true
      }
      else {
        fence.candidate = false
      }
      return
    }
    if (!fence.run && char === ' ' && fence.spaces < 3) {
      fence.spaces++
      return
    }
    if (char === fence.char) {
      if (fence.tail) {
        fence.candidate = false
        return
      }
      fence.run = Math.min(Number.MAX_SAFE_INTEGER, fence.run + 1)
      return
    }
    if (fence.run >= fence.length && /[\t ]/.test(char)) {
      fence.tail = true
      return
    }
    fence.candidate = false
  }

  private inLink(char: string) {
    const link = this.link!
    if (link.stage === 'after-label') {
      if (char === '(') {
        link.stage = 'destination'
        link.destinationDepth = 1
        link.titleMayStart = false
        return
      }
      if (char === '[') {
        link.stage = 'reference'
        link.destinationDepth = 1
        return
      }
      this.link = null
      this.consume(char)
      return
    }
    if (link.escaped) {
      link.escaped = false
      if (!link.image && link.stage === 'label')
        this.emit(char)
      return
    }
    if (char === '\\') {
      link.escaped = true
      return
    }
    if (link.stage === 'reference') {
      if (char === '[')
        link.destinationDepth = Math.min(Number.MAX_SAFE_INTEGER, link.destinationDepth + 1)
      else if (char === ']' && --link.destinationDepth === 0)
        this.link = null
      return
    }
    if (link.stage === 'destination') {
      if (link.quote) {
        if (char === link.quote)
          link.quote = ''
      }
      else if ((char === '"' || char === "'") && link.titleMayStart) {
        link.quote = char
      }
      else if (char === '(') {
        link.destinationDepth = Math.min(Number.MAX_SAFE_INTEGER, link.destinationDepth + 1)
      }
      else if (char === ')' && --link.destinationDepth === 0) {
        this.link = null
      }
      link.titleMayStart = /\s/.test(char)
      return
    }
    if (char === '[') {
      link.depth = Math.min(Number.MAX_SAFE_INTEGER, link.depth + 1)
      this.appendLabel(char)
    }
    else if (char === ']' && --link.depth === 0) {
      if (!link.image)
        this.flushInlineTail()
      link.stage = 'after-label'
    }
    else {
      this.appendLabel(char)
    }
  }

  private appendLabel(char: string) {
    const link = this.link!
    if (link.image)
      return
    // Stream label prose immediately, so a later tone cue cannot inherit an
    // earlier sentence. Brackets inside a nested label are literal, not a second
    // parser context; the URL destination stays entirely in inLink().
    if (char === '[' || char === ']' || char === '!')
      this.emit(char)
    else
      this.inline(char)
  }

  private inline(char: string) {
    if (this.url) {
      this.inUrl(char)
      return
    }
    if (this.scheme) {
      const candidate = this.scheme + char
      if (URL_SCHEMES.includes(candidate.toLowerCase())) {
        this.scheme = ''
        this.url = { parentheses: 0, brackets: 0, tail: '' }
        this.emit('网址')
        return
      }
      if (URL_SCHEMES.some(scheme => scheme.startsWith(candidate.toLowerCase()))) {
        this.scheme = candidate
        return
      }
      this.emit(this.scheme)
      this.scheme = ''
      this.inline(char)
      return
    }
    if (this.ticks) {
      if (char === '`') {
        this.ticks = Math.min(Number.MAX_SAFE_INTEGER, this.ticks + 1)
        return
      }
      if (this.inlineCode) {
        if (this.ticks === this.inlineCode)
          this.inlineCode = 0
      }
      else {
        this.inlineCode = this.ticks
      }
      this.ticks = 0
    }
    if (this.underscore) {
      if (WORD.test(this.underscorePrevious) && WORD.test(char))
        this.emit('_')
      this.underscore = false
    }
    if (this.escaped) {
      this.escaped = false
      this.emit(char)
      if (char === '\n' || char === '\r')
        this.leading = true
      if (this.leading)
        this.quoteDepth = 0
      return
    }
    if (this.bang) {
      this.bang = false
      if (char === '[') {
        this.startLink(true)
        return
      }
      this.emit('!')
    }
    if (char === '\n' || char === '\r') {
      this.emit(char)
      this.leading = !this.inlineCode
      this.quoteDepth = 0
      return
    }
    if ((char === 'h' || char === 'H') && !ASCII_WORD.test(this.lastText)) {
      this.scheme = char
      return
    }
    if (char === '`') {
      this.ticks = 1
      return
    }
    if (!this.inlineCode) {
      if (char === '\\') {
        this.escaped = true
        return
      }
      if (char === '!') {
        this.bang = true
        return
      }
      if (char === '[') {
        this.startLink(false)
        return
      }
      if (char === '*')
        return
      if (char === '_') {
        this.underscore = true
        this.underscorePrevious = this.lastText
        return
      }
    }
    this.emit(char)
  }

  private startLink(image: boolean) {
    this.link = { image, depth: 1, escaped: false, stage: 'label', destinationDepth: 0, quote: '', titleMayStart: false }
    this.lastText = ''
  }

  private inUrl(char: string) {
    const url = this.url!
    if (/\s|[。！？，；：“”‘’<>"'`]/.test(char)
      || (char === ')' && !url.parentheses)
      || (char === ']' && !url.brackets)) {
      this.emit(url.tail)
      this.url = null
      this.consume(char)
      return
    }
    if (char === '(')
      url.parentheses++
    else if (char === ')')
      url.parentheses--
    else if (char === '[')
      url.brackets++
    else if (char === ']')
      url.brackets--
    if (/[.,;:!?]/.test(char))
      url.tail = (url.tail + char).slice(-MAX_URL_TAIL)
    else
      url.tail = ''
  }
}
