const ALLOWED_DELIVERIES = new Set(['neutral', 'soft', 'bright', 'curious'])
const TAG_START = '[[tone:'

function contentEvent(content) {
  return content ? [{ type: 'delta', content }] : []
}

function afterTag(content) {
  return content.trimStart()
}

// DeepSeek may split the opening marker at any token boundary. Buffer only
// while it can still be a marker; ordinary text should keep streaming at once.
export function createDeliveryCueParser() {
  let pending = ''
  let decided = false
  let trimBodyStart = false

  return {
    push(content) {
      if (decided) {
        if (trimBodyStart) {
          content = content.trimStart()
          if (content)
            trimBodyStart = false
        }
        return contentEvent(content)
      }

      pending += content
      const trimmed = pending.trimStart()
      if (!trimmed && pending.length <= 32)
        return []

      const tag = /^\[\[tone:([^\]]{1,32})\]\]/.exec(trimmed)
      if (tag) {
        decided = true
        trimBodyStart = true
        const events = []
        if (ALLOWED_DELIVERIES.has(tag[1]))
          events.push({ type: 'delivery', value: tag[1] })
        const firstBody = afterTag(trimmed.slice(tag[0].length))
        if (firstBody)
          trimBodyStart = false
        events.push(...contentEvent(firstBody))
        pending = ''
        return events
      }

      if ((TAG_START.startsWith(trimmed) || (trimmed.startsWith(TAG_START) && !trimmed.includes(']]'))) && trimmed.length <= 48)
        return []

      decided = true
      const events = contentEvent(pending)
      pending = ''
      return events
    },
    finish() {
      const events = contentEvent(pending)
      pending = ''
      decided = true
      return events
    },
  }
}
