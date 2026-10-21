import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { decodeCloudSpeechResponse } from '../src/cloud-speech.ts'
import { vowelUnits, withVowels } from '../src/visemes.ts'
import { buildCapture, captureName, main, streamFacts, textFromWords } from './viseme-check.mjs'

const fixture = name => readFileSync(new URL(`../server/fixtures/minimax-2.8-${name}.sse`, import.meta.url), 'utf8')
const fixturePath = name => new URL(`../server/fixtures/minimax-2.8-${name}.sse`, import.meta.url).pathname

// The client's own validator, with a stand-in for the browser's MP3 decoder:
// an audible tone as long as the stream says its audio is.
async function asClient(response, seconds) {
  const sampleRate = 32_000
  const samples = Float32Array.from({ length: Math.round((seconds + 0.05) * sampleRate) }, (_, index) => 0.2 * Math.sin(index * 0.05))
  return decodeCloudSpeechResponse(new Response(JSON.stringify(response)), {}, {
    decodeAudio: async () => ({ samples, sampleRate }),
  })
}

test('happy-short becomes the server\'s response, which passes the client\'s word checks', async () => {
  const { response, report } = await buildCapture(fixture('happy-short'), { name: 'happy-short' })
  const { capture, ...server } = response
  assert.deepEqual(Object.keys(server).sort(), ['audio', 'format', 'sampleRate', 'usage', 'wordAlignmentAvailable', 'words'])
  assert.equal(server.format, 'mp3')
  assert.equal(server.sampleRate, 32_000)
  assert.equal(server.wordAlignmentAvailable, true)
  assert.ok(server.audio.length > 1_000)
  assert.equal(report.words, 11)
  assert.equal(report.stale, false)
  assert.ok(report.tail > 0.1 && report.tail < 0.5, String(report.tail))
  // Rebuilt from the words: no results.jsonl next to a fixture.
  assert.deepEqual(capture, { id: 'happy-short', source: 'happy-short', text: '我们先从第一条开始吧。', delivery: 'neutral',
    audioLength: 2.136, lastWordEnd: server.words.at(-1).end, tail: report.tail, stale: false })

  const clip = await asClient(response, capture.audioLength)
  assert.deepEqual(clip.words, server.words, 'the decoder keeps every word; the capture note is ignored')
  assert.equal(clip.wordAlignmentAvailable, true)
  assert.match(report.line, /^我\(uo\)@0\.043-0\.256 们\(b:en\)@/)
})

test('cumulative is flagged stale, and the client builds no vowel track from it', async () => {
  const { response, report } = await buildCapture(fixture('cumulative'), { name: 'cumulative' })
  assert.equal(report.stale, true)
  assert.ok(report.tail > 1.5, String(report.tail))
  assert.equal(response.capture.stale, true)
  const clip = await asClient(response, response.capture.audioLength)
  // Even a fully voiced envelope cannot rescue a stale snapshot.
  const frames = Array.from({ length: Math.ceil(clip.samples.length / clip.sampleRate * 40) }, () => ({ open: 0.6, form: 0 }))
  const duration = clip.samples.length / clip.sampleRate
  assert.equal(vowelUnits(clip, frames, duration), null)
  assert.equal(withVowels(frames, clip, duration), frames)
})

test('the laugh tag goes back to an act and a dictionary name is said once', async () => {
  assert.deepEqual(textFromWords(['(laughs)', '这', '个', '。'].map(text => ({ text }))), { text: '这个。', act: 'laugh' })
  assert.deepEqual(textFromWords(['是', 'Hiyori', 'Hiyori', 'Hiyori', '。'].map(text => ({ text }))), { text: '是Hiyori。' })
  assert.deepEqual(textFromWords(['哈', '哈', '。'].map(text => ({ text }))), { text: '哈哈。' }, 'repeated characters stay')
  const laugh = await buildCapture(fixture('joined-laugh'), { name: 'joined-laugh' })
  assert.equal(laugh.response.capture.act, 'laugh')
  assert.equal(laugh.response.capture.text, '这个梗我接住了！你们今天弹幕好热闹。')
  const name = await buildCapture(fixture('pronunciation'), { name: 'pronunciation' })
  assert.equal(name.response.capture.text, '大家好，我是Hiyori。')
  // A stored request wins over the rebuilt text and normalises the old tone.
  const stored = await buildCapture(fixture('happy-short'), { name: 'x', request: { text: '我们先从第一条开始吧。', delivery: 'bright', model: 'speech-2.8-hd' } })
  assert.equal(stored.response.capture.delivery, 'happy')
  assert.equal(stored.response.capture.model, 'speech-2.8-hd')
})

test('stream facts: the audio length and the largest text offset', () => {
  assert.deepEqual(streamFacts(fixture('happy-short')), { audioLength: 2.136, textLength: 11 })
  assert.deepEqual(streamFacts('data: not json\n\n'), { audioLength: null, textLength: 0 })
  assert.equal(captureName('/x/.data/p5b-check/run-a/sse/long-1.sse'), 'run-a--long-1')
  assert.equal(captureName('/x/server/fixtures/minimax-2.8-cumulative.sse'), 'minimax-2.8-cumulative')
})

test('main writes one JSON per capture under .data/ and refuses any other folder', async () => {
  const root = mkdtempSync(join(tmpdir(), 'viseme-check-'))
  const lines = []
  const log = line => lines.push(line)
  try {
    const inputs = ['happy-short', 'cumulative'].map(fixturePath)
    assert.equal(await main(['--out=elsewhere', ...inputs], { root, log }), 1)
    assert.equal(await main([`--out=${join(root, '..')}`, ...inputs], { root, log }), 1)
    assert.equal(existsSync(join(root, 'elsewhere')), false)
    assert.match(lines.at(-1), /--out must be inside/)

    assert.equal(await main(['--dry-run', ...inputs], { root, log }), 0)
    assert.equal(existsSync(join(root, '.data')), false, 'a dry run writes nothing')

    assert.equal(await main(inputs, { root, log }), 0)
    const out = join(root, '.data', 'viseme-check')
    assert.deepEqual(readdirSync(out).sort(), ['minimax-2.8-cumulative.json', 'minimax-2.8-happy-short.json'])
    const written = JSON.parse(readFileSync(join(out, 'minimax-2.8-happy-short.json'), 'utf8'))
    assert.equal(written.capture.stale, false)
    assert.ok(lines.some(line => /^minimax-2\.8-cumulative: 13 words .* STALE/.test(line)))

    // A refused request's stream is skipped, not written.
    const refused = join(root, 'refused.sse')
    writeFileSync(refused, 'data: {"base_resp":{"status_code":1002,"status_msg":"rate limit exceeded(RPM)"}}\n\n')
    assert.equal(await main([refused], { root, log }), 1)
    assert.match(lines.at(-2), /^refused: skipped, not a speech stream/)
    assert.equal(await main(['--frobnicate', refused], { root, log }), 1)
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the same stream always gives the same JSON', async () => {
  assert.deepEqual(await buildCapture(fixture('pronunciation'), { name: 'p' }), await buildCapture(fixture('pronunciation'), { name: 'p' }))
})
