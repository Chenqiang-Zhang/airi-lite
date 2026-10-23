import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, rmdir, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const queues = new Map()
// Reservations started per canonical path, for snapshotLedgerLocks().
const started = new Map()
export const MAX_LEDGER_BYTES = 1_024

// Why a parsed ledger cannot be used, or null. A reservation refuses such a
// file (and the ledger then refuses until restart); the go-live checklist
// reads the files with the same rule so it can name the file, since a
// restart alone does not fix it.
export function ledgerProblem(ledger, today) {
  if (ledger?.version !== 1)
    return 'version'
  if (typeof ledger.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ledger.day)
    || new Date(`${ledger.day}T00:00:00Z`).toISOString().slice(0, 10) !== ledger.day)
    return 'day'
  if (!Number.isSafeInteger(ledger.reservedCharacters) || ledger.reservedCharacters < 0)
    return 'count'
  if (ledger.day > today)
    return 'future day'
  return null
}

export class TtsBudgetError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

// Tells a ledger lock this process might hold from another process's (the
// go-live checklist). Snapshot before reading the lock, then ask about its
// path: true if a reservation on that ledger was queued at the snapshot or
// has started since, so the lock may be this process's own.
export function snapshotLedgerLocks() {
  const queued = new Set(queues.keys())
  const counts = new Map(started)
  return (lockPath) => {
    const file = resolve(lockPath).replace(/\.lock$/, '')
    return queued.has(file) || (started.get(file) ?? 0) !== (counts.get(file) ?? 0)
  }
}

// A conservative local reservation ledger, NOT the provider's actual balance.
// All instances in this process serialize on the canonical path. An exclusive
// filesystem lock also fails closed if another process is reserving or crashed.
// A lock held by another process, or a ledger that cannot be read or written,
// leaves this instance unhealthy (refusing everything) until restart.
export function createTtsBudget({ path, dailyLimit, now = Date.now }) {
  const file = resolve(path)
  let unhealthy = false

  return {
    // false once a reservation failed closed; every later one is refused.
    healthy: () => !unhealthy,
    reserve(characters, signal) {
      started.set(file, (started.get(file) ?? 0) + 1)
      const previous = queues.get(file) ?? Promise.resolve()
      const current = previous.catch(() => {}).then(async () => {
        if (signal?.aborted)
          throw new TtsBudgetError('TTS_CANCELLED')
        if (unhealthy || !Number.isSafeInteger(dailyLimit) || dailyLimit <= 0
          || !Number.isSafeInteger(characters) || characters <= 0)
          throw new TtsBudgetError('TTS_BUDGET_UNAVAILABLE')

        const directory = dirname(file)
        const lock = `${file}.lock`
        const temporary = `${file}.${randomUUID()}.tmp`
        let locked = false
        try {
          await mkdir(directory, { recursive: true, mode: 0o700 })
          await mkdir(lock, { mode: 0o700 })
          locked = true
          const today = new Date(now()).toISOString().slice(0, 10)
          let ledger = { version: 1, day: today, reservedCharacters: 0 }
          try {
            // A bounded read prevents a corrupted/untrusted ledger from consuming memory.
            const handle = await open(file, 'r')
            try {
              if ((await handle.stat()).size > MAX_LEDGER_BYTES)
                throw new Error('Invalid ledger')
              ledger = JSON.parse(await handle.readFile('utf8'))
            }
            finally {
              await handle.close()
            }
          }
          catch (error) {
            if (error?.code !== 'ENOENT')
              throw error
          }
          if (ledgerProblem(ledger, today))
            throw new Error('Invalid ledger')
          if (ledger.day !== today)
            ledger = { version: 1, day: today, reservedCharacters: 0 }
          if (characters > dailyLimit - ledger.reservedCharacters)
            throw new TtsBudgetError('TTS_DAILY_LIMIT')
          if (signal?.aborted)
            throw new TtsBudgetError('TTS_CANCELLED')

          ledger.reservedCharacters += characters
          const handle = await open(temporary, 'wx', 0o600)
          try {
            await handle.writeFile(`${JSON.stringify(ledger)}\n`)
            await handle.sync()
          }
          finally {
            await handle.close()
          }
          await rename(temporary, file)
          const directoryHandle = await open(directory, 'r')
          try {
            await directoryHandle.sync()
          }
          finally {
            await directoryHandle.close()
          }
          // No refund after this point, even if aborted before/during fetch: the
          // upstream might have already charged and retries must be conservative.
          return { day: today, reserved: ledger.reservedCharacters }
        }
        catch (error) {
          if (error instanceof TtsBudgetError)
            throw error
          unhealthy = true
          throw new TtsBudgetError('TTS_BUDGET_UNAVAILABLE')
        }
        finally {
          await unlink(temporary).catch(() => {})
          if (locked) {
            try {
              await rmdir(lock)
            }
            catch {
              unhealthy = true
              throw new TtsBudgetError('TTS_BUDGET_UNAVAILABLE')
            }
          }
        }
      })
      queues.set(file, current)
      current.finally(() => {
        if (queues.get(file) === current)
          queues.delete(file)
      }).catch(() => {})
      return current
    },
    // Today's reserved total for display only: no lock, a bounded read, and
    // null when the ledger cannot be read. Never used to decide spending.
    async peek() {
      const today = new Date(now()).toISOString().slice(0, 10)
      try {
        const handle = await open(file, 'r')
        try {
          if ((await handle.stat()).size > MAX_LEDGER_BYTES)
            return null
          const ledger = JSON.parse(await handle.readFile('utf8'))
          if (!Number.isSafeInteger(ledger?.reservedCharacters) || typeof ledger.day !== 'string')
            return null
          return { day: today, reserved: ledger.day === today ? ledger.reservedCharacters : 0 }
        }
        finally {
          await handle.close()
        }
      }
      catch (error) {
        return error?.code === 'ENOENT' ? { day: today, reserved: 0 } : null
      }
    },
  }
}
