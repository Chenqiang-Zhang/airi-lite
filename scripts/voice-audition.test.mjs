import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createWavBlob, createPcm16Blob } from '../src/audio-wav.ts'
import { DEFAULT_VOICE, VOICE_STORAGE_KEY } from '../src/voice.ts'
import { replySentenceStream } from '../src/speech-sentences.ts'
import { CACHE_NAME, MODEL_BASE, MODEL_FILES, RUNTIME_FILES, LINES, VOICES, neutralMatrix, deliveryMatrix, createLedger, inspectCache, cacheOnlyFetch, inspectWav } from './voice-audition.mjs'

const page = await readFile(new URL('./voice-audition-preview.html', import.meta.url), 'utf8')
const fixtureWav = () => createWavBlob([createPcm16Blob(Float32Array.from({ length: 2400 }, (_, index) => .1 * Math.sin(index * .1)))], 24000)
const neutral = neutralMatrix()

test('actual page audition cannot publish a canceled, replaced or failed snapshot after async inspection', async () => {
  // Execute the actual page function with explicit fake model/media signals.
  // This is an ownership regression, not browser or Kokoro audio evidence.
  const start = page.indexOf('  async function audition(item) {')
  const end = page.indexOf('  function showRecord(record) {', start)
  assert.ok(start >= 0 && end > start)
  const make = new Function('context', `
    const { ledger, controller, audio, inspectWav, render, showRecord } = context;
    let active = null, cancelled = false, preparing = false, problem = '', backend = 'kokoro-wasm';
    const counters = { controllerCalls: 0 };
    ${page.slice(start, end)}
    return { audition, stop() { cancelled = true; controller.cancel() } };
  `)
  for (const transition of ['cancel', 'replace', 'problem']) {
    const ledger = createLedger(), wav = fixtureWav()
    let owned = wav, releaseInspection, startedInspection
    const inspectionStarted = new Promise(resolve => { startedInspection = resolve })
    const delayedInspection = new Promise(resolve => { releaseInspection = resolve })
    const controller = {
      async speak() {
        const record = ledger.records.get(neutral[0].key)
        record.states.push('ready'); record.nativeEndedEvents = 1; record.firstPlayingMs = 1
      },
      cancel() { owned = null },
      getCompletedAudioBlob() { return owned },
    }
    const runtime = make({ ledger, controller,
      audio: { currentSrc: 'test-complete-source', src: 'test-complete-source', readyState: 4,
        paused: true, ended: false, currentTime: 0, error: null },
      async inspectWav() { startedInspection(); return delayedInspection },
      render() {}, showRecord() {},
    })
    const work = runtime.audition(neutral[0])
    await inspectionStarted
    if (transition === 'cancel') runtime.stop()
    else if (transition === 'replace') owned = fixtureWav()
    else ledger.records.get(neutral[0].key).problem = 'late fixture failure'
    releaseInspection(await inspectWav(wav))
    const record = await work
    assert.equal(record.status, 'failed', transition)
    assert.equal(record.wav, undefined)
    assert.equal(record.url, undefined)
  }
})

test('freeze exact four research texts, neutral 3×4 matrix and concealed stable mapping', async () => {
  const research = await readFile(new URL('../docs/verification/2026-10-03-voice-provider-research.md', import.meta.url), 'utf8')
  assert.deepEqual(LINES, ['你还真买到了？我以为已经关门了呢。', '哼，这局先算你赢，下一局可不一定。', '嗯，今天不想聊也没关系，就待一会儿吧。', '我选草莓。你喜欢抹茶，我们各选各的就好。'])
  for (const text of LINES) assert.ok(research.includes(`「${text}」`))
  assert.deepEqual(VOICES.map(value => [value.label, value.voice]), [['样本 A', 'zf_002'], ['样本 B', 'zf_003'], ['样本 C', 'zf_001']])
  assert.equal(neutral.length, 12)
  assert.equal(new Set(neutral.map(item => item.key)).size, 12)
  assert.ok(neutral.every(item => item.delivery === 'neutral'))
  assert.deepEqual(neutral.slice(0, 3).map(item => item.voice), ['zf_002', 'zf_003', 'zf_001'])
})

test('bounded ledger caps 12 neutral + one selected ≤4 matrix items, reuses neutral and never retries', () => {
  const ledger = createLedger()
  for (const item of neutral) {
    const record = ledger.reserve(item)
    ledger.complete(record, { engine: null, states: [], problem: 'synthetic failure fixture' })
    assert.equal(ledger.reserve(item), record)
    assert.throws(() => ledger.complete(record, {}))
  }
  assert.throws(() => ledger.reserve({ ...neutral[0], text: 'not approved' }))
  assert.throws(() => ledger.reserve(deliveryMatrix('样本 A')[0]))
  assert.throws(() => ledger.select('zf_001'))
  ledger.select('样本 B')
  assert.throws(() => ledger.select('样本 C'))
  const optional = deliveryMatrix('样本 B')
  assert.equal(optional.length, 4)
  assert.deepEqual(optional.map(item => item.delivery), ['curious', 'bright', 'soft', 'neutral'])
  for (const item of optional) ledger.reserve(item)
  assert.equal(ledger.records.size, 15, 'neutral item uses existing baseline, not another generation')
  assert.equal(ledger.manifest().defaultVoiceChanged, false)
})

test('audition item caps are distinct from unchanged production sentence/inference counts', async () => {
  const counts = []
  for (const text of LINES) {
    let count = 0
    for await (const sentence of replySentenceStream(text, 'neutral')) {
      assert.ok(sentence.text); count++
    }
    counts.push(count)
  }
  assert.deepEqual(counts, [2, 1, 1, 2])
  const manifest = createLedger().manifest()
  assert.equal(manifest.maximumNeutralAuditionItems, 12)
  assert.equal(manifest.maximumNewDeliveryAuditionItems, 3)
  assert.equal(manifest.maximumTotalAuditionItems, 15)
  assert.equal(manifest.expectedBaselineInferenceMinimum, counts.reduce((sum, count) => sum + count, 0) * 3)
  assert.equal(manifest.expectedOptionalNewInferenceMinimum, counts.slice(0, 3).reduce((sum, count) => sum + count, 0))
})

test('successful results require physical nonzero WAV + real playback evidence; fallback/partial/failed excluded', async () => {
  const wav = fixtureWav(), dimensions = await inspectWav(wav)
  // These are structural unit fixtures, NOT real Kokoro generation evidence.
  const valid = { ...dimensions, engine: 'kokoro-wasm', states: ['loading', 'ready'], wav }
  for (const evidence of [{ ...valid, states: ['ready', 'fallback'] }, { ...valid, engine: 'browser' }, { ...valid, problem: 'partial audio interrupted' }, { ...valid, wav: null }, { ...valid, duration: 0 }, valid]) {
    const ledger = createLedger(), record = ledger.reserve(neutral[0])
    record.nativeEndedEvents = 1; record.firstPlayingMs = 23
    ledger.complete(record, evidence)
    assert.equal(record.status, evidence === valid ? 'success' : 'failed')
    if (record.status === 'failed') assert.equal(record.wav, undefined)
  }
  const ledger = createLedger(), record = ledger.reserve(neutral[0])
  ledger.complete(record, valid)
  assert.equal(record.status, 'failed', 'no fabricated success from waveform alone')
  await assert.rejects(inspectWav(new Blob([new Uint8Array(44)], { type: 'audio/wav' })))
  await assert.rejects(inspectWav(createWavBlob([createPcm16Blob(new Float32Array(2400))], 24000)))
  const truncated = wav.slice(0, wav.size - 2)
  await assert.rejects(inspectWav(truncated))
})

test('empty/exact/incomplete cache diagnostics never fetch remote or mistake voice/runtime for model readiness', async () => {
  let opened = 0
  const fetched = []
  const local = async url => {
    fetched.push(url)
    assert.equal(new URL(url).origin, 'http://127.0.0.1:4175')
    return new Response(null, { headers: { 'content-length': '2048', 'content-type': url.endsWith('.mjs') ? 'text/javascript' : url.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream' } })
  }
  const proof = await inspectCache({ cacheStorage: { async keys() { return [] }, async open() { opened++; throw new Error('must not create cache') } }, fetchLocal: local, origin: 'http://127.0.0.1:4175' })
  assert.equal(opened, 0)
  assert.equal(proof.ready, false)
  assert.deepEqual(proof.assets.filter(asset => !asset.ready).map(asset => asset.file), MODEL_FILES)
  assert.equal(fetched.length, 5)
  const seen = []
  const partial = await inspectCache({ cacheStorage: { async keys() { return [CACHE_NAME] }, async open() { return { async match(url) {
    seen.push(url)
    if (url.endsWith('/config.json')) return new Response(JSON.stringify({ model_type: 'style_text_to_speech_2', 'transformers.js_config': { use_external_data_format: true } }))
    if (url.endsWith('/onnx/model.onnx')) return new Response(new Uint8Array(20), { headers: { 'content-length': '999' } })
  } } } }, fetchLocal: local, origin: 'http://127.0.0.1:4175' })
  assert.deepEqual(seen, MODEL_FILES.map(file => MODEL_BASE + file))
  assert.equal(partial.ready, false)
  assert.ok(partial.assets.some(asset => asset.file === 'external-data configuration' && !asset.ready))
  assert.match(partial.assets.find(asset => asset.file.endsWith('.onnx')).reason, /truncated/)
})

test('cache-only guard never invokes network for external URLs; cache eviction/new runtime URLs fail closed', async () => {
  const invoked = [], counters = { blocked: 0, externalCacheReads: 0, localRequests: 0 }
  const fetch = cacheOnlyFetch(async (...args) => { invoked.push(args); return new Response('local') }, {
    origin: 'http://127.0.0.1:4175', responses: new Map([[MODEL_BASE + 'config.json', new Response('{}')]]), counters,
  })
  assert.equal(await (await fetch(MODEL_BASE + 'config.json')).text(), '{}')
  assert.equal((await fetch(MODEL_BASE + 'config.json', { method: 'HEAD' })).body, null)
  await assert.rejects(fetch(MODEL_BASE + 'onnx/model_q8.onnx'))
  await assert.rejects(fetch('https://cdn.jsdelivr.net/missing-runtime.wasm'))
  await assert.rejects(fetch('/api/chat'))
  await assert.rejects(fetch('/airi/anything', { method: 'POST' }))
  assert.equal(invoked.length, 0)
  await fetch('/airi/kokoro/voices/zf_001.bin')
  assert.equal(invoked.length, 1)
  assert.equal(counters.blocked, 4)
})

test('Vite installed runtime JS missing HEAD length is checked with local body only; HTML fallback rejected', async () => {
  const calls = []
  const proof = await inspectCache({ cacheStorage: { async keys() { return [] } }, origin: 'http://127.0.0.1:4175',
    async fetchLocal(url, init) {
      calls.push({ url, method: init?.method ?? 'GET' })
      if (url.endsWith('.mjs')) return new Response(init?.method === 'HEAD' ? null : 'export const installed = true', { headers: { 'content-type': 'text/javascript' } })
      if (url.endsWith('.wasm')) return new Response(null, { headers: { 'content-length': '1024', 'content-type': 'text/html' } })
      return new Response(null, { headers: { 'content-length': '2048', 'content-type': 'application/octet-stream' } })
    },
  })
  assert.ok(calls.every(call => new URL(call.url).origin === 'http://127.0.0.1:4175'))
  assert.equal(calls.filter(call => call.method === 'GET').length, 1)
  const module = proof.assets.find(asset => asset.file.endsWith('.mjs'))
  assert.equal(module.ready, true)
  assert.match(module.reason, /GET body/)
  assert.equal(proof.assets.find(asset => asset.file.endsWith('.wasm')).ready, false)
  assert.equal(proof.ready, false)
})

test('installed loader provenance and page boundaries: real controller, fp32, local ORT, no default write or mount synthesis', async () => {
  const require = createRequire(import.meta.url)
  const kokoroPath = require.resolve('@uzen/kokoro-js')
  const installed = await readFile(kokoroPath, 'utf8')
  assert.match(installed, /dtype:\w+="fp32"/)
  assert.match(installed, /model_file_name:\w+=null/)
  assert.match(installed, /AutoTokenizer/)
  const transformersRequire = createRequire(kokoroPath)
  const hubPath = new URL('../src/utils/hub.js', pathToFileURL(transformersRequire.resolve('@huggingface/transformers')))
  const hub = await readFile(hubPath, 'utf8')
  assert.match(hub, /options.revision \?\? 'main'/)
  const transformerEnv = await readFile(new URL('../env.js', hubPath), 'utf8')
  assert.match(transformerEnv, /cacheKey: 'transformers-cache'/)
  assert.match(transformerEnv, /remotePathTemplate: '\{model\}\/resolve\/\{revision\}\/'/)
  const runtimePath = require.resolve('onnxruntime-web', { paths: [kokoroPath] })
  assert.ok(runtimePath.includes('onnxruntime-web'))
  assert.equal(DEFAULT_VOICE, 'zf_001')
  assert.equal(VOICE_STORAGE_KEY, 'airi-lite:voice:v1')
  assert.match(page, /createSpeechController\(audio/)
  assert.match(page, /KokoroTTS\.from_pretrained\(MODEL_ID, \{ device, dtype: 'fp32', voicePath \}\)/)
  assert.match(page, /model\.generate_from_ids/)
  assert.match(page, /controller\.speak\(item.text, item.delivery, item.voice, \[\], 'local'\)/)
  assert.match(page, /async synthesizeCloud\(\) \{ throw/)
  assert.match(page, /existing\) return existing/)
  assert.match(page, /player.src = record.url/)
  assert.match(page, /download.href = record.url/)
  assert.match(page, /controller\.getCompletedAudioBlob\(\)/)
  assert.doesNotMatch(page, /fetch\(audio\.currentSrc|fetch\(audio\.src/)
  assert.doesNotMatch(page, /localStorage\.setItem|saveVoice\(|fetchCloudSpeech|\/api\/chat|dispatchEvent/)
  assert.equal((page.match(/void run\(/g) ?? []).length, 2, 'both synth runs attached only to click listeners')
  assert.equal(RUNTIME_FILES.length, 2)
})
