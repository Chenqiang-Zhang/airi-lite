// Zero-cost live rehearsal: the real request handler, live runtime and brain,
// with a fake TTS (macOS `say`, or a sine-wave tone on Windows/Linux, see
// scripts/mock-tts.mjs) standing in for cloud TTS and canned replies standing
// in for DeepSeek. Loopback only; reads no .env.local, calls no DeepSeek,
// MiniMax or Bilibili, and prints only character counts.
//
//   node scripts/mock-live.mjs [--replay] [--speed=N] [--adversarial] [--tone]
//
// --replay plays server/live/fixtures/rehearsal.jsonl (30 synthetic minutes;
// --speed=10 makes it 3) into the approval queue. --adversarial makes every
// other fake reply something the output gate must stop. --tone uses the
// sine-wave voice even where `say` exists. Ledgers, a sample blocklist and
// the audit log live in a temporary directory that is deleted on exit.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createViteServer } from 'vite'

import { createRequestHandler, readServerConfig } from '../server/app.mjs'
import { createFakeDeepSeek } from '../server/live/fake-deepseek.mjs'
import { createLiveRuntime } from '../server/live/runtime.mjs'
import { createFixtureSource, loadFixture } from '../server/live/sources/fixture.mjs'
import { chooseSayVoice, createMockSpeech, parseMockLatency } from './mock-tts.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const port = Number(process.env.MOCK_LIVE_PORT ?? 4176)
const workDirectory = await mkdtemp(join(tmpdir(), 'airi-mock-live-'))
const replay = process.argv.includes('--replay')
const adversarial = process.argv.includes('--adversarial')
const speedArgument = process.argv.find(argument => argument.startsWith('--speed='))
const speed = speedArgument ? Math.min(100, Math.max(0.1, Number(speedArgument.slice('--speed='.length)) || 1)) : 1
const fakeDeepSeek = createFakeDeepSeek({ adversarial, delayMs: 600 })

const voice = process.argv.includes('--tone') ? null : await chooseSayVoice()
const speech = createMockSpeech({ voice, workDirectory, latency: parseMockLatency(process.env.MOCK_TTS_LATENCY_MS) })
// The go-live checklist wants a host blocklist; give the rehearsal a sample.
await mkdir(join(workDirectory, '.data', 'moderation'), { recursive: true, mode: 0o700 })
await writeFile(join(workDirectory, '.data', 'moderation', 'blocklist.txt'), '# mock-live sample\n彩排屏蔽词\n', { mode: 0o600 })

const vite = await createViteServer({ root, envDir: false, appType: 'spa', server: { middlewareMode: true } })
const fixture = replay ? await loadFixture(fileURLToPath(new URL('../server/live/fixtures/rehearsal.jsonl', import.meta.url))) : null
const handler = createRequestHandler({
  // The visitor chat stays unconfigured (local fallback), as before.
  env: {},
  config: readServerConfig({ PORT: String(port) }),
  root: workDirectory,
  vite,
  fetchImpl: async () => { throw new Error('mock-live chat never calls DeepSeek') },
  speech,
  // The placeholder key and the canned fake go only to the live brain; no
  // "DeepSeek" request ever leaves this process.
  live: (deps) => {
    const runtime = createLiveRuntime({
      ...deps,
      // Like `npm run live`: the rehearsal goes live through the checklist.
      startPaused: true,
      env: { DEEPSEEK_API_KEY: 'mock-only' },
      fetchImpl: fakeDeepSeek.fetch,
    })
    // The replay starts at the first 继续, not at boot: otherwise stage setup
    // and the checklist would pile the first minutes up into a backlog the
    // brain answers three at a time, unlike the paced stream it rehearses.
    if (fixture) {
      const source = createFixtureSource({
        entries: fixture,
        speed,
        onEvent: event => runtime.hub.publish(`input.${event.type}`, event, { source: 'fixture' }),
      })
      const detach = runtime.hub.subscribe('control.changed', (event) => {
        if (event.data?.control !== 'running')
          return
        detach()
        source.start()
      })
      const stopRuntime = runtime.stop
      runtime.stop = async () => {
        source.stop()
        return stopRuntime()
      }
    }
    return runtime
  },
})
const server = createServer(handler)
server.listen(port, '127.0.0.1', () => {
  console.log(`MOCK LIVE ONLY (voice: ${voice ? `say ${voice}` : 'sine-wave tone'}; fake DeepSeek${adversarial ? ', adversarial' : ''}; no provider charges)`)
  if (fixture)
    console.log(`  replaying ${fixture.length} synthetic events at ${speed}x from the first 继续; approve them in the console`)
  console.log(`  ledgers, blocklist and audit log (deleted on exit): ${join(workDirectory, '.data')}`)
  console.log(`  stage:   http://127.0.0.1:${port}/airi/stage.html?role=obs`)
  console.log(`  preview: http://127.0.0.1:${port}/airi/stage.html?role=preview`)
  console.log(`  console: http://127.0.0.1:${port}/airi/console.html`)
  console.log('  starts paused: press 继续 in the console (it runs the go-live checklist)')
})

async function stop() {
  await handler.stop()
  server.closeAllConnections()
  server.close()
  await vite.close()
  await rm(workDirectory, { recursive: true, force: true }) // Only this mkdtemp result.
  process.exit(0)
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
