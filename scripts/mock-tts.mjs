// The rehearsal's fake TTS (scripts/mock-live.mjs). On macOS it speaks with
// the system `say` command; elsewhere (Windows, Linux), or when `say` has no
// Chinese voice or fails, every clip is a generated sine-wave WAV, so the
// zero-cost rehearsal runs on any host. Nothing here calls a provider.
//
// MOCK ONLY: clips are WAV labelled `format: 'mp3'` on purpose. There is no
// MP3 encoder here, and the real MiniMax path validates MPEG frames
// server-side (server/minimax.mjs validateMp3), which this fake bypasses.
// Chromium's decodeAudioData sniffs the content, so the stage still decodes
// it. Never reuse this shortcut outside rehearsal.
import { execFile } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { isAct } from '../shared/performance-cues.mjs'
import { SpeechProviderError } from '../server/speech-error.mjs'

export const SAMPLE_RATE = 32_000
const SAY = '/usr/bin/say'
const run = promisify(execFile)

// Roughly a Chinese speaking pace, so captions and mouth movement last about
// as long as the line would; bounded so one clip never runs on.
export function toneSeconds(text) {
  const characters = [...String(text ?? '').trim()].length
  return Math.min(8, Math.max(0.6, characters * 0.2))
}

// Amplitude-modulated sine: the 4 Hz envelope opens and closes the mouth,
// and its level stays comfortably above the stage's silence threshold.
export function toneWav(seconds = 1, sampleRate = SAMPLE_RATE) {
  const count = Math.round(seconds * sampleRate)
  const buffer = Buffer.alloc(44 + count * 2)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + count * 2, 4)
  buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(count * 2, 40)
  for (let index = 0; index < count; index++) {
    const time = index / sampleRate
    const envelope = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * time)
    buffer.writeInt16LE(Math.round(0.35 * envelope * Math.sin(2 * Math.PI * 220 * time) * 32_767), 44 + index * 2)
  }
  return buffer
}

// A zh_CN `say` voice, or null when there is none (or not on macOS: the
// command is never spawned there).
export async function chooseSayVoice({ platform = process.platform, env = process.env, exec = run } = {}) {
  if (platform !== 'darwin')
    return null
  if (env.MOCK_SAY_VOICE)
    return env.MOCK_SAY_VOICE
  try {
    const { stdout } = await exec(SAY, ['-v', '?'])
    // Lines look like "Eddy (中文（中国大陆）)     zh_CN    # 你好！"
    for (const line of stdout.split('\n')) {
      const match = /^(.+?)\s{2,}zh_CN\s/.exec(line)
      if (match) return match[1].trim()
    }
  }
  catch {}
  return null
}

// A speech handler with the same shape as server/speech.mjs createSpeechHandler.
export function createMockSpeech({
  voice,
  workDirectory,
  exec = run,
  fs = { readFile, rm, writeFile },
  log = line => console.log(line),
}) {
  let clips = 0

  async function say(text, id, signal) {
    const textFile = join(workDirectory, `clip-${id}.txt`)
    const wavFile = join(workDirectory, `clip-${id}.wav`)
    try {
      await fs.writeFile(textFile, text, { mode: 0o600 })
      // execFile, not a shell: the text never becomes command syntax.
      await exec(SAY, ['-v', voice, '-f', textFile, '-o', wavFile,
        '--file-format=WAVE', `--data-format=LEI16@${SAMPLE_RATE}`], { signal })
      return await fs.readFile(wavFile)
    }
    finally {
      await fs.rm(textFile, { force: true })
      await fs.rm(wavFile, { force: true })
    }
  }

  return {
    engine: voice ? 'say' : 'tone',
    health: () => ({ configured: true, provider: 'minimax', model: voice ? 'mock-say' : 'mock-tone', region: 'cn' }),
    // The public /api/speech route is not part of the rehearsal.
    async handle(_request, response) {
      response.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ code: 'MOCK_NO_PUBLIC_SPEECH' }))
    },
    // The act is only logged: `say` and the tone make no laugh or sigh, and a
    // pause is silence the stage's player adds for every engine.
    async synthesise({ text, delivery, act }, { signal } = {}) {
      if (typeof text !== 'string' || !text.trim() || (act !== undefined && !isAct(act)))
        throw new SpeechProviderError('TTS_INVALID_REQUEST')
      signal?.throwIfAborted()
      const id = ++clips
      let audio = null
      if (voice) {
        try { audio = await say(text, id, signal) }
        catch (error) {
          if (signal?.aborted)
            throw error
        }
      }
      const engine = audio ? 'say' : 'tone'
      audio ??= toneWav(toneSeconds(text))
      log(JSON.stringify({ mockClip: id, delivery, act: act ?? null, characters: text.length, bytes: audio.length, engine }))
      return { audio: audio.toString('base64'), format: 'mp3', sampleRate: SAMPLE_RATE, words: [] }
    },
  }
}
