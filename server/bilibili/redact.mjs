import { format } from 'node:util'

const REDACTED = '[已隐藏]'
const MIN_SECRET_LENGTH = 4
const GUARD_NAMES = Object.freeze({ 1: '总督', 2: '提督', 3: '舰长' })

export function redactText(value, secrets = []) {
  let output = String(value)
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH)
      output = output.split(secret).join(REDACTED)
  }
  return output
}

// Formats every log call to one string and removes any secret value from it,
// including inside error messages and stacks. getSecrets is re-read on each
// call so values learned later (the auth_body) are covered too.
export function createRedactingLogger(logger = console, getSecrets = () => []) {
  const write = level => (...args) => {
    const line = redactText(format(...args), getSecrets())
    try {
      (logger?.[level] ?? logger?.info)?.call(logger, line)
    }
    catch {}
  }
  return { info: write('info'), warn: write('warn'), error: write('error') }
}

// Viewer names arrive unmasked from the open platform. Keep only the first
// character for probe output and logs: "张三" → "张**".
export function maskName(name) {
  const characters = Array.from(typeof name === 'string' ? name.trim() : '')
  return characters.length ? `${characters[0]}**` : ''
}

export function maskEvent(event) {
  const masked = { ...event }
  if (event?.user)
    masked.user = { ...event.user, name: maskName(event.user.name), face: event.user.face ? REDACTED : '' }
  if (event?.replyTo)
    masked.replyTo = { ...event.replyTo, name: maskName(event.replyTo.name) }
  delete masked.raw
  return masked
}

const yuan = amount => Number.isInteger(amount) ? String(amount) : amount.toFixed(2).replace(/0$/, '')

// One readable Chinese line per event, names masked, no avatars or raw data.
export function describeEvent(event) {
  const name = maskName(event?.user?.name) || '匿名'
  const tags = []
  if (GUARD_NAMES[event?.user?.guardLevel])
    tags.push(GUARD_NAMES[event.user.guardLevel])
  if (event?.user?.isAdmin)
    tags.push('房管')
  if (event?.user?.medalName && event.user.medalLevel)
    tags.push(`${event.user.medalName} ${event.user.medalLevel}`)
  const who = tags.length ? `${name} [${tags.join('][')}]` : name
  switch (event?.type) {
    case 'danmaku':
      if (event.mirror)
        return `跨房弹幕：${event.text}${event.emoji ? '（表情）' : ''}`
      return `弹幕 ${who}：${event.text}${event.emoji ? '（表情）' : ''}`
    case 'gift': {
      const gift = event.gift ?? {}
      const value = gift.paid ? `付费，约 ${yuan(event.amountCny)} 元` : '免费'
      return `礼物 ${who} 送出 ${gift.blind ? '盲盒·' : ''}${gift.name} ×${gift.num}（${value}）${gift.combo ? ` 连击 ${gift.combo.count}` : ''}`
    }
    case 'superchat':
      return `醒目留言 ¥${yuan(event.amountCny)} ${who}：${event.text}`
    case 'superchat-delete':
      return `醒目留言被撤回 ${event.messageIds?.length ?? 0} 条`
    case 'guard': {
      const guard = event.guard ?? {}
      return `上舰 ${name} 开通${GUARD_NAMES[guard.level] ?? '大航海'} ×${guard.num}${guard.unit}（约 ${yuan(event.amountCny)} 元）`
    }
    case 'like':
      return `点赞 ${name} ×${event.likeCount}`
    case 'enter':
      return `进房 ${name}`
    case 'live-start':
      return `开播：${event.live?.title ?? ''}`
    case 'live-end':
      return '下播'
    case 'interaction-end':
      return '平台通知场次已结束'
    default:
      return `未识别的消息 ${event?.cmd || '(无 cmd)'}`
  }
}
