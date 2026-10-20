import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// A zero-dependency stand-in for a self-hosted OpenAI-compatible engine
// (POST /v1/audio/speech). It never synthesises speech: every reply is a
// short sine tone in a 16-bit mono WAV, so tests and manual checks can prove
// the airi-lite pipeline without a GPU, a model download or a paid API.
//
//   node scripts/mock-local-tts.mjs            # 127.0.0.1:8765
//   MOCK_LOCAL_TTS_PORT=9000 MOCK_LOCAL_TTS_API_KEY=dev-key node scripts/mock-local-tts.mjs

export function sineWav({ sampleRate = 24_000, seconds = 0.6, frequency = 220 } = {}) {
  const samples = Math.round(sampleRate * seconds)
  const wav = Buffer.alloc(44 + samples * 2)
  wav.write('RIFF', 0, 'latin1')
  wav.writeUInt32LE(36 + samples * 2, 4)
  wav.write('WAVE', 8, 'latin1')
  wav.write('fmt ', 12, 'latin1')
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20) // integer PCM
  wav.writeUInt16LE(1, 22) // mono
  wav.writeUInt32LE(sampleRate, 24)
  wav.writeUInt32LE(sampleRate * 2, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36, 'latin1')
  wav.writeUInt32LE(samples * 2, 40)
  const fade = sampleRate * 0.02
  for (let index = 0; index < samples; index++) {
    const envelope = Math.min(1, index / fade, (samples - index) / fade)
    const value = Math.sin(2 * Math.PI * frequency * index / sampleRate) * envelope * 0.3
    wav.writeInt16LE(Math.round(value * 32_767), 44 + index * 2)
  }
  return wav
}

function sendError(response, status, message) {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify({ error: { message } }))
}

// `onRequest(body, headers)` sees each accepted request, for tests only.
export function createMockLocalTts({ apiKey = '', sampleRate = 24_000, onRequest = () => {} } = {}) {
  return createServer(async (request, response) => {
    if (request.method !== 'POST' || new URL(request.url, 'http://mock').pathname !== '/v1/audio/speech')
      return sendError(response, 404, 'not found')
    if (apiKey && request.headers.authorization !== `Bearer ${apiKey}`)
      return sendError(response, 401, 'bad key')
    const chunks = []
    let bytes = 0
    for await (const chunk of request) {
      if ((bytes += chunk.length) > 64_000)
        return sendError(response, 413, 'too large')
      chunks.push(chunk)
    }
    let body
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch { return sendError(response, 400, 'invalid json') }
    if (typeof body?.model !== 'string' || typeof body.input !== 'string' || !body.input.trim()
      || typeof body.voice !== 'string' || (body.speed !== undefined && typeof body.speed !== 'number'))
      return sendError(response, 400, 'invalid request')
    if ((body.response_format ?? 'wav') !== 'wav')
      return sendError(response, 400, 'this mock only returns wav')
    onRequest(body, request.headers)
    // Longer text gives a longer tone, bounded well under airi-lite's 30 s cap.
    const seconds = Math.min(3, 0.3 + [...body.input].length * 0.06) / (body.speed || 1)
    const wav = sineWav({ sampleRate, seconds })
    response.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length })
    response.end(wav)
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.MOCK_LOCAL_TTS_PORT) || 8_765
  const server = createMockLocalTts({
    apiKey: process.env.MOCK_LOCAL_TTS_API_KEY ?? '',
    // Diagnostic sizes only: never log the submitted text.
    onRequest: body => console.log(`Mock speech: ${body.input.length} chars, voice ${JSON.stringify(body.voice)}, speed ${body.speed ?? 1}`),
  })
  server.listen(port, '127.0.0.1', () => console.log(`Mock local TTS at http://127.0.0.1:${port}/v1/audio/speech`))
}
