const ALLOWED_DELIVERIES = new Set(['neutral', 'soft', 'bright', 'curious'])
const TAG_START = '[[tone:'
const MAX_TAG_LENGTH = 48
const MAX_OPENING_WHITESPACE = 32

function trailingTagPrefix(content) {
  for (let length = Math.min(TAG_START.length - 1, content.length); length > 0; length--) {
    if (content.endsWith(TAG_START.slice(0, length)))
      return length
  }
  return 0
}

// Hold only a possible marker (plus a small amount of opening whitespace).
// Everything else streams immediately, including line breaks between sentences.
export function createDeliveryCueParser() {
  let pending = ''
  let atBeginning = true
  let trimInitialBody = false

  return {
    push(content) {
      let rest = pending + content
      pending = ''
      const events = []
      const emitText = (text) => {
        if (!text)
          return
        atBeginning = false
        const previous = events.at(-1)
        if (previous?.type === 'delta')
          previous.content += text
        else
          events.push({ type: 'delta', content: text })
      }
      const isOpeningWhitespace = text => atBeginning && text.length <= MAX_OPENING_WHITESPACE && !text.trim()

      while (rest) {
        if (trimInitialBody) {
          rest = rest.trimStart()
          if (!rest)
            break
          trimInitialBody = false
        }

        const markerIndex = rest.indexOf(TAG_START)
        if (markerIndex < 0) {
          const prefixLength = trailingTagPrefix(rest)
          const body = rest.slice(0, rest.length - prefixLength)
          // Keep leading whitespace only while an opening marker is possible.
          if (isOpeningWhitespace(body)) {
            pending = rest
          }
          else {
            emitText(body)
            pending = rest.slice(rest.length - prefixLength)
          }
          break
        }

        const before = rest.slice(0, markerIndex)
        const candidate = rest.slice(markerIndex)
        const firstBracket = candidate.indexOf(']', TAG_START.length)
        const closingIndex = candidate.indexOf(']]', TAG_START.length)
        const complete = closingIndex >= 0 && firstBracket === closingIndex && closingIndex + 2 <= MAX_TAG_LENGTH

        if (complete) {
          const openingTag = isOpeningWhitespace(before)
          if (!openingTag)
            emitText(before)
          const value = candidate.slice(TAG_START.length, closingIndex)
          if (ALLOWED_DELIVERIES.has(value))
            events.push({ type: 'delivery', value })
          atBeginning = false
          trimInitialBody = openingTag
          rest = candidate.slice(closingIndex + 2)
          continue
        }

        const possibleClose = firstBracket < 0 || firstBracket === candidate.length - 1
        if (possibleClose && candidate.length < MAX_TAG_LENGTH) {
          if (isOpeningWhitespace(before))
            pending = before + candidate
          else {
            emitText(before)
            pending = candidate
          }
          break
        }

        // Malformed or oversized candidates are ordinary text. Re-scan after
        // the first character so a later valid marker can still be recognized.
        emitText(before + candidate[0])
        rest = candidate.slice(1)
      }
      return events
    },
    finish() {
      const events = pending ? [{ type: 'delta', content: pending }] : []
      pending = ''
      atBeginning = false
      return events
    },
  }
}
