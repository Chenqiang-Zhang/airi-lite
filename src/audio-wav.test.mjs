import assert from 'node:assert/strict'
import test from 'node:test'
import { createPcm16Blob, createWavBlob, createWavHeader } from './audio-wav.ts'

const ascii = (view, offset, length) => String.fromCharCode(...new Uint8Array(view.buffer, offset, length))

test('PCM16 snapshots preserve clipping, asymmetric gain, truncation and little-endian bytes', async () => {
  const samples = Float32Array.of(-2, -1, -0.5, -0.00001, 0, 0.00001, 0.5, 1, 2)
  const blob = createPcm16Blob(samples)
  samples.fill(1)
  const view = new DataView(await blob.arrayBuffer())
  assert.equal(blob.size, 18)
  assert.deepEqual(Array.from({ length: 9 }, (_, index) => view.getInt16(index * 2, true)),
    [-32768, -32768, -16384, 0, 0, 0, 16383, 32767, 32767])
})

test('invalid PCM samples and non-Float32 input cannot become an encoded part', () => {
  for (const sample of [NaN, Infinity, -Infinity])
    assert.throws(() => createPcm16Blob(Float32Array.of(sample)), RangeError)
  for (const input of [null, [], new Float64Array(1), new Int16Array(1)])
    assert.throws(() => createPcm16Blob(input), TypeError)
})

test('WAV header records actual mono PCM16 sample count and sample rate', () => {
  for (const rate of [24000, 32000, 44100, 48000, 96000]) {
    const header = createWavHeader(rate, 44101)
    const view = new DataView(header)
    assert.equal(header.byteLength, 44)
    assert.equal(ascii(view, 0, 4), 'RIFF')
    assert.equal(view.getUint32(4, true), 36 + 44101 * 2)
    assert.equal(ascii(view, 8, 8), 'WAVEfmt ')
    assert.equal(view.getUint32(16, true), 16)
    assert.equal(view.getUint16(20, true), 1)
    assert.equal(view.getUint16(22, true), 1)
    assert.equal(view.getUint32(24, true), rate)
    assert.equal(view.getUint32(28, true), rate * 2)
    assert.equal(view.getUint16(32, true), 2)
    assert.equal(view.getUint16(34, true), 16)
    assert.equal(ascii(view, 36, 4), 'data')
    assert.equal(view.getUint32(40, true), 88202)
  }
})

test('RIFF lengths and byte rates are checked before uint32 writes, without allocating a giant buffer', () => {
  const largestSamples = Math.floor((0xffff_ffff - 36) / 2)
  assert.equal(new DataView(createWavHeader(44100, largestSamples)).getUint32(4, true), 0xffff_fffe)
  for (const count of [-1, 0.5, NaN, Infinity, largestSamples + 1, Number.MAX_SAFE_INTEGER])
    assert.throws(() => createWavHeader(24000, count), RangeError)
  for (const rate of [0, -1, 44100.5, NaN, Infinity, 0x8000_0000])
    assert.throws(() => createWavHeader(rate, 1), RangeError)
})

test('part composition is byte-exact across unequal clips, silence and replay orders', async () => {
  const clips = [Float32Array.of(0, 0.25, -0.25), Float32Array.of(0, 0), Float32Array.of(1, -1, 0.7, -0.1)]
  const parts = clips.map(createPcm16Blob)
  for (const indexes of [[0], [1, 2], [0, 1, 2], [2, 0]]) {
    const wav = createWavBlob(indexes.map(index => parts[index]), 44100)
    const expectedPcm = new Blob(indexes.map(index => parts[index]))
    const encoded = await wav.arrayBuffer()
    assert.equal(wav.type, 'audio/wav')
    assert.equal(wav.size, 44 + expectedPcm.size)
    assert.equal(new DataView(encoded).getUint32(40, true), expectedPcm.size)
    assert.deepEqual(new Uint8Array(encoded, 44), new Uint8Array(await expectedPcm.arrayBuffer()))
  }
})

test('full cached composition allocates only its 44-byte explicit header, not a full reply float/WAV buffer', async () => {
  const parts = Array.from({ length: 60 }, () => createPcm16Blob(new Float32Array(2400).fill(0.2)))
  const OriginalBuffer = globalThis.ArrayBuffer
  const OriginalFloat32 = globalThis.Float32Array
  const buffers = [], floats = []
  let wav
  try {
    globalThis.ArrayBuffer = new Proxy(OriginalBuffer, { construct(target, args) {
      buffers.push(args[0]); return Reflect.construct(target, args)
    } })
    globalThis.Float32Array = new Proxy(OriginalFloat32, { construct(target, args) {
      floats.push(args[0]); return Reflect.construct(target, args)
    } })
    wav = createWavBlob(parts, 24000)
  }
  finally {
    globalThis.ArrayBuffer = OriginalBuffer
    globalThis.Float32Array = OriginalFloat32
  }
  assert.deepEqual(buffers, [44])
  assert.deepEqual(floats, [])
  assert.equal(wav.size, 44 + 60 * 2400 * 2)
  const view = new DataView(await wav.arrayBuffer())
  for (let offset = 44; offset < wav.size; offset += 2)
    assert.equal(view.getInt16(offset, true), 6553)
})

test('WAV composition rejects odd-byte/non-Blob parts and supports an explicit empty container', async () => {
  for (const parts of [[new Blob([new Uint8Array(1)])], [new Uint8Array(2)], [null]])
    assert.throws(() => createWavBlob(parts, 24000), TypeError)
  const wav = createWavBlob([], 24000)
  assert.equal(wav.size, 44)
  assert.equal(new DataView(await wav.arrayBuffer()).getUint32(40, true), 0)
})
