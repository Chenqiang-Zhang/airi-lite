// Normalises open-platform long-connection messages ({cmd, data}) into plain
// events. Field names follow the open-platform message docs as summarised in
// the stage-1 plan; the fixtures next to this file are synthetic, not captured.
// Users are keyed by open_id: uid is deprecated and always 0. Display names
// arrive in clear text, so callers must not log them unmasked.
export const CMD = Object.freeze({
  DM: 'LIVE_OPEN_PLATFORM_DM',
  DM_MIRROR: 'LIVE_OPEN_PLATFORM_DM_MIRROR',
  SEND_GIFT: 'LIVE_OPEN_PLATFORM_SEND_GIFT',
  SUPER_CHAT: 'LIVE_OPEN_PLATFORM_SUPER_CHAT',
  SUPER_CHAT_DEL: 'LIVE_OPEN_PLATFORM_SUPER_CHAT_DEL',
  GUARD: 'LIVE_OPEN_PLATFORM_GUARD',
  LIKE: 'LIVE_OPEN_PLATFORM_LIKE',
  LIVE_ROOM_ENTER: 'LIVE_OPEN_PLATFORM_LIVE_ROOM_ENTER',
  LIVE_START: 'LIVE_OPEN_PLATFORM_LIVE_START',
  LIVE_END: 'LIVE_OPEN_PLATFORM_LIVE_END',
  INTERACTION_END: 'LIVE_OPEN_PLATFORM_INTERACTION_END',
})
export const MAX_REMEMBERED_MESSAGES = 2_048
// 1000 = 1 CNY for gift price/r_price and guard price (金瓜子).
const MILLI_CNY = 1_000

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
function integer(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value))
    return value
  if (typeof value === 'string' && /^-?\d{1,15}$/.test(value))
    return Number(value)
  return null
}
const count = value => Math.max(0, integer(value) ?? 0)
const flag = value => value === true || value === 1 || value === '1' || value === 'true'
const guardLevel = value => [1, 2, 3].includes(integer(value)) ? integer(value) : 0
function money(value) {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value
  return typeof number === 'number' && Number.isFinite(number) && number > 0 ? number : 0
}
// Platform timestamps are seconds; tolerate milliseconds defensively.
function milliseconds(value) {
  const number = integer(value)
  if (number === null || number <= 0)
    return null
  return number >= 1e12 ? number : number * 1_000
}

function viewer(data, profile = data) {
  return {
    openId: text(profile.open_id),
    name: text(profile.uname),
    face: text(profile.uface),
    guardLevel: guardLevel(data.guard_level),
    medalName: text(data.fans_medal_name),
    medalLevel: count(data.fans_medal_level),
    isAdmin: flag(data.is_admin),
  }
}
const emoji = data => integer(data.dm_type) === 1 ? { url: text(data.emoji_img_url) } : null

export function normalizeOpenLiveMessage(message, { now = Date.now, includeRaw = false } = {}) {
  const cmd = typeof message?.cmd === 'string' ? message.cmd : ''
  const data = isObject(message?.data) ? message.data : {}
  const event = {
    type: 'unknown',
    cmd,
    msgId: text(data.msg_id) || null,
    ts: milliseconds(data.timestamp) ?? now(),
    roomId: integer(data.room_id),
    user: null,
    text: '',
    emoji: null,
    amountCny: 0,
  }
  switch (cmd) {
    case CMD.DM:
      Object.assign(event, {
        type: 'danmaku',
        user: viewer(data),
        text: text(data.msg),
        emoji: emoji(data),
        mirror: false,
        replyTo: text(data.reply_open_id) ? { openId: text(data.reply_open_id), name: text(data.reply_uname) } : null,
      })
      break
    case CMD.DM_MIRROR:
      // Cross-room danmaku: no sender information is provided.
      Object.assign(event, { type: 'danmaku', text: text(data.msg), emoji: emoji(data), mirror: true, replyTo: null })
      break
    case CMD.SEND_GIFT: {
      const num = count(data.gift_num)
      const price = count(data.price)
      const rPrice = data.r_price == null ? price : count(data.r_price)
      const paid = flag(data.paid)
      const combo = isObject(data.combo_info) ? data.combo_info : {}
      const blind = isObject(data.blind_gift) ? data.blind_gift : {}
      Object.assign(event, {
        type: 'gift',
        user: viewer(data),
        // Free gifts (paid=false) are worth nothing in CNY.
        amountCny: paid ? rPrice * num / MILLI_CNY : 0,
        gift: {
          id: integer(data.gift_id),
          name: text(data.gift_name),
          num,
          price,
          rPrice,
          paid,
          icon: text(data.gift_icon),
          combo: flag(data.combo_gift)
            ? { id: text(combo.combo_id), count: count(combo.combo_count), baseNum: count(combo.combo_base_num), timeoutSec: count(combo.combo_timeout) }
            : null,
          blind: flag(blind.status) ? { id: integer(blind.blind_gift_id) } : null,
        },
      })
      break
    }
    case CMD.SUPER_CHAT:
      Object.assign(event, {
        type: 'superchat',
        user: viewer(data),
        text: text(data.message),
        amountCny: money(data.rmb), // Already CNY.
        superchat: {
          id: text(data.message_id),
          startTime: milliseconds(data.start_time),
          endTime: milliseconds(data.end_time),
        },
      })
      break
    case CMD.SUPER_CHAT_DEL:
      Object.assign(event, {
        type: 'superchat-delete',
        messageIds: Array.isArray(data.message_ids) ? data.message_ids.map(text).filter(Boolean) : [],
      })
      break
    case CMD.GUARD: {
      const price = count(data.price)
      Object.assign(event, {
        type: 'guard',
        user: viewer(data, isObject(data.user_info) ? data.user_info : {}),
        // Plan: price/1000. Whether price is per unit or the total when
        // guard_num > 1 is unverified; see the M4 verification doc.
        amountCny: price / MILLI_CNY,
        guard: { level: guardLevel(data.guard_level), num: count(data.guard_num), unit: text(data.guard_unit), price },
      })
      break
    }
    case CMD.LIKE:
      Object.assign(event, { type: 'like', user: viewer(data), text: text(data.like_text), likeCount: count(data.like_count) })
      break
    case CMD.LIVE_ROOM_ENTER:
      Object.assign(event, { type: 'enter', user: viewer(data) })
      break
    case CMD.LIVE_START:
    case CMD.LIVE_END:
      Object.assign(event, {
        type: cmd === CMD.LIVE_START ? 'live-start' : 'live-end',
        live: { title: text(data.title), areaName: text(data.area_name) },
      })
      break
    case CMD.INTERACTION_END:
      // The game this connection belongs to is no longer valid.
      Object.assign(event, { type: 'interaction-end', gameId: text(data.game_id) })
      break
  }
  if (includeRaw)
    event.raw = message
  return event
}

// Returns a normaliser that drops repeats of the same cmd + msg_id (the
// platform may redeliver after reconnects), remembering a bounded number of
// recent ids in LRU order. Messages without msg_id are never deduplicated.
export function createEventNormalizer({ now = Date.now, includeRaw = false, maxRemembered = MAX_REMEMBERED_MESSAGES } = {}) {
  const seen = new Map()
  return function normalize(message) {
    const event = normalizeOpenLiveMessage(message, { now, includeRaw })
    if (event.msgId) {
      const key = `${event.cmd}\n${event.msgId}`
      if (seen.has(key)) {
        seen.delete(key)
        seen.set(key, true)
        return null
      }
      seen.set(key, true)
      if (seen.size > maxRemembered)
        seen.delete(seen.keys().next().value)
    }
    return event
  }
}
