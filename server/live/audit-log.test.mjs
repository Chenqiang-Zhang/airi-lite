import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createAuditLog } from './audit-log.mjs'
import { createHub } from './hub.mjs'

async function temporary(context) {
  const directory = await mkdtemp(join(tmpdir(), 'airi-audit-test-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  return join(directory, 'live-logs')
}

test('every hub event becomes one JSON line in an owner-only file named by UTC date', async (context) => {
  const directory = await temporary(context)
  let time = Date.parse('2026-10-19T23:59:59Z')
  const hub = createHub({ now: () => time })
  const log = createAuditLog({ directory, now: () => time })
  log.attach(hub)
  hub.publish('input.danmaku', { user: { name: '甲' }, text: '你好' }, { source: 'fixture' })
  time = Date.parse('2026-10-20T00:00:01Z')
  hub.publish('brain.blocked', { reason: 'url', text: 'www.example.com' })
  await log.flush()
  assert.deepEqual((await readdir(directory)).sort(), ['2026-10-19.jsonl', '2026-10-20.jsonl'])
  const [first] = (await readFile(join(directory, '2026-10-19.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(first.type, 'input.danmaku')
  assert.equal(first.source, 'fixture')
  assert.equal(first.data.text, '你好')
  assert.equal((await stat(directory)).mode & 0o777, 0o700)
  assert.equal((await stat(join(directory, '2026-10-20.jsonl'))).mode & 0o777, 0o600)
})

test('startup deletes logs past the retention and keeps everything else', async (context) => {
  const directory = await temporary(context)
  await mkdir(directory, { recursive: true })
  for (const name of ['2026-04-18.jsonl', '2026-04-19.jsonl', '2026-10-18.jsonl', 'notes.txt'])
    await writeFile(join(directory, name), '')
  const log = createAuditLog({ directory, now: () => Date.parse('2026-10-19T12:00:00Z'), retentionDays: 183 })
  await log.start()
  assert.deepEqual((await readdir(directory)).sort(), ['2026-04-19.jsonl', '2026-10-18.jsonl', 'notes.txt'])
})

test('write failures are reported and never thrown into the live path', async () => {
  const errors = []
  const log = createAuditLog({
    directory: '/unused',
    fs: { mkdir: async () => {}, readdir: async () => [], unlink: async () => {}, appendFile: async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) } },
    onError: error => errors.push(error.code),
  })
  const hub = createHub()
  log.attach(hub)
  assert.doesNotThrow(() => hub.publish('turn.started', {}))
  await log.flush()
  assert.deepEqual(errors, ['ENOSPC'])
})
