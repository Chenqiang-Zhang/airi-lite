import assert from 'node:assert/strict'
import test from 'node:test'

import { buildMinimaxRequest } from '../server/minimax.mjs'
import { normaliseSpeechRequest } from '../server/speech.mjs'
import { EMOTIONS } from '../shared/performance-cues.mjs'
import { buildAuditionPage, plannedCharacters, SAMPLES } from './minimax-audition.mjs'

test('every sample is a request the server accepts, and every tone is heard once', () => {
  for (const part of SAMPLES.flatMap(sample => sample.parts)) {
    const request = { text: part.text, delivery: part.delivery, ...(part.act ? { act: part.act } : {}) }
    assert.deepEqual(normaliseSpeechRequest(request), request, part.text)
    assert.ok(buildMinimaxRequest({ voiceId: 'v', model: 'speech-2.8-hd' }, request).text.length <= 360)
  }
  const tones = new Set(SAMPLES.filter(sample => sample.parts.length === 1 || sample.id.includes('pause')).flatMap(sample => sample.parts.map(part => part.delivery)))
  for (const emotion of EMOTIONS)
    assert.ok(tones.has(emotion), emotion)
  assert.deepEqual(new Set(SAMPLES.flatMap(sample => sample.parts).map(part => part.act).filter(Boolean)), new Set(['laugh', 'pause', 'sigh']))
  const split = SAMPLES.find(sample => sample.id === 'split').parts.map(part => part.text).join('')
  assert.equal(SAMPLES.find(sample => sample.id === 'joined').parts[0].text, split, 'the two ways say the same words')
  assert.ok(plannedCharacters() < 200, 'a small paid run')
})

test('the page embeds every clip with what was sent and plays a pause as silence', () => {
  const results = SAMPLES.map(sample => ({
    ...sample,
    parts: sample.parts.map(part => ({ ...part, audio: 'QUJD', sent: { text: part.act === 'laugh' ? `(laughs)${part.text}` : part.text, emotion: part.delivery === 'happy' ? 'happy' : undefined, speed: 1 } })),
  }))
  const page = buildAuditionPage({ results, voice: 'voice-<x>', model: 'speech-2.8-hd', date: '2026-10-20 22:00' })
  assert.equal(page.match(/<audio /g).length, SAMPLES.reduce((sum, sample) => sum + sample.parts.length, 0))
  assert.match(page, /data:audio\/mpeg;base64,QUJD/)
  assert.match(page, /发送「\(laughs\)这个梗我接住了！」/)
  assert.match(page, /data-pause="0.4"/)
  assert.match(page, /voice-&#60;x&#62;/, 'text is escaped')
  assert.doesNotMatch(page, /https?:\/\//, 'self-contained')
})

test('the run saves each clip as it arrives, retries a failure once, keeps its raw response and honours the cap', async () => {
  const { mkdtemp, readdir, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { clipFile, readClip, runAudition } = await import('./minimax-audition.mjs')
  const out = await mkdtemp(join(tmpdir(), 'minimax-audition-'))
  try {
    const config = { voiceId: 'voice-a', model: 'speech-2.8-hd' }
    const parts = SAMPLES.flatMap(sample => sample.parts)
    const flaky = parts[11].text
    const calls = []
    const recorder = { last: null }
    const speech = {
      async synthesise(request) {
        calls.push(request.text)
        recorder.last = { status: 200, contentType: 'text/event-stream', raw: `data: ${request.text}` }
        if (request.text === flaky && calls.filter(text => text === flaky).length === 1)
          throw Object.assign(new Error('TTS_UPSTREAM_INVALID'), { code: 'TTS_UPSTREAM_INVALID', detail: 'audio-size streamed=1 reported=9000' })
        return { audio: Buffer.from(request.text).toString('base64') }
      },
    }
    const logs = []
    const quiet = { wait: async () => {}, log: line => logs.push(line), progress: () => {} }
    const first = await runAudition({ config, out, missing: parts, cap: parts.length + 2, speech, recorder, ...quiet })
    assert.equal(first.requests, parts.length + 1, 'one retry')
    assert.equal(first.made, parts.length)
    assert.deepEqual(first.failures, [])
    assert.ok(logs.some(line => line.includes('(audio-size streamed=1 reported=9000)')), 'the reason is printed')
    const failed = await readdir(join(out, 'failed'))
    assert.equal(failed.length, 1)
    assert.match(await readFile(join(out, 'failed', failed[0]), 'utf8'), new RegExp(`^HTTP 200 text/event-stream\n\ndata: ${flaky}`))
    for (const part of parts)
      assert.equal((await readClip(clipFile({ out, config, part }))).text, part.text)
    const page = await readFile(first.page, 'utf8')
    assert.equal(page.match(/<audio /g).length, parts.length)

    // Another voice reuses nothing; the cap stops paying and the page says what is missing.
    const other = { ...config, voiceId: 'voice-b' }
    calls.length = 0
    const capped = await runAudition({ config: other, out, missing: parts.slice(0, 3), cap: 2,
      speech: { synthesise: async () => { calls.push(1); throw Object.assign(new Error('x'), { code: 'TTS_UPSTREAM_FAILED', detail: 'http-500' }) } },
      recorder: { last: null }, ...quiet })
    assert.equal(calls.length, 2)
    assert.deepEqual(capped.failures.map(failure => failure.reason), ['TTS_UPSTREAM_FAILED (http-500)', 'request cap reached', 'request cap reached'])
    assert.equal(capped.made, 0)
    assert.match(await readFile(capped.page, 'utf8'), /这一段没有生成成功/)

    // A spent budget is not retried.
    calls.length = 0
    await runAudition({ config: other, out, missing: parts.slice(0, 1), cap: 5,
      speech: { synthesise: async () => { calls.push(1); throw Object.assign(new Error('x'), { code: 'TTS_DAILY_LIMIT' }) } },
      recorder: { last: null }, ...quiet })
    assert.equal(calls.length, 1)
  }
  finally {
    await rm(out, { recursive: true, force: true })
  }
})

test('the recorder keeps the raw body and still hands the stream on', async () => {
  const { recordingFetch } = await import('./minimax-audition.mjs')
  const recorder = recordingFetch(async () => new Response('data: x\n\n', { headers: { 'content-type': 'text/event-stream' } }))
  const response = await recorder.fetch('https://example.invalid', {})
  assert.equal(await response.text(), 'data: x\n\n')
  assert.deepEqual(recorder.last, { status: 200, contentType: 'text/event-stream', raw: 'data: x\n\n' })
})

test('a clip key changes with the dictionary rules sent, and only then', async () => {
  const { createHash } = await import('node:crypto')
  const { clipFile, clipKey, sentFields } = await import('./minimax-audition.mjs')
  const { readMinimaxConfig } = await import('../server/minimax.mjs')
  const legacy = ({ voice, model, part }) => createHash('sha256')
    .update(JSON.stringify([voice, model, part.text, part.delivery, part.act ?? null])).digest('hex').slice(0, 16)
  const laugh = { text: '这个梗我接住了！', delivery: 'happy', act: 'laugh' }
  assert.equal(clipKey({ voice: 'voice-a', model: 'speech-2.8-hd', part: laugh }), '51e3e50dbe3cd7ba', 'saved clips stay valid')
  for (const part of SAMPLES.flatMap(sample => sample.parts)) {
    const key = { voice: 'voice-a', model: 'speech-2.8-hd', part }
    assert.equal(clipKey(key), legacy(key), part.text)
    assert.equal(clipKey({ ...key, dictionary: [] }), legacy(key), part.text)
  }
  const name = { text: '我是日和，今天也请多指教。', delivery: 'neutral' }
  const key = { voice: 'voice-a', model: 'speech-2.8-hd', part: name }
  const pinyin = clipKey({ ...key, dictionary: ['日和/(ri4)(he2)'] })
  assert.notEqual(pinyin, clipKey(key))
  assert.notEqual(clipKey({ ...key, dictionary: ['日和/ひより'] }), pinyin)

  // clipFile passes what buildMinimaxRequest would send for that config.
  const env = { MINIMAX_TTS_ENABLED: '1', MINIMAX_API_KEY: 'k', MINIMAX_VOICE_ID: 'voice-a', MINIMAX_TTS_MODEL: 'speech-2.8-hd',
    MINIMAX_TTS_DAILY_CHAR_LIMIT: '100' }
  const shipped = readMinimaxConfig(env)
  const off = readMinimaxConfig({ ...env, MINIMAX_PRONUNCIATION: '0' })
  assert.equal(clipFile({ out: 'o', config: shipped, part: laugh }), clipFile({ out: 'o', config: off, part: laugh }))
  assert.equal(clipFile({ out: 'o', config: shipped, part: laugh }), `o/clips/${legacy({ voice: 'voice-a', model: 'speech-2.8-hd', part: laugh })}.json`)
  assert.equal(clipFile({ out: 'o', config: shipped, part: name }), `o/clips/${pinyin}.json`)
  assert.equal(clipFile({ out: 'o', config: off, part: name }), `o/clips/${clipKey(key)}.json`)
  // The page records the rules only when some were sent.
  assert.deepEqual(sentFields(buildMinimaxRequest(shipped, name)), { text: name.text, emotion: undefined, speed: 1, dictionary: ['日和/(ri4)(he2)'] })
  assert.equal(Object.hasOwn(sentFields(buildMinimaxRequest(off, name)), 'dictionary'), false)
  const page = buildAuditionPage({ results: [{ id: 'n', title: '名字', parts: [{ ...name, audio: 'QUJD', sent: sentFields(buildMinimaxRequest(shipped, name)) }] }],
    voice: 'v', model: 'speech-2.8-hd', date: 'd', heading: 'P5b <检查>', note: '说明' })
  assert.match(page, /词典 日和\/\(ri4\)\(he2\)/)
  assert.match(page, /<h1>P5b &#60;检查&#62;（speech-2.8-hd）<\/h1>/)
  assert.match(page, /d · 音色 v · 说明<\/p>/)
})
