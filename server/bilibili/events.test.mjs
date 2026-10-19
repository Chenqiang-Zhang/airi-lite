import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'

import { CMD, createEventNormalizer, normalizeOpenLiveMessage } from './events.mjs'

const directory = new URL('./fixtures/', import.meta.url)
const fixture = cmd => JSON.parse(readFileSync(new URL(`${cmd}.json`, directory), 'utf8'))
const NOW = () => Date.UTC(2026, 9, 19, 12)
const normalize = message => normalizeOpenLiveMessage(message, { now: NOW })
const viewerA = {
  openId: '39b8fedb-60a5-4e29-ac75-b16955f7e632', name: '测试观众甲', face: 'https://i0.hdslb.test/bfs/face/viewer-a.jpg',
  guardLevel: 3, medalName: '小测', medalLevel: 12, isAdmin: false,
}

test('there is exactly one fixture per documented cmd, each named after it', () => {
  const files = readdirSync(directory).filter(name => name.endsWith('.json')).sort()
  assert.deepEqual(files, Object.values(CMD).map(cmd => `${cmd}.json`).sort())
  for (const cmd of Object.values(CMD))
    assert.equal(fixture(cmd).cmd, cmd)
})

test('LIVE_OPEN_PLATFORM_DM → danmaku keyed by open_id, seconds → ms', () => {
  assert.deepEqual(normalize(fixture(CMD.DM)), {
    type: 'danmaku', cmd: CMD.DM, msgId: '8a2f1c40-0d3e-4c55-9d7e-0b1f4e7a0001', ts: 1_760_875_200_000, roomId: 4_242,
    user: viewerA, text: '主播晚上好！', emoji: null, amountCny: 0, mirror: false, replyTo: null,
  })
})

test('emoji danmaku (dm_type 1), replies and admins are flagged', () => {
  const message = fixture(CMD.DM)
  Object.assign(message.data, {
    dm_type: 1, msg: '[dog]', emoji_img_url: 'https://i0.hdslb.test/emoji/dog.png', is_admin: 1,
    reply_open_id: 'other-open-id', reply_uname: '被回复的人',
  })
  const event = normalize(message)
  assert.deepEqual(event.emoji, { url: 'https://i0.hdslb.test/emoji/dog.png' })
  assert.equal(event.text, '[dog]')
  assert.equal(event.user.isAdmin, true)
  assert.deepEqual(event.replyTo, { openId: 'other-open-id', name: '被回复的人' })
})

test('LIVE_OPEN_PLATFORM_DM_MIRROR → danmaku flagged mirror with no sender', () => {
  assert.deepEqual(normalize(fixture(CMD.DM_MIRROR)), {
    type: 'danmaku', cmd: CMD.DM_MIRROR, msgId: '8a2f1c40-0d3e-4c55-9d7e-0b1f4e7a0002', ts: 1_760_875_201_000, roomId: 4_242,
    user: null, text: '来自另一个直播间的弹幕', emoji: null, amountCny: 0, mirror: true, replyTo: null,
  })
})

test('LIVE_OPEN_PLATFORM_SEND_GIFT → gift with r_price × gift_num / 1000 CNY and combo info', () => {
  assert.deepEqual(normalize(fixture(CMD.SEND_GIFT)), {
    type: 'gift', cmd: CMD.SEND_GIFT, msgId: '8a2f1c40-0d3e-4c55-9d7e-0b1f4e7a0003', ts: 1_760_875_202_000, roomId: 4_242,
    user: {
      openId: '5c0e7a1d-2b43-4f6e-8d21-3a9c7e5b0b02', name: '测试观众乙', face: 'https://i0.hdslb.test/bfs/face/viewer-b.jpg',
      guardLevel: 0, medalName: '小测', medalLevel: 3, isAdmin: false,
    },
    text: '', emoji: null, amountCny: 0.3,
    gift: {
      id: 31_036, name: '小花花', num: 3, price: 100, rPrice: 100, paid: true,
      icon: 'https://i0.hdslb.test/bfs/live/gift-flower.png',
      combo: { id: 'combo-7f2a', count: 3, baseNum: 1, timeoutSec: 3 },
      blind: null,
    },
  })
})

test('free gifts are worth 0 CNY and blind gifts use r_price (the box value)', () => {
  const free = fixture(CMD.SEND_GIFT)
  Object.assign(free.data, { paid: false, price: 100, r_price: 100, gift_num: 10, combo_gift: false })
  assert.equal(normalize(free).amountCny, 0)
  assert.equal(normalize(free).gift.combo, null)

  const blind = fixture(CMD.SEND_GIFT)
  Object.assign(blind.data, { gift_num: 2, price: 15_000, r_price: 10_000, blind_gift: { blind_gift_id: 32_251, status: true } })
  const event = normalize(blind)
  assert.equal(event.amountCny, 20)
  assert.deepEqual(event.gift.blind, { id: 32_251 })

  const legacy = fixture(CMD.SEND_GIFT)
  delete legacy.data.r_price
  assert.equal(normalize(legacy).amountCny, 0.3, 'falls back to price when r_price is absent')
})

test('LIVE_OPEN_PLATFORM_SUPER_CHAT → superchat in CNY with message id and ms times', () => {
  assert.deepEqual(normalize(fixture(CMD.SUPER_CHAT)), {
    type: 'superchat', cmd: CMD.SUPER_CHAT, msgId: '8a2f1c40-0d3e-4c55-9d7e-0b1f4e7a0004', ts: 1_760_875_203_000, roomId: 4_242,
    user: {
      openId: 'a1f3c9e2-7d64-4b8a-9e05-6c2d8f1a0c03', name: '测试观众丙', face: 'https://i0.hdslb.test/bfs/face/viewer-c.jpg',
      guardLevel: 0, medalName: '', medalLevel: 0, isAdmin: false,
    },
    text: '第一次看直播，加油！', emoji: null, amountCny: 30,
    superchat: { id: '9001234', startTime: 1_760_875_203_000, endTime: 1_760_875_263_000 },
  })
})

test('LIVE_OPEN_PLATFORM_SUPER_CHAT_DEL → superchat-delete with string ids matching superchat.id', () => {
  const event = normalize(fixture(CMD.SUPER_CHAT_DEL))
  assert.deepEqual(event, {
    type: 'superchat-delete', cmd: CMD.SUPER_CHAT_DEL, msgId: '8a2f1c40-0d3e-4c55-9d7e-0b1f4e7a0005', ts: NOW(), roomId: 4_242,
    user: null, text: '', emoji: null, amountCny: 0, messageIds: ['9001234', '9001235'],
  })
  assert.ok(event.messageIds.includes(normalize(fixture(CMD.SUPER_CHAT)).superchat.id))
})

test('LIVE_OPEN_PLATFORM_GUARD → guard from user_info, price in 金瓜子 / 1000', () => {
  assert.deepEqual(normalize(fixture(CMD.GUARD)), {
    type: 'guard', cmd: CMD.GUARD, msgId: '8a2f1c40-0d3e-4c55-9d7e-0b1f4e7a0006', ts: 1_760_875_204_000, roomId: 4_242,
    user: {
      openId: 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e0d04', name: '测试观众丁', face: 'https://i0.hdslb.test/bfs/face/viewer-d.jpg',
      guardLevel: 3, medalName: '小测', medalLevel: 21, isAdmin: false,
    },
    text: '', emoji: null, amountCny: 198, guard: { level: 3, num: 1, unit: '月', price: 198_000 },
  })
})

test('LIVE_OPEN_PLATFORM_LIKE → like with like_count', () => {
  assert.deepEqual(normalize(fixture(CMD.LIKE)), {
    type: 'like', cmd: CMD.LIKE, msgId: '8a2f1c40-0d3e-4c55-9d7e-0b1f4e7a0007', ts: 1_760_875_205_000, roomId: 4_242,
    user: viewerA, text: '为主播点赞了', emoji: null, amountCny: 0, likeCount: 5,
  })
})

test('LIVE_OPEN_PLATFORM_LIVE_ROOM_ENTER → enter', () => {
  assert.deepEqual(normalize(fixture(CMD.LIVE_ROOM_ENTER)), {
    type: 'enter', cmd: CMD.LIVE_ROOM_ENTER, msgId: null, ts: 1_760_875_206_000, roomId: 4_242,
    user: {
      openId: 'e6f7a8b9-c0d1-4e2f-a3b4-c5d6e7f80e05', name: '测试观众戊', face: 'https://i0.hdslb.test/bfs/face/viewer-e.jpg',
      guardLevel: 0, medalName: '', medalLevel: 0, isAdmin: false,
    },
    text: '', emoji: null, amountCny: 0,
  })
})

test('LIVE_OPEN_PLATFORM_LIVE_START / _LIVE_END → live-start / live-end', () => {
  assert.deepEqual(normalize(fixture(CMD.LIVE_START)), {
    type: 'live-start', cmd: CMD.LIVE_START, msgId: null, ts: 1_760_875_100_000, roomId: 4_242,
    user: null, text: '', emoji: null, amountCny: 0, live: { title: 'AI 主播测试直播', areaName: '虚拟日常' },
  })
  const end = normalize(fixture(CMD.LIVE_END))
  assert.equal(end.type, 'live-end')
  assert.equal(end.ts, 1_760_882_400_000)
})

test('LIVE_OPEN_PLATFORM_INTERACTION_END → interaction-end carrying the game id', () => {
  assert.deepEqual(normalize(fixture(CMD.INTERACTION_END)), {
    type: 'interaction-end', cmd: CMD.INTERACTION_END, msgId: null, ts: 1_760_882_401_000, roomId: null,
    user: null, text: '', emoji: null, amountCny: 0, gameId: 'game-1',
  })
})

test('unknown cmds and junk never throw', () => {
  assert.deepEqual(normalize({ cmd: 'LIVE_OPEN_PLATFORM_FUTURE', data: { msg_id: 'm' } }), {
    type: 'unknown', cmd: 'LIVE_OPEN_PLATFORM_FUTURE', msgId: 'm', ts: NOW(), roomId: null,
    user: null, text: '', emoji: null, amountCny: 0,
  })
  for (const junk of [null, undefined, 42, 'text', [], { cmd: 7 }, { cmd: CMD.DM, data: null }, { cmd: CMD.DM, data: [1] }])
    assert.doesNotThrow(() => normalize(junk))
  assert.equal(normalize(null).type, 'unknown')
  assert.equal(normalize({ cmd: CMD.DM, data: null }).type, 'danmaku')
})

test('hostile field types are coerced to safe values', () => {
  const event = normalize({
    cmd: CMD.SEND_GIFT,
    data: {
      uname: { toString: () => 'x' }, open_id: 7, gift_num: '-3', price: 'NaN', r_price: 1e400, paid: 'yes',
      guard_level: 9, fans_medal_level: -1, timestamp: '1760875202', room_id: '4242', combo_gift: 1, combo_info: null,
    },
  })
  assert.equal(event.user.name, '')
  assert.equal(event.user.openId, '7')
  assert.equal(event.user.guardLevel, 0)
  assert.equal(event.user.medalLevel, 0)
  assert.equal(event.gift.num, 0)
  assert.equal(event.gift.paid, false)
  assert.equal(event.amountCny, 0)
  assert.equal(event.ts, 1_760_875_202_000)
  assert.equal(event.roomId, 4_242)
  assert.deepEqual(event.gift.combo, { id: '', count: 0, baseNum: 0, timeoutSec: 0 })
  const sc = normalize({ cmd: CMD.SUPER_CHAT, data: { rmb: '-5', start_time: 'soon' } })
  assert.equal(sc.amountCny, 0)
  assert.equal(sc.superchat.startTime, null)
  assert.equal(normalize({ cmd: CMD.SUPER_CHAT, data: { rmb: '50' } }).amountCny, 50)
  assert.equal(normalize({ cmd: CMD.DM, data: { timestamp: 1_760_875_200_123 } }).ts, 1_760_875_200_123)
})

test('raw is omitted by default and included on request', () => {
  const message = fixture(CMD.DM)
  assert.equal('raw' in normalize(message), false)
  assert.equal(normalizeOpenLiveMessage(message, { includeRaw: true }).raw, message)
})

test('the normaliser drops repeated cmd + msg_id with a bounded LRU', () => {
  const normalizeOnce = createEventNormalizer({ now: NOW, maxRemembered: 3 })
  const dm = id => ({ cmd: CMD.DM, data: { msg_id: id, msg: id } })
  assert.equal(normalizeOnce(dm('a')).text, 'a')
  assert.equal(normalizeOnce(dm('a')), null)
  assert.equal(normalizeOnce({ cmd: CMD.LIKE, data: { msg_id: 'a' } }).type, 'like', 'same id under another cmd is distinct')
  normalizeOnce(dm('b'))
  assert.equal(normalizeOnce(dm('a')), null, 'a hit refreshes recency')
  normalizeOnce(dm('c'))
  normalizeOnce(dm('d')) // evicts the LIKE entry, the least recently used
  assert.equal(normalizeOnce(dm('a')), null)
  assert.equal(normalizeOnce({ cmd: CMD.LIKE, data: { msg_id: 'a' } }).type, 'like')
  const enter = fixture(CMD.LIVE_ROOM_ENTER)
  assert.ok(normalizeOnce(enter) && normalizeOnce(enter), 'messages without msg_id are never deduplicated')
})
