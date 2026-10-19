// Candidate messages the brain may answer. Stage 1 is manual: viewer items
// wait for the host's approval and never reach the model otherwise; the
// host's own interjections are approved on arrival. Priority is Super Chat,
// then host, then danmaku; within a priority, oldest first.
const PRIORITY = { superchat: 3, host: 2, danmaku: 1 }
const DEFAULT_TTL_MS = { superchat: 10 * 60_000, host: 10 * 60_000, danmaku: 2 * 60_000 }
const OPEN = new Set(['pending', 'approved'])
const MAX_TEXT = 200
const MAX_SEEN = 2_048

export const CANDIDATE_KINDS = Object.keys(PRIORITY)

export function createCandidateQueue({
  now = Date.now,
  newId,
  maxOpen = 50,
  maxHistory = 50,
  ttlMs = DEFAULT_TTL_MS,
} = {}) {
  const items = new Map()
  const history = []
  const seen = new Set()
  const listeners = new Set()

  function notify(item, change) {
    for (const listener of [...listeners]) {
      try { listener(item, change) }
      catch (error) { console.error('Queue listener failed', error) }
    }
  }

  function resolve(item, status, detail) {
    items.delete(item.id)
    item.status = status
    item.resolvedAt = now()
    if (detail)
      item.detail = detail
    history.push(item)
    if (history.length > maxHistory)
      history.splice(0, history.length - maxHistory)
    notify(item, status)
  }

  function expire() {
    const time = now()
    for (const item of [...items.values()]) {
      if (OPEN.has(item.status) && item.expiresAt <= time)
        resolve(item, 'expired')
    }
  }

  function remember(msgId) {
    seen.add(msgId)
    if (seen.size > MAX_SEEN)
      seen.delete(seen.values().next().value)
  }

  // Lowest priority, then oldest, open item: what to drop when full.
  function weakest() {
    let candidate = null
    for (const item of items.values()) {
      if (!OPEN.has(item.status))
        continue
      if (!candidate || item.priority < candidate.priority
        || (item.priority === candidate.priority && item.receivedAt < candidate.receivedAt))
        candidate = item
    }
    return candidate
  }

  return {
    // Accepts a normalised input (the shape server/bilibili/events.mjs and
    // the fixture source emit). Returns the queued item, or null if ignored.
    add({ kind, msgId = null, user = null, text = '', amountCny = 0, emoji = null, mirror = false }) {
      if (!Object.hasOwn(PRIORITY, kind) || typeof text !== 'string')
        return null
      // Sticker danmaku and cross-room mirrors carry no answerable text.
      if (emoji || mirror || !text.trim())
        return null
      if (msgId) {
        if (seen.has(msgId))
          return null
        remember(msgId)
      }
      expire()
      const time = now()
      const item = {
        id: newId(),
        kind,
        msgId,
        user: user ? {
          openId: String(user.openId ?? ''),
          name: String(user.name ?? ''),
          guardLevel: Number(user.guardLevel) || 0,
          medalLevel: Number(user.medalLevel) || 0,
          isAdmin: Boolean(user.isAdmin),
        } : null,
        text: text.slice(0, MAX_TEXT),
        amountCny: Number(amountCny) > 0 ? Number(amountCny) : 0,
        priority: PRIORITY[kind],
        receivedAt: time,
        expiresAt: time + (ttlMs[kind] ?? DEFAULT_TTL_MS[kind]),
        status: kind === 'host' ? 'approved' : 'pending',
      }
      while (items.size >= maxOpen) {
        const drop = weakest()
        // Never displace a stronger message to admit a weaker one.
        if (!drop || drop.priority > item.priority)
          return null
        resolve(drop, 'dropped', 'queue-full')
      }
      items.set(item.id, item)
      notify(item, 'added')
      return item
    },
    approve(id) {
      expire()
      const item = items.get(id)
      if (!item || item.status !== 'pending')
        return false
      item.status = 'approved'
      notify(item, 'approved')
      return true
    },
    reject(id) {
      const item = items.get(id)
      if (!item || !OPEN.has(item.status))
        return false
      resolve(item, 'rejected')
      return true
    },
    // Hands up to `max` approved items to the brain, strongest first.
    take(max = 3) {
      expire()
      const batch = [...items.values()]
        .filter(item => item.status === 'approved')
        .sort((a, b) => b.priority - a.priority || a.receivedAt - b.receivedAt)
        .slice(0, max)
      for (const item of batch) {
        item.status = 'answering'
        notify(item, 'answering')
      }
      return batch
    },
    // Taken items end as answered, blocked (output gate) or failed. Failed
    // items are not retried, so a broken upstream cannot loop on them.
    complete(ids, status, detail) {
      for (const id of ids) {
        const item = items.get(id)
        if (item && item.status === 'answering')
          resolve(item, status, detail)
      }
    },
    // A screened reply could not be spoken because the host's own line was
    // on stage: hand the items back, approved, to be answered after it.
    release(ids) {
      for (const id of ids) {
        const item = items.get(id)
        if (item && item.status === 'answering') {
          item.status = 'approved'
          notify(item, 'approved')
        }
      }
    },
    // Panic: every waiting candidate is dropped; nothing approved before the
    // emergency is answered after it. Items being answered are left to the
    // brain, which fails them when its aborted generation unwinds.
    clearOpen(detail) {
      for (const item of [...items.values()]) {
        if (OPEN.has(item.status))
          resolve(item, 'dropped', detail)
      }
    },
    hasApproved() {
      expire()
      return [...items.values()].some(item => item.status === 'approved')
    },
    snapshot() {
      expire()
      const open = [...items.values()].sort((a, b) => b.priority - a.priority || a.receivedAt - b.receivedAt)
      return { open: open.map(item => ({ ...item })), recent: history.slice(-20).reverse().map(item => ({ ...item })) }
    },
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
