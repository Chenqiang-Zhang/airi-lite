import { brotliDecompressSync, inflateSync } from 'node:zlib'

// Long-connection framing shared by the open platform and the web protocol:
// a 16-byte big-endian header followed by the body.
// [uint32 packetLength incl. header][uint16 headerLength][uint16 version]
// [uint32 operation][uint32 sequence]
export const HEADER_LENGTH = 16
export const OP = Object.freeze({
  HEARTBEAT: 2,
  HEARTBEAT_REPLY: 3,
  MESSAGE: 5,
  AUTH: 7,
  AUTH_REPLY: 8,
})
export const VERSION = Object.freeze({
  JSON: 0,
  INT: 1, // Raw body (e.g. a 4-byte popularity value on the web protocol).
  ZLIB: 2,
  BROTLI: 3,
})
// A single compressed frame may expand into several whole packets. Bound both
// the inflated size and the nesting depth so a hostile or corrupted frame
// cannot exhaust memory or recurse without end.
export const MAX_INFLATED_BYTES = 4 * 1_024 * 1_024
const MAX_DEPTH = 2

export function encodePacket(operation, body = '', { version = VERSION.JSON, sequence = 1 } = {}) {
  const payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body)
  const packet = Buffer.alloc(HEADER_LENGTH + payload.length)
  packet.writeUInt32BE(packet.length, 0)
  packet.writeUInt16BE(HEADER_LENGTH, 4)
  packet.writeUInt16BE(version, 6)
  packet.writeUInt32BE(operation, 8)
  packet.writeUInt32BE(sequence, 12)
  payload.copy(packet, HEADER_LENGTH)
  return packet
}

// Never throws. Returns every packet that could be parsed and the error codes
// of whatever could not, so one bad frame cannot take the connection down.
// Compressed packets are replaced by the packets they contain.
export function decodePackets(data, { maxInflatedBytes = MAX_INFLATED_BYTES } = {}) {
  const packets = []
  const errors = []
  const buffer = toBuffer(data)
  if (!buffer)
    errors.push('PACKET_UNSUPPORTED_DATA')
  else
    split(buffer, 0, packets, errors, maxInflatedBytes)
  return { packets, errors }
}

function split(buffer, depth, packets, errors, maxInflatedBytes) {
  let offset = 0
  while (offset < buffer.length) {
    if (buffer.length - offset < HEADER_LENGTH) {
      errors.push('PACKET_TRUNCATED')
      return
    }
    const packetLength = buffer.readUInt32BE(offset)
    const headerLength = buffer.readUInt16BE(offset + 4)
    // There is no way to resynchronise after a bad length, so stop here.
    if (headerLength < HEADER_LENGTH || packetLength < headerLength) {
      errors.push('PACKET_HEADER_INVALID')
      return
    }
    if (packetLength > buffer.length - offset) {
      errors.push('PACKET_TRUNCATED')
      return
    }
    const version = buffer.readUInt16BE(offset + 6)
    const operation = buffer.readUInt32BE(offset + 8)
    const sequence = buffer.readUInt32BE(offset + 12)
    const body = buffer.subarray(offset + headerLength, offset + packetLength)
    offset += packetLength
    if (version === VERSION.ZLIB || version === VERSION.BROTLI) {
      if (depth >= MAX_DEPTH) {
        errors.push('PACKET_TOO_DEEP')
        continue
      }
      let inflated
      try {
        inflated = version === VERSION.ZLIB
          ? inflateSync(body, { maxOutputLength: maxInflatedBytes })
          : brotliDecompressSync(body, { maxOutputLength: maxInflatedBytes })
      }
      catch (error) {
        errors.push(error?.code === 'ERR_BUFFER_TOO_LARGE' ? 'PACKET_TOO_LARGE' : 'PACKET_INFLATE_FAILED')
        continue
      }
      split(inflated, depth + 1, packets, errors, maxInflatedBytes)
      continue
    }
    packets.push({ operation, version, sequence, body })
  }
}

function toBuffer(data) {
  if (Buffer.isBuffer(data))
    return data
  if (data instanceof ArrayBuffer)
    return Buffer.from(data)
  if (ArrayBuffer.isView(data))
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  return null
}
