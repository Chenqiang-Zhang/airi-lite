import { appendFile, mkdir, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

// Every hub event, one JSON line per event, in .data/live-logs/<UTC date>.jsonl.
// The log keeps raw viewer names and texts for after-the-fact review, so the
// directory is owner-only and files older than the retention are deleted at
// startup. Writes are serialised; a failed write is reported, never thrown
// into the live path.
const LOG_NAME = /^(\d{4}-\d{2}-\d{2})\.jsonl$/
const DAY_MS = 24 * 60 * 60 * 1_000

export function createAuditLog({
  directory,
  now = Date.now,
  retentionDays = 183,
  fs = { appendFile, mkdir, readdir, unlink },
  onError = error => console.error('Live audit log write failed', error?.code ?? error),
}) {
  let chain = Promise.resolve()
  let ready = null

  function start() {
    ready ??= (async () => {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 })
      const cutoff = now() - retentionDays * DAY_MS
      for (const name of await fs.readdir(directory)) {
        const match = LOG_NAME.exec(name)
        if (match && Date.parse(`${match[1]}T00:00:00Z`) + DAY_MS <= cutoff)
          await fs.unlink(join(directory, name)).catch(onError)
      }
    })().catch((error) => {
      onError(error)
      ready = null
    })
    return ready
  }

  function record(event) {
    const line = `${JSON.stringify(event)}\n`
    const file = join(directory, `${new Date(event.ts ?? now()).toISOString().slice(0, 10)}.jsonl`)
    chain = chain
      .then(() => start())
      .then(() => fs.appendFile(file, line, { mode: 0o600 }))
      .catch(onError)
    return chain
  }

  return {
    start,
    record,
    attach: hub => hub.subscribe('', record),
    flush: () => chain,
  }
}
