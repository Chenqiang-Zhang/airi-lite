import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { CMD, normalizeOpenLiveMessage } from './events.mjs'
import { createRedactingLogger, describeEvent, maskEvent, maskName, redactText } from './redact.mjs'

const fixture = cmd => JSON.parse(readFileSync(new URL(`./fixtures/${cmd}.json`, import.meta.url), 'utf8'))
const event = cmd => normalizeOpenLiveMessage(fixture(cmd), { now: () => 0 })

test('redactText removes every occurrence of each secret and ignores tiny or missing values', () => {
  assert.equal(redactText('a SECRET b SECRET', ['SECRET']), 'a [已隐藏] b [已隐藏]')
  assert.equal(redactText('abc', ['ab', undefined, '', null]), 'abc')
  assert.equal(redactText(42, []), '42')
})

test('the redacting logger formats objects and errors before scrubbing', () => {
  const lines = []
  const logger = createRedactingLogger({ info: line => lines.push(line), warn: line => lines.push(line), error: line => lines.push(line) },
    () => ['TOPSECRET'])
  logger.info('value', { nested: 'TOPSECRET' })
  logger.warn(new Error('boom TOPSECRET'))
  logger.error('%s!', 'TOPSECRET')
  assert.equal(lines.length, 3)
  assert.ok(lines.every(line => !line.includes('TOPSECRET')))
  assert.match(lines[1], /boom \[已隐藏\]/)
  assert.doesNotThrow(() => createRedactingLogger({ info() { throw new Error('sink') } }).warn('x'))
  assert.doesNotThrow(() => createRedactingLogger(null).info('x'))
})

test('names keep only their first character', () => {
  assert.equal(maskName('测试观众甲'), '测**')
  assert.equal(maskName('A'), 'A**')
  assert.equal(maskName('😀smile'), '😀**')
  assert.equal(maskName(''), '')
  assert.equal(maskName(undefined), '')
})

test('maskEvent hides names, avatars and raw data without mutating the event', () => {
  const dm = fixture(CMD.DM)
  Object.assign(dm.data, { reply_open_id: 'x', reply_uname: '被回复者' })
  const original = normalizeOpenLiveMessage(dm, { includeRaw: true })
  const masked = maskEvent(original)
  assert.equal(masked.user.name, '测**')
  assert.equal(masked.user.face, '[已隐藏]')
  assert.equal(masked.replyTo.name, '被**')
  assert.equal('raw' in masked, false)
  assert.equal(original.user.name, '测试观众甲')
  assert.ok(original.raw)
})

test('every fixture has a readable Chinese description with masked names', () => {
  const lines = Object.values(CMD).map(cmd => describeEvent(event(cmd)))
  assert.deepEqual(lines, [
    '弹幕 测** [舰长][小测 12]：主播晚上好！',
    '跨房弹幕：来自另一个直播间的弹幕',
    '礼物 测** [小测 3] 送出 小花花 ×3（付费，约 0.3 元） 连击 3',
    '醒目留言 ¥30 测**：第一次看直播，加油！',
    '醒目留言被撤回 2 条',
    '上舰 测** 开通舰长 ×1月（约 198 元）',
    '点赞 测** ×5',
    '进房 测**',
    '开播：AI 主播测试直播',
    '下播',
    '平台通知场次已结束',
  ])
  for (const line of lines)
    assert.ok(!/观众[甲乙丙丁戊]/.test(line))
  assert.equal(describeEvent({ type: 'unknown', cmd: 'X' }), '未识别的消息 X')
  assert.equal(describeEvent(null), '未识别的消息 (无 cmd)')
  const emoji = fixture(CMD.DM)
  Object.assign(emoji.data, { dm_type: 1, is_admin: true })
  assert.match(describeEvent(normalizeOpenLiveMessage(emoji)), /\[舰长\]\[房管\]\[小测 12\].*（表情）$/)
})
