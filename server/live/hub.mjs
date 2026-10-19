import { randomUUID } from 'node:crypto'

// In-process event bus for the live subsystem. Every event is an AIRI-style
// envelope; sources (fixture, console, Bilibili) publish `input.*`, the
// brain `brain.*`, the runtime `turn.*` and `control.*`. The audit log
// subscribes to everything. One failing subscriber never stops the others.
export function makeEvent({ type, source, data = {}, parentId, id = randomUUID(), ts = Date.now() }) {
  return Object.freeze({ id, type, source, ts, ...(parentId ? { parentId } : {}), data })
}

export function createHub({ now = Date.now, newId = randomUUID, onError = error => console.error('Live hub subscriber failed', error) } = {}) {
  const subscribers = new Set()

  const report = (error) => {
    try { onError(error) }
    catch {}
  }

  return {
    publish(type, data = {}, { source = 'runtime', parentId } = {}) {
      const event = makeEvent({ type, source, data, parentId, id: newId(), ts: now() })
      for (const subscriber of [...subscribers]) {
        if (!subscribers.has(subscriber))
          continue
        if (subscriber.prefix && type !== subscriber.prefix && !type.startsWith(`${subscriber.prefix}.`))
          continue
        try {
          const result = subscriber.handler(event)
          if (result && typeof result.then === 'function')
            result.then(undefined, report)
        }
        catch (error) {
          report(error)
        }
      }
      return event
    },
    // prefix '' receives everything; 'input' receives input.* and 'input'.
    subscribe(prefix, handler) {
      const subscriber = { prefix, handler }
      subscribers.add(subscriber)
      return () => subscribers.delete(subscriber)
    },
    get size() { return subscribers.size },
  }
}
