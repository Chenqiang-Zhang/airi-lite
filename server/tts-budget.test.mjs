import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

import { createTtsBudget } from './tts-budget.mjs'

const day = () => Date.parse('2026-10-01T12:00:00Z')
async function setup(context) {
  const directory = await mkdtemp(join(tmpdir(), 'airi-tts-budget-test-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  return join(directory, '.data', 'tts-budget.json')
}

test('budget serializes concurrent reservations across instances before exceeding the limit', async (context) => {
  const path = await setup(context)
  const a = createTtsBudget({ path, dailyLimit: 20, now: day })
  const b = createTtsBudget({ path, dailyLimit: 20, now: day })
  const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).reserve(4)))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 5)
  assert.deepEqual(results.filter(result => result.status === 'rejected').map(result => result.reason.code),
    Array(5).fill('TTS_DAILY_LIMIT'))
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
    version: 1, day: '2026-10-01', reservedCharacters: 20,
  })
})

test('persisted reservations survive a new process and UTC day rollover uses the injected clock', async (context) => {
  const path = await setup(context)
  await createTtsBudget({ path, dailyLimit: 10, now: day }).reserve(8)
  const moduleUrl = new URL('./tts-budget.mjs', import.meta.url).href
  const script = `import { createTtsBudget } from ${JSON.stringify(moduleUrl)};
    try { await createTtsBudget({path: ${JSON.stringify(path)}, dailyLimit: 10,
      now: () => Date.parse('2026-10-01T23:59:59Z')}).reserve(4); process.exitCode = 1 }
    catch (error) { if (error.code !== 'TTS_DAILY_LIMIT') process.exitCode = 2 }`
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script])
  const nextDay = createTtsBudget({ path, dailyLimit: 10, now: () => Date.parse('2026-10-02T00:00:00Z') })
  await nextDay.reserve(4)
  assert.equal(JSON.parse(await readFile(path, 'utf8')).reservedCharacters, 4)
  assert.equal(JSON.parse(await readFile(path, 'utf8')).day, '2026-10-02')
})

test('corrupted, future-dated, unreadable, oversized and write-failing ledgers fail closed', async (context) => {
  for (const contents of ['broken', '{}', '{"version":1,"day":"2026-02-30","reservedCharacters":0}',
    '{"version":1,"day":"2026-10-02","reservedCharacters":0}',
    '{"version":1,"day":"2026-10-01","reservedCharacters":-1}', ' '.repeat(1_100)]) {
    const path = await setup(context)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, contents)
    const budget = createTtsBudget({ path, dailyLimit: 10, now: day })
    await assert.rejects(budget.reserve(2), { code: 'TTS_BUDGET_UNAVAILABLE' })
    assert.equal(await readFile(path, 'utf8'), contents)
    await writeFile(path, '{"version":1,"day":"2026-10-01","reservedCharacters":0}')
    await assert.rejects(budget.reserve(2), { code: 'TTS_BUDGET_UNAVAILABLE' })
  }
  const unreadable = await setup(context)
  await mkdir(unreadable, { recursive: true })
  await assert.rejects(createTtsBudget({ path: unreadable, dailyLimit: 10, now: day }).reserve(2),
    { code: 'TTS_BUDGET_UNAVAILABLE' })
  const blocked = await setup(context)
  await writeFile(join(blocked, '..'), 'not a directory')
  await assert.rejects(createTtsBudget({ path: blocked, dailyLimit: 10, now: day }).reserve(2),
    { code: 'TTS_BUDGET_UNAVAILABLE' })
})

test('exclusive on-disk locks fail closed instead of overwriting another reservation', async (context) => {
  const path = await setup(context)
  await mkdir(`${path}.lock`, { recursive: true })
  await assert.rejects(createTtsBudget({ path, dailyLimit: 10, now: day }).reserve(2),
    { code: 'TTS_BUDGET_UNAVAILABLE' })
})

test('cancel before reservation does not write, cancellation after reservation never refunds', async (context) => {
  const path = await setup(context)
  const budget = createTtsBudget({ path, dailyLimit: 10, now: day })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(budget.reserve(4, controller.signal), { code: 'TTS_CANCELLED' })
  await assert.rejects(readFile(path), { code: 'ENOENT' })
  await budget.reserve(8)
  await assert.rejects(createTtsBudget({ path, dailyLimit: 10, now: day }).reserve(4), { code: 'TTS_DAILY_LIMIT' })
})
