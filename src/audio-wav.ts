const HEADER_BYTES = 44
const BYTES_PER_SAMPLE = 2
const MAX_UINT32 = 0xffff_ffff

// Mono PCM16, retaining the original quantization of the speech player. A
// native Blob snapshot lets queued playback and full replay share this part,
// rather than retaining every historical Float32 buffer and encoding it again.
export function createPcm16Blob(samples: Float32Array): Blob {
  if (!(samples instanceof Float32Array))
    throw new TypeError('Expected Float32 PCM')
  const buffer = new ArrayBuffer(samples.length * BYTES_PER_SAMPLE)
  const view = new DataView(buffer)
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index]!
    if (!Number.isFinite(sample))
      throw new RangeError('Invalid PCM sample')
    const clamped = Math.max(-1, Math.min(1, sample))
    view.setInt16(index * BYTES_PER_SAMPLE, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
  }
  return new Blob([buffer])
}

// Validate lengths before writing the RIFF uint32 fields; never wrap a very
// long reply into a misleading playable header. No duration-based truncation.
export function createWavHeader(sampleRate: number, sampleCount: number): ArrayBuffer {
  if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0 || sampleRate * BYTES_PER_SAMPLE > MAX_UINT32
    || !Number.isSafeInteger(sampleCount) || sampleCount < 0
    || sampleCount * BYTES_PER_SAMPLE > MAX_UINT32 - 36)
    throw new RangeError('Invalid WAV dimensions')
  const buffer = new ArrayBuffer(HEADER_BYTES)
  const view = new DataView(buffer)
  const writeText = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++)
      view.setUint8(offset + index, value.charCodeAt(index))
  }
  const dataBytes = sampleCount * BYTES_PER_SAMPLE
  writeText(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeText(8, 'WAVE')
  writeText(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true)
  view.setUint16(32, BYTES_PER_SAMPLE, true)
  view.setUint16(34, 16, true)
  writeText(36, 'data')
  view.setUint32(40, dataBytes, true)
  return buffer
}

export function createWavBlob(parts: readonly Blob[], sampleRate: number): Blob {
  let dataBytes = 0
  for (const part of parts) {
    if (!(part instanceof Blob) || part.size % BYTES_PER_SAMPLE)
      throw new TypeError('Invalid PCM16 part')
    dataBytes += part.size
  }
  const header = createWavHeader(sampleRate, dataBytes / BYTES_PER_SAMPLE)
  // Avoid a full-length JS Float32/WAV ArrayBuffer, even for complete replay.
  // This does not assume native Blob implementations are internally zero-copy.
  return new Blob([header, ...parts], { type: 'audio/wav' })
}
