import { isAct, normaliseEmotion } from '../shared/performance-cues.mjs'

// Hidden markers in a model reply: [[tone:x]] changes the voice and face
// from here on; [[act:x]] is a one-off laugh, sigh or pause just before the
// words that follow. Both are removed from the text.
const TONE_START = '[[tone:'
const ACT_START = '[[act:'
const TAG_STARTS = [TONE_START, ACT_START]
const MAX_TAG_LENGTH = 48
const MAX_OPENING_WHITESPACE = 32

function trailingTagPrefix(content) {
  let longest = 0
  for (const start of TAG_STARTS) {
    for (let length = Math.min(start.length - 1, content.length); length > longest; length--) {
      if (content.endsWith(start.slice(0, length))) {
        longest = length
        break
      }
    }
  }
  return longest
}

function nextMarker(content) {
  let found = null
  for (const start of TAG_STARTS) {
    const index = content.indexOf(start)
    if (index >= 0 && (!found || index < found.index))
      found = { index, start }
  }
  return found
}

// Hold only a possible marker (plus a small amount of opening whitespace).
// Everything else streams immediately, including line breaks between sentences.
// Events: {type:'delta', content}, {type:'delivery', value} (canonical, so
// an old [[tone:bright]] arrives as 'happy'), and {type:'act', value} for the
// first valid act only. Unknown values and later acts are dropped silently:
// left in the text they would read as leaked markup.
export function createDeliveryCueParser() {
  let pending = ''
  let atBeginning = true
  let trimInitialBody = false
  let actEmitted = false
  let bodyStarted = false // any reply text emitted yet

  return {
    push(content) {
      let rest = pending + content
      pending = ''
      const events = []
      const emitText = (text) => {
        if (!text)
          return
        atBeginning = false
        bodyStarted = true
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

        const marker = nextMarker(rest)
        if (!marker) {
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

        const before = rest.slice(0, marker.index)
        const candidate = rest.slice(marker.index)
        const firstBracket = candidate.indexOf(']', marker.start.length)
        const closingIndex = candidate.indexOf(']]', marker.start.length)
        const complete = closingIndex >= 0 && firstBracket === closingIndex && closingIndex + 2 <= MAX_TAG_LENGTH

        if (complete) {
          const value = candidate.slice(marker.start.length, closingIndex)
          if (marker.start === TONE_START) {
            const openingTag = isOpeningWhitespace(before)
            if (!openingTag)
              emitText(before)
            const delivery = normaliseEmotion(value)
            if (delivery)
              events.push({ type: 'delivery', value: delivery })
            atBeginning = false
            trimInitialBody = openingTag
          }
          else {
            // An act before any reply text (alone, or after the opening
            // tone) is still the opening: no leading space reaches the text.
            const leading = !bodyStarted && before.length <= MAX_OPENING_WHITESPACE && !before.trim()
            if (!leading)
              emitText(before)
            if (isAct(value) && !actEmitted) {
              actEmitted = true
              events.push({ type: 'act', value })
            }
            trimInitialBody ||= leading
          }
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
