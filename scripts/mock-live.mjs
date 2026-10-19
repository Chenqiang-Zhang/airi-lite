// Zero-cost live rehearsal: the real request handler and live runtime, with
// macOS `say` standing in for cloud TTS. Loopback only; reads no .env.local,
// calls no DeepSeek/MiniMax/Bilibili, and prints only character counts.
//
// MOCK ONLY: the returned clip is a WAV labelled `format: 'mp3'` on purpose.
// There is no MP3 encoder on this machine, and the real MiniMax path validates
// MPEG frames server-side (server/minimax.mjs validateMp3), which this fake
// bypasses. Chromium's decodeAudioData sniffs the content, so the stage still
// decodes it. Never reuse this shortcut outside rehearsal.
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createServer as createViteServer } from 'vite'

import { createRequestHandler, readServerConfig } from '../server/app.mjs'
import { createLiveRuntime } from '../server/live/runtime.mjs'
import { SpeechProviderError } from '../server/speech-error.mjs'

const run = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const port = Number(process.env.MOCK_LIVE_PORT ?? 4176)
const SAMPLE_RATE = 32_000
const workDirectory = await mkdtemp(join(tmpdir(), 'airi-mock-live-'))
let clips = 0

async function chooseVoice() {
  if (process.env.MOCK_SAY_VOICE)
    return process.env.MOCK_SAY_VOICE
  try {
    const { stdout } = await run('/usr/bin/say', ['-v', '?'])
    // Lines look like "Eddy (中文（中国大陆）)     zh_CN    # 你好！"
    for (const line of stdout.split('\n')) {
      const match = /^(.+?)\s{2,}zh_CN\s/.exec(line)
      if (match) return match[1].trim()
    }
  }
  catch {}
  return null
}

// One second of amplitude-modulated sine, comfortably above the stage's
// silence threshold, for machines where `say` is unavailable.
function toneWav(seconds = 1) {
  const count = Math.round(seconds * SAMPLE_RATE)
  const buffer = Buffer.alloc(44 + count * 2)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + count * 2, 4)
  buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(SAMPLE_RATE, 24)
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(count * 2, 40)
  for (let index = 0; index < count; index++) {
    const time = index / SAMPLE_RATE
    const envelope = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * time)
    buffer.writeInt16LE(Math.round(0.35 * envelope * Math.sin(2 * Math.PI * 220 * time) * 32_767), 44 + index * 2)
  }
  return buffer
}

const voice = await chooseVoice()
const speech = {
  health: () => ({ configured: true, provider: 'minimax', model: 'mock-say', region: 'cn' }),
  // The public /api/speech route is not part of this rehearsal.
  async handle(_request, response) {
    response.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify({ code: 'MOCK_NO_PUBLIC_SPEECH' }))
  },
  async synthesise({ text, delivery }, { signal } = {}) {
    if (typeof text !== 'string' || !text.trim())
      throw new SpeechProviderError('TTS_INVALID_REQUEST')
    const id = ++clips
    const textFile = join(workDirectory, `clip-${id}.txt`)
    const wavFile = join(workDirectory, `clip-${id}.wav`)
    let audio
    try {
      if (!voice)
        throw new Error('no zh_CN say voice')
      await writeFile(textFile, text, { mode: 0o600 })
      // execFile, not a shell: the text never becomes command syntax.
      await run('/usr/bin/say', ['-v', voice, '-f', textFile, '-o', wavFile,
        '--file-format=WAVE', `--data-format=LEI16@${SAMPLE_RATE}`], { signal })
      audio = await readFile(wavFile)
    }
    catch (error) {
      if (signal?.aborted)
        throw error
      audio = toneWav()
    }
    finally {
      await rm(textFile, { force: true })
      await rm(wavFile, { force: true })
    }
    console.log(JSON.stringify({ mockClip: id, delivery, characters: text.length, bytes: audio.length }))
    return { audio: audio.toString('base64'), format: 'mp3', sampleRate: SAMPLE_RATE, words: [] }
  },
}

const vite = await createViteServer({ root, envDir: false, appType: 'spa', server: { middlewareMode: true } })
const handler = createRequestHandler({
  env: {},
  config: readServerConfig({ PORT: String(port) }),
  vite,
  fetchImpl: async () => { throw new Error('mock-live never calls DeepSeek') },
  speech,
  live: ({ speech }) => createLiveRuntime({ speech }),
})
const server = createServer(handler)
server.listen(port, '127.0.0.1', () => {
  console.log(`MOCK LIVE ONLY (voice: ${voice ?? 'tone fallback'}; no provider charges)`)
  console.log(`  stage:   http://127.0.0.1:${port}/airi/stage.html?role=obs`)
  console.log(`  preview: http://127.0.0.1:${port}/airi/stage.html?role=preview`)
  console.log(`  console: http://127.0.0.1:${port}/airi/console.html`)
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
