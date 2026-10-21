import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { SpeechProviderError } from '../server/speech-error.mjs'
import { chooseSayVoice, createMockSpeech, parseMockLatency, SAMPLE_RATE, toneSeconds, toneWav } from './mock-tts.mjs'

const refuseExec = async () => { throw new Error('say must not be spawned') }

function readWav(base64) {
  const bytes = Buffer.from(base64, 'base64')
  return {
    riff: bytes.toString('ascii', 0, 4),
    wave: bytes.toString('ascii', 8, 12),
    format: bytes.readUInt16LE(20),
    channels: bytes.readUInt16LE(22),
    sampleRate: bytes.readUInt32LE(24),
    bits: bytes.readUInt16LE(34),
    dataBytes: bytes.readUInt32LE(40),
    peak: Array.from({ length: (bytes.length - 44) / 2 }, (_, index) => Math.abs(bytes.readInt16LE(44 + index * 2)))
      .reduce((highest, value) => Math.max(highest, value), 0),
    length: bytes.length,
  }
}

test('without macOS, `say` is never spawned and no voice is chosen', async () => {
  for (const platform of ['win32', 'linux'])
    assert.equal(await chooseSayVoice({ platform, env: { MOCK_SAY_VOICE: 'Tingting' }, exec: refuseExec }), null)
  // On macOS a missing `say` or no zh_CN voice also means the tone.
  assert.equal(await chooseSayVoice({ platform: 'darwin', env: {}, exec: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) } }), null)
  assert.equal(await chooseSayVoice({ platform: 'darwin', env: {}, exec: async () => ({ stdout: 'Alex    en_US    # Hello\n' }) }), null)
  assert.equal(await chooseSayVoice({ platform: 'darwin', env: {}, exec: async () => ({ stdout: 'Alex    en_US    # Hello\nTingting (中文（中国大陆）)    zh_CN    # 你好！\n' }) }), 'Tingting (中文（中国大陆）)')
  assert.equal(await chooseSayVoice({ platform: 'darwin', env: { MOCK_SAY_VOICE: 'Eddy' }, exec: refuseExec }), 'Eddy')
})

test('the no-`say` fallback returns a valid, audible sine-wave WAV sized to the line', async (context) => {
  const workDirectory = await mkdtemp(join(tmpdir(), 'airi-mock-tts-'))
  context.after(() => rm(workDirectory, { recursive: true, force: true }))
  const lines = []
  const speech = createMockSpeech({ voice: null, workDirectory, exec: refuseExec, log: line => lines.push(JSON.parse(line)) })
  assert.equal(speech.engine, 'tone')
  assert.deepEqual(speech.health(), { configured: true, provider: 'minimax', model: 'mock-tone', region: 'cn' })

  const short = await speech.synthesise({ text: '你好。', delivery: 'neutral' })
  const long = await speech.synthesise({ text: '今天我们来聊聊彩排的事情，看看口型和字幕。', delivery: 'happy', act: 'laugh' })
  for (const clip of [short, long]) {
    assert.equal(clip.format, 'mp3', 'mock clips keep the cloud label (see the module comment)')
    assert.equal(clip.sampleRate, SAMPLE_RATE)
    assert.deepEqual(clip.words, [])
    const wav = readWav(clip.audio)
    assert.deepEqual([wav.riff, wav.wave, wav.format, wav.channels, wav.sampleRate, wav.bits], ['RIFF', 'WAVE', 1, 1, SAMPLE_RATE, 16])
    assert.equal(wav.dataBytes, wav.length - 44)
    assert.ok(wav.peak > 0.3 * 32_767, 'loud enough to open the mouth')
  }
  assert.ok(readWav(long.audio).dataBytes > readWav(short.audio).dataBytes)
  assert.deepEqual(lines.map(line => [line.mockClip, line.engine, line.delivery, line.act]),
    [[1, 'tone', 'neutral', null], [2, 'tone', 'happy', 'laugh']])
  assert.doesNotMatch(JSON.stringify(lines), /你好/, 'only counts are logged, never the text')
  assert.deepEqual(await readdir(workDirectory), [], 'the tone writes no files')
  await assert.rejects(speech.synthesise({ text: '  ', delivery: 'neutral' }), SpeechProviderError)
  await assert.rejects(speech.synthesise({ text: '你好。', delivery: 'neutral', act: 'cry' }), SpeechProviderError)
  assert.equal(lines.length, 2, 'a refused request makes no clip')
})

test('a failing `say` falls back to the tone per clip; an abort is passed through', async (context) => {
  const workDirectory = await mkdtemp(join(tmpdir(), 'airi-mock-tts-'))
  context.after(() => rm(workDirectory, { recursive: true, force: true }))
  const calls = []
  const speech = createMockSpeech({
    voice: 'Tingting',
    workDirectory,
    exec: async (command, args) => { calls.push([command, args[0], args[1]]); throw new Error('say crashed') },
    log: () => {},
  })
  assert.equal(speech.engine, 'say')
  const clip = await speech.synthesise({ text: '彩排。', delivery: 'soft' })
  assert.equal(readWav(clip.audio).riff, 'RIFF')
  assert.deepEqual(calls, [['/usr/bin/say', '-v', 'Tingting']])
  assert.deepEqual(await readdir(workDirectory), [], 'temporary text and WAV files are removed')
  const aborted = AbortSignal.abort()
  await assert.rejects(speech.synthesise({ text: '取消。', delivery: 'soft' }, { signal: aborted }))
})

test('tone length follows the line and stays bounded', () => {
  assert.equal(toneSeconds(''), 0.6)
  assert.equal(toneSeconds('你好'), 0.6)
  assert.equal(toneSeconds('一二三四五六七八九十'), 2)
  assert.equal(toneSeconds('长'.repeat(60)), 12, 'a joined 60-character clip is not cut short')
  assert.equal(toneSeconds('长'.repeat(200)), 15)
  assert.equal(toneWav(0.5, 8_000).length, 44 + 4_000 * 2)
})

test('the optional latency delays each clip by its length and an abort cuts it short', async () => {
  assert.equal(parseMockLatency(undefined), null)
  assert.deepEqual(parseMockLatency('800,40'), { fixedMs: 800, perCharacterMs: 40 })
  for (const bad of ['800', '-1,2', '800,40,1', '20000,1', 'a,b'])
    assert.throws(() => parseMockLatency(bad), /MOCK_TTS_LATENCY_MS/, bad)
  const waits = []
  const speech = createMockSpeech({ voice: null, workDirectory: '/nonexistent', log() {}, latency: { fixedMs: 800, perCharacterMs: 40 },
    delay: async (milliseconds) => { waits.push(milliseconds) } })
  await speech.synthesise({ text: '一二三四五', delivery: 'happy' })
  assert.deepEqual(waits, [1_000])
  const real = createMockSpeech({ voice: null, workDirectory: '/nonexistent', log() {}, latency: { fixedMs: 10_000, perCharacterMs: 0 } })
  const controller = new AbortController()
  const pending = real.synthesise({ text: '好。', delivery: 'happy' }, { signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
})
