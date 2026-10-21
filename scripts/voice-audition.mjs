// Development-only audition contract. No application preference writes.
export const MODEL_ID = 'onnx-community/Kokoro-82M-v1.1-zh-ONNX'
export const MODEL_BASE = `https://huggingface.co/${MODEL_ID}/resolve/main/`
export const CACHE_NAME = 'transformers-cache'
export const MODEL_FILES = Object.freeze(['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model.onnx'])
export const RUNTIME_BASE = '/node_modules/.pnpm/node_modules/onnxruntime-web/dist/'
export const RUNTIME_FILES = Object.freeze(['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm'])
export const LINES = Object.freeze([
  '你还真买到了？我以为已经关门了呢。',
  '哼，这局先算你赢，下一局可不一定。',
  '嗯，今天不想聊也没关系，就待一会儿吧。',
  '我选草莓。你喜欢抹茶，我们各选各的就好。',
])
// Fixed concealed order, not randomized on replay. This is not a blinded study:
// the source and downloadable manifest intentionally disclose this mapping.
export const VOICES = Object.freeze([
  Object.freeze({ label: '样本 A', voice: 'zf_002' }),
  Object.freeze({ label: '样本 B', voice: 'zf_003' }),
  Object.freeze({ label: '样本 C', voice: 'zf_001' }),
])
// One shared emotion per line, matching each line's intent in the research
// notes: surprise, playful challenge, quiet company, ordinary talk.
export const DELIVERIES = Object.freeze(['surprised', 'pout', 'soft', 'neutral'])
export const neutralMatrix = () => LINES.flatMap((text, line) => VOICES.map(({ label, voice }) => ({
  key: `${voice}:neutral:${line}`, label, voice, delivery: 'neutral', line, text,
})))
export function deliveryMatrix(label) {
  const voice = VOICES.find(value => value.label === label)
  if (!voice) throw new TypeError('必须由用户选择一个已试听的样本')
  return LINES.map((text, line) => ({ ...voice, key: `${voice.voice}:${DELIVERIES[line]}:${line}`, delivery: DELIVERIES[line], line, text }))
}

export function createLedger() {
  const records = new Map()
  let selected = null
  return {
    records,
    select(label) {
      if (selected !== null && selected !== label) throw new Error('本轮 delivery 样本已锁定；不额外合成其他声线')
      deliveryMatrix(label)
      selected = label
    },
    reserve(item) {
      const approved = [...neutralMatrix(), ...(selected ? deliveryMatrix(selected) : [])].find(value => value.key === item.key)
      if (!approved || Object.keys(approved).length !== Object.keys(item).length
        || !Object.keys(approved).every(key => approved[key] === item[key])) throw new Error('不在固定试听矩阵中')
      if (records.has(item.key)) return records.get(item.key)
      const record = { ...item, status: 'running', engine: null, states: [], inferenceCalls: 0, review: {} }
      records.set(item.key, record)
      return record
    },
    complete(record, evidence) {
      if (record.status !== 'running') throw new Error('该试听尝试已经结束')
      Object.assign(record, evidence)
      const valid = evidence.engine?.startsWith('kokoro-') && evidence.states?.includes('ready')
        && !evidence.states.some(state => ['fallback', 'browser', 'cloud'].includes(state))
        && evidence.wav instanceof Blob && evidence.wav.type === 'audio/wav'
        && evidence.sampleRate === 24000 && evidence.duration > 0 && evidence.peak >= 0.001
        && evidence.rms >= 0.0001 && record.nativeEndedEvents > 0
        && Number.isFinite(record.firstPlayingMs) && !evidence.problem
      record.status = valid ? 'success' : 'failed'
      if (!valid) { delete record.wav; delete record.url }
      return record
    },
    manifest(extra = {}) {
      return {
        schema: 'airi-local-kokoro-audition-v1', createdAt: new Date().toISOString(),
        model: MODEL_ID, revision: 'main', dtype: 'fp32', concealedLabelMapping: VOICES,
        maximumNeutralAuditionItems: 12, maximumOptionalMatrixItems: 4,
        maximumNewDeliveryAuditionItems: 3, maximumTotalAuditionItems: 15,
        inferenceCountPolicy: 'audition item caps are not physical model-call caps; actual generate_from_ids calls are instrumented',
        expectedProductionSentenceCounts: [2, 1, 1, 2], expectedBaselineInferenceMinimum: 18, expectedOptionalNewInferenceMinimum: 4,
        optionalNeutralReusesBaseline: true, selectedDeliveryLabel: selected,
        defaultVoiceChanged: false, qualityVerdict: 'unproven; human listening and selection required',
        deliveryControl: 'production speed changes only; not expressive model instructions',
        ...extra, records: [...records.values()].map(({ wav, url, ...record }) => record),
      }
    },
  }
}

async function bytesIn(response) {
  const reader = response.body?.getReader()
  if (!reader) return 0
  let bytes = 0
  while (true) { const result = await reader.read(); if (result.done) break; bytes += result.value.byteLength }
  return bytes
}

// Read only this browser origin's exact installed-library cache contract.
// No remote HEAD/GET and no cache writes. Runtime/voice verification is local.
export async function inspectCache({ cacheStorage, fetchLocal, origin, base = '/airi/' }) {
  const assets = [], responses = new Map()
  const cache = (await cacheStorage.keys()).includes(CACHE_NAME) ? await cacheStorage.open(CACHE_NAME) : null
  let config = null
  for (const file of MODEL_FILES) {
    const url = MODEL_BASE + file
    const response = await cache?.match(url)
    const asset = { kind: 'model-cache', file, url, ready: false, bytes: 0, reason: 'exact cache key missing' }
    if (response?.ok && response.type !== 'opaque') {
      try {
        if (file.endsWith('.json')) {
          const json = await response.clone().json()
          if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('JSON object required')
          if (file === 'config.json') {
            config = json
            if (json.model_type !== 'style_text_to_speech_2') throw new Error('unexpected model_type')
          }
          if (file === 'tokenizer.json' && !json.model) throw new Error('tokenizer model missing')
          if (file === 'tokenizer_config.json' && !json.tokenizer_class) throw new Error('tokenizer_class missing')
        }
        asset.bytes = await bytesIn(response.clone())
        const declared = Number(response.headers.get('content-length'))
        if (!asset.bytes || (declared > 0 && declared !== asset.bytes)) throw new Error('empty/truncated cached body')
        // Known fp32 artifact is about 339 MB; this is a completeness sanity
        // threshold, not a content hash or proof that ONNX inference will work.
        if (file.endsWith('.onnx') && asset.bytes < 300_000_000) throw new Error('fp32 cached model unexpectedly small (<300 MB)')
        asset.ready = true; asset.reason = 'exact cached response body checked (not a model hash)'
        responses.set(url, response)
      }
      catch (error) { asset.reason = error.message }
    }
    assets.push(asset)
  }
  // Do not pretend a one-file ONNX cache covers external-data model variants.
  const options = config?.['transformers.js_config']
  if (options?.use_external_data_format || Object.values(options?.device_config ?? {}).some(value => value.use_external_data_format)) {
    assets.push({ kind: 'model-cache', file: 'external-data configuration', ready: false, reason: 'requires separate installed-loader asset derivation; this page refuses this variant' })
  }
  for (const file of [...RUNTIME_FILES.map(file => RUNTIME_BASE + file), ...VOICES.map(({ voice }) => `${base}kokoro/voices/${voice}.bin`)]) {
    const url = new URL(file, origin).href
    const asset = { kind: file.endsWith('.bin') ? 'installed-voice' : 'installed-runtime', file, url, ready: false, bytes: 0 }
    try {
      const response = await fetchLocal(url, { method: 'HEAD' })
      asset.bytes = Number(response.headers.get('content-length'))
      const mime = response.headers.get('content-type') ?? ''
      let localBodyChecked = false
      // Vite transforms installed .mjs and omits length on HEAD. Read that
      // small, already-installed local module, never a remote runtime URL.
      if (response.ok && file.endsWith('.mjs') && /javascript/.test(mime) && !asset.bytes) {
        const body = await fetchLocal(url)
        if (body.ok && /javascript/.test(body.headers.get('content-type') ?? '')) {
          asset.bytes = await bytesIn(body)
          localBodyChecked = true
        }
      }
      asset.ready = response.ok && asset.bytes > 0 && !mime.includes('text/html')
        && (file.endsWith('.mjs') ? /javascript/.test(mime) : file.endsWith('.wasm') ? /wasm/.test(mime) : asset.bytes % 4 === 0)
      asset.reason = asset.ready ? `installed local asset ${localBodyChecked ? 'GET body' : 'HEAD'} verified` : `local asset invalid/missing: HTTP ${response.status}, ${mime}, ${asset.bytes} bytes`
    }
    catch (error) { asset.reason = error.message }
    assets.push(asset)
  }
  return { ready: assets.every(asset => asset.ready), assets, responses, checkedAt: new Date().toISOString(),
    modelDownloadEstimate: 'fp32 model.onnx about 339 MB (323 MiB), plus config/tokenizer/runtime; no download authorized',
  }
}

export function cacheOnlyFetch(originalFetch, { origin, responses, counters }) {
  return async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, origin)
    const method = (init?.method ?? input?.method ?? 'GET').toUpperCase()
    if (!['GET', 'HEAD'].includes(method) || (url.origin === origin && /\/api\//.test(url.pathname))) {
      counters.blocked++; throw new Error('试听页禁止 API/写入请求')
    }
    if (url.origin !== origin) {
      const response = responses.get(url.href)
      if (!response) { counters.blocked++; throw new Error(`无下载授权，拒绝外部请求：${url.href}`) }
      counters.externalCacheReads++
      return method === 'HEAD' ? new Response(null, { status: response.status, headers: response.headers }) : response.clone()
    }
    counters.localRequests++
    return originalFetch(input, init)
  }
}

export async function inspectWav(blob) {
  const buffer = await blob.arrayBuffer(), view = new DataView(buffer)
  const tag = at => String.fromCharCode(...new Uint8Array(buffer, at, 4))
  if (buffer.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || tag(36) !== 'data'
    || view.getUint32(4, true) + 8 !== buffer.byteLength || view.getUint32(40, true) + 44 !== buffer.byteLength)
    throw new Error('不是完整的生产 WAV')
  const sampleRate = view.getUint32(24, true), bytes = view.getUint32(40, true)
  if (view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1 || view.getUint16(34, true) !== 16 || sampleRate !== 24000 || !bytes)
    throw new Error('不是预期的 24 kHz 单声道 PCM16')
  let peak = 0, energy = 0
  for (let offset = 44; offset < buffer.byteLength; offset += 2) {
    const sample = view.getInt16(offset, true) / 32768
    peak = Math.max(peak, Math.abs(sample)); energy += sample * sample
  }
  const rms = Math.sqrt(energy / (bytes / 2))
  if (peak < 0.001 || rms < 0.0001) throw new Error('完整 WAV 的 PCM 为静音或过低能量')
  return { sampleRate, duration: bytes / 2 / sampleRate, bytes: buffer.byteLength, peak, rms }
}
