// Dev-only, loopback-only, no real provider fetches or environment credentials.
// Supply a synthetic MP3 <=30 s; MiniMax=32 kHz mono, Eleven=44.1 kHz mono/stereo.
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createViteServer } from 'vite'
import { readSpeechConfig } from '../server/speech-provider.mjs'
import { createSpeechHandler } from '../server/speech.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
if (!process.argv[2]) throw new Error('Pass a synthetic MP3 path and optional minimax|elevenlabs; this mock never calls providers.')
const provider = process.argv[3] ?? 'minimax'
if (!['minimax', 'elevenlabs'].includes(provider)) throw new Error('Unknown mock provider.')
const audio = await readFile(process.argv[2])
if (!audio.length || audio.length > 2 * 1024 * 1024) throw new Error('Mock MP3 must be 1 byte–2 MiB.')
const dataRoot = await mkdtemp(join(tmpdir(), 'airi-voice-mock-'))
let requests = 0
const speech = createSpeechHandler({
  rootDirectory: dataRoot,
  config: readSpeechConfig({ TTS_PROVIDER: provider,
    MINIMAX_TTS_ENABLED: '1', MINIMAX_API_KEY: 'mock-only',
    MINIMAX_VOICE_ID: 'mock-only', MINIMAX_TTS_DAILY_CHAR_LIMIT: '10000',
    ELEVENLABS_TTS_ENABLED: '1', ELEVENLABS_API_KEY: 'mock-only',
    ELEVENLABS_VOICE_ID: 'mockOnlyVoice01234567', ELEVENLABS_TTS_DAILY_CHAR_LIMIT: '10000' }),
  fetchImpl: async (_url, options) => {
    requests++
    const payload = JSON.parse(options.body)
    const text = provider === 'elevenlabs' ? payload.inputs[0].text : payload.text
    // Diagnostics deliberately exclude text, provider keys and experience codes.
    console.log(JSON.stringify({ mockRequest: requests, provider, characters: text.length,
      emotion: provider === 'elevenlabs' ? text.match(/^\[(happy|curious)\]/)?.[1] ?? 'automatic'
        : payload.voice_setting.emotion ?? 'automatic' }))
    options.signal.throwIfAborted()
    if (provider === 'elevenlabs') {
      // Synthetic 1 s alignment, NOT provider timing or spoken-content evidence.
      const alignment = { characters: ['模', '拟', '音', '频'],
        character_start_times_seconds: [0, 0.25, 0.5, 0.75],
        character_end_times_seconds: [0.25, 0.5, 0.75, 1] }
      return new Response(JSON.stringify({ audio_base64: audio.toString('base64'), alignment,
        normalized_alignment: alignment, voice_segments: [{ voice_id: payload.inputs[0].voice_id,
          start_time_seconds: 0, end_time_seconds: 1, character_start_index: 0, character_end_index: 4,
          dialogue_input_index: 0 }] }), { headers: { 'content-type': 'application/json' } })
    }
    // The passed fixture is intended to be about one second. This fake metadata
    // is not provider timing evidence. Browser validation uses actual duration.
    const frame = { base_resp: { status_code: 0 }, data: { audio: audio.toString('hex'), status: 2 },
      extra_info: { audio_format: 'mp3', audio_sample_rate: 32000, audio_channel: 1,
        audio_size: audio.length, audio_length: 1100 } }
    return new Response(`data: ${JSON.stringify(frame)}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
  },
})
const vite = await createViteServer({ root, envDir: false, appType: 'spa', server: { middlewareMode: true } })
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname
  if (pathname === '/airi/api/health') {
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    return response.end(JSON.stringify({ configured: true, model: 'MOCK-NOT-DEEPSEEK',
      provider: 'deepseek', accessProtected: false, speech: speech.health() }))
  }
  if (request.method === 'POST' && pathname === '/airi/api/speech')
    return speech.handle(request, response)
  if (request.method === 'POST' && pathname === '/airi/api/chat') {
    request.resume()
    response.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' })
    const events = [
      { type: 'delivery', value: 'bright' }, { type: 'delta', content: '这是模拟测试，不是真实大模型或供应商声音。' },
      { type: 'delivery', value: 'soft' }, { type: 'delta', content: '\n现在这句轻一点。' },
      { type: 'delivery', value: 'curious' }, { type: 'delta', content: '\n你听到了吗？' }, { type: 'done' },
    ]
    for (const event of events) {
      if (response.destroyed) return
      response.write(`${JSON.stringify(event)}\n`)
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    return response.end()
  }
  if (pathname.startsWith('/airi/api/')) { response.writeHead(404); return response.end() }
  vite.middlewares(request, response)
})
server.listen(4175, '127.0.0.1', () => console.log('MOCK ONLY: http://127.0.0.1:4175/airi/ — synthetic MP3, no provider charges'))
async function stop() {
  server.closeAllConnections()
  server.close()
  await vite.close()
  await rm(dataRoot, { recursive: true, force: true }) // Only this mkdtemp result.
  process.exit(0)
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
