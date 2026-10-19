import { readFile } from 'node:fs/promises'

// Replays a scripted, synthetic stream of viewer events for rehearsal. It
// emits the same shape as server/bilibili/events.mjs, so the brain cannot
// tell a rehearsal from the real room (and M5 only swaps the source).
// Fixture lines: {"atMs": 30000, "kind": "danmaku", "user": {...}, "text": "..."}.
const KINDS = new Set(['danmaku', 'superchat', 'gift', 'guard', 'like', 'enter'])

export function parseFixture(source) {
  const entries = []
  for (const [index, raw] of String(source).split('\n').entries()) {
    const line = raw.trim()
    if (!line || line.startsWith('//'))
      continue
    let value
    try { value = JSON.parse(line) }
    catch { throw new SyntaxError(`fixture line ${index + 1} is not JSON`) }
    if (!Number.isFinite(value.atMs) || value.atMs < 0 || !KINDS.has(value.kind))
      throw new SyntaxError(`fixture line ${index + 1} needs atMs >= 0 and a known kind`)
    entries.push(value)
  }
  return entries.sort((a, b) => a.atMs - b.atMs)
}

export async function loadFixture(path) {
  return parseFixture(await readFile(path, 'utf8'))
}

export function createFixtureSource({
  entries,
  onEvent,
  now = Date.now,
  timers = { setTimeout, clearTimeout },
  speed = 1,
  loop = false,
}) {
  const handles = new Set()
  let cycle = 0
  let running = false

  function emit(entry, index) {
    const user = entry.user ?? {}
    onEvent({
      type: entry.kind,
      cmd: 'FIXTURE',
      // Unique per replay cycle, so a looped rehearsal is not deduplicated.
      msgId: `fixture-${cycle}-${index}`,
      ts: now(),
      roomId: null,
      user: {
        openId: String(user.openId ?? `fixture-viewer-${index}`),
        name: String(user.name ?? ''),
        face: '',
        guardLevel: Number(user.guardLevel) || 0,
        medalName: String(user.medalName ?? ''),
        medalLevel: Number(user.medalLevel) || 0,
        isAdmin: Boolean(user.isAdmin),
      },
      text: String(entry.text ?? ''),
      emoji: entry.emoji ? { url: '' } : null,
      amountCny: Number(entry.amountCny) > 0 ? Number(entry.amountCny) : 0,
      ...(entry.gift ? { gift: entry.gift } : {}),
    })
  }

  function schedule() {
    const total = entries.at(-1)?.atMs ?? 0
    entries.forEach((entry, index) => {
      const handle = timers.setTimeout(() => {
        handles.delete(handle)
        if (running) emit(entry, index)
      }, entry.atMs / speed)
      handle?.unref?.()
      handles.add(handle)
    })
    if (loop) {
      const handle = timers.setTimeout(() => {
        handles.delete(handle)
        if (!running) return
        cycle++
        schedule()
      }, (total + 1_000) / speed)
      handle?.unref?.()
      handles.add(handle)
    }
  }

  return {
    start() {
      if (running) return
      running = true
      schedule()
    },
    stop() {
      running = false
      for (const handle of handles)
        timers.clearTimeout(handle)
      handles.clear()
    },
    get running() { return running },
  }
}
