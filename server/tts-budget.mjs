import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, rmdir, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const queues = new Map()
const MAX_FILE_BYTES = 1_024

export class TtsBudgetError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

// A conservative local reservation ledger, NOT the provider's actual balance.
// All instances in this process serialize on the canonical path. An exclusive
// filesystem lock also fails closed if another process is reserving or crashed.
export function createTtsBudget({ path, dailyLimit, now = Date.now }) {
  const file = resolve(path)
  let unhealthy = false

  return {
    reserve(characters, signal) {
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
              if ((await handle.stat()).size > MAX_FILE_BYTES)
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
          if (ledger?.version !== 1 || typeof ledger.day !== 'string'
            || !/^\d{4}-\d{2}-\d{2}$/.test(ledger.day)
            || new Date(`${ledger.day}T00:00:00Z`).toISOString().slice(0, 10) !== ledger.day
            || !Number.isSafeInteger(ledger.reservedCharacters) || ledger.reservedCharacters < 0
            || ledger.day > today)
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
  }
}
