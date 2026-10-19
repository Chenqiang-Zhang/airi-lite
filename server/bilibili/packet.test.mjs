import assert from 'node:assert/strict'
import test from 'node:test'
import { brotliCompressSync, deflateSync } from 'node:zlib'

import { decodePackets, encodePacket, HEADER_LENGTH, MAX_INFLATED_BYTES, OP, VERSION } from './packet.mjs'

const message = cmd => JSON.stringify({ cmd, data: { msg: '你好', msg_id: cmd } })
const text = packet => packet.body.toString('utf8')

test('encodes the 16-byte big-endian header exactly', () => {
  const packet = encodePacket(OP.AUTH, '{"a":1}')
  assert.equal(packet.length, HEADER_LENGTH + 7)
  assert.deepEqual([...packet.subarray(0, HEADER_LENGTH)], [
    0, 0, 0, 23, // packetLength incl. header
    0, 16, // headerLength
    0, 0, // version 0 = JSON
    0, 0, 0, 7, // operation
    0, 0, 0, 1, // sequence
  ])
  assert.equal(packet.subarray(HEADER_LENGTH).toString(), '{"a":1}')
  assert.equal(encodePacket(OP.HEARTBEAT).length, HEADER_LENGTH)
})

test('round-trips UTF-8 bodies through Buffer, ArrayBuffer and typed-array views', () => {
  const packet = encodePacket(OP.MESSAGE, message('LIVE_OPEN_PLATFORM_DM'), { sequence: 9 })
  const arrayBuffer = packet.buffer.slice(packet.byteOffset, packet.byteOffset + packet.length)
  const padded = new Uint8Array(packet.length + 8)
  padded.set(packet, 4)
  for (const input of [packet, arrayBuffer, padded.subarray(4, 4 + packet.length)]) {
    const { packets, errors } = decodePackets(input)
    assert.deepEqual(errors, [])
    assert.equal(packets.length, 1)
    assert.equal(packets[0].operation, OP.MESSAGE)
    assert.equal(packets[0].version, VERSION.JSON)
    assert.equal(packets[0].sequence, 9)
    assert.deepEqual(JSON.parse(text(packets[0])), JSON.parse(message('LIVE_OPEN_PLATFORM_DM')))
  }
})

test('splits several concatenated packets in one frame', () => {
  const frame = Buffer.concat([encodePacket(OP.HEARTBEAT_REPLY, Buffer.from([0, 0, 0, 1]), { version: VERSION.INT }),
    encodePacket(OP.MESSAGE, message('A')), encodePacket(OP.AUTH_REPLY, '{"code":0}')])
  const { packets, errors } = decodePackets(frame)
  assert.deepEqual(errors, [])
  assert.deepEqual(packets.map(packet => packet.operation), [OP.HEARTBEAT_REPLY, OP.MESSAGE, OP.AUTH_REPLY])
  assert.deepEqual([...packets[0].body], [0, 0, 0, 1])
})

for (const [name, version, compress] of [['zlib', VERSION.ZLIB, deflateSync], ['brotli', VERSION.BROTLI, brotliCompressSync]]) {
  test(`${name} (version ${version}) frames recursively expand into several whole packets`, () => {
    const inner = Buffer.concat(['LIVE_OPEN_PLATFORM_DM', 'LIVE_OPEN_PLATFORM_SEND_GIFT', 'LIVE_OPEN_PLATFORM_LIKE']
      .map(cmd => encodePacket(OP.MESSAGE, message(cmd))))
    const frame = Buffer.concat([
      encodePacket(OP.MESSAGE, compress(inner), { version }),
      encodePacket(OP.MESSAGE, message('TRAILING_PLAIN')),
    ])
    const { packets, errors } = decodePackets(frame)
    assert.deepEqual(errors, [])
    assert.deepEqual(packets.map(packet => JSON.parse(text(packet)).cmd),
      ['LIVE_OPEN_PLATFORM_DM', 'LIVE_OPEN_PLATFORM_SEND_GIFT', 'LIVE_OPEN_PLATFORM_LIKE', 'TRAILING_PLAIN'])
    assert.ok(packets.every(packet => packet.version === VERSION.JSON))
  })
}

test('malformed lengths and data never throw and keep packets parsed before the fault', () => {
  const good = encodePacket(OP.MESSAGE, message('GOOD'))
  const cases = [
    [Buffer.from([0, 0, 0]), [], ['PACKET_TRUNCATED']],
    [Buffer.concat([good, good.subarray(0, 10)]), ['GOOD'], ['PACKET_TRUNCATED']],
    [(() => { const bad = Buffer.from(good); bad.writeUInt32BE(good.length + 50, 0); return bad })(), [], ['PACKET_TRUNCATED']],
    [(() => { const bad = Buffer.from(good); bad.writeUInt32BE(4, 0); return bad })(), [], ['PACKET_HEADER_INVALID']],
    [(() => { const bad = Buffer.from(good); bad.writeUInt16BE(8, 4); return bad })(), [], ['PACKET_HEADER_INVALID']],
    [(() => { const bad = Buffer.from(good); bad.writeUInt32BE(0, 0); return bad })(), [], ['PACKET_HEADER_INVALID']],
    [Buffer.concat([good, encodePacket(OP.MESSAGE, 'not zlib', { version: VERSION.ZLIB }), good]), ['GOOD', 'GOOD'],
      ['PACKET_INFLATE_FAILED']],
    [Buffer.concat([encodePacket(OP.MESSAGE, 'not brotli', { version: VERSION.BROTLI })]), [], ['PACKET_INFLATE_FAILED']],
    ['a string frame', [], ['PACKET_UNSUPPORTED_DATA']],
    [null, [], ['PACKET_UNSUPPORTED_DATA']],
  ]
  for (const [input, cmds, expectedErrors] of cases) {
    const { packets, errors } = decodePackets(input)
    assert.deepEqual(packets.map(packet => JSON.parse(text(packet)).cmd), cmds)
    assert.deepEqual(errors, expectedErrors)
  }
})

test('a larger header length is honoured and an empty frame decodes to nothing', () => {
  const body = Buffer.from(message('WIDE'))
  const packet = Buffer.alloc(20 + body.length)
  packet.writeUInt32BE(packet.length, 0)
  packet.writeUInt16BE(20, 4)
  packet.writeUInt32BE(OP.MESSAGE, 8)
  body.copy(packet, 20)
  assert.equal(JSON.parse(text(decodePackets(packet).packets[0])).cmd, 'WIDE')
  assert.deepEqual(decodePackets(Buffer.alloc(0)), { packets: [], errors: [] })
})

test('compression bombs and unbounded nesting are rejected', () => {
  const huge = encodePacket(OP.MESSAGE, Buffer.alloc(MAX_INFLATED_BYTES + 1))
  assert.deepEqual(decodePackets(encodePacket(OP.MESSAGE, deflateSync(huge), { version: VERSION.ZLIB })).errors,
    ['PACKET_TOO_LARGE'])
  assert.deepEqual(decodePackets(encodePacket(OP.MESSAGE, brotliCompressSync(huge), { version: VERSION.BROTLI })).errors,
    ['PACKET_TOO_LARGE'])
  const custom = decodePackets(encodePacket(OP.MESSAGE, deflateSync(encodePacket(OP.MESSAGE, message('X'))),
    { version: VERSION.ZLIB }), { maxInflatedBytes: 8 })
  assert.deepEqual(custom.errors, ['PACKET_TOO_LARGE'])

  let nested = encodePacket(OP.MESSAGE, message('DEEP'))
  for (let level = 0; level < 3; level += 1)
    nested = encodePacket(OP.MESSAGE, deflateSync(nested), { version: VERSION.ZLIB })
  assert.deepEqual(decodePackets(nested), { packets: [], errors: ['PACKET_TOO_DEEP'] })
  let twice = encodePacket(OP.MESSAGE, message('TWICE'))
  for (let level = 0; level < 2; level += 1)
    twice = encodePacket(OP.MESSAGE, deflateSync(twice), { version: VERSION.ZLIB })
  assert.equal(JSON.parse(text(decodePackets(twice).packets[0])).cmd, 'TWICE')
})
