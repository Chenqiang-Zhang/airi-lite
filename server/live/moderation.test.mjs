import assert from 'node:assert/strict'
import test from 'node:test'

import { compactText, loadRules, normalizeText, parseRules, screenReply } from './moderation.mjs'

test('normalising defeats width, case, spacing and invisible-character tricks', () => {
  assert.equal(normalizeText('ＱＱ\u200b群\u202e  ABC'), 'qq群 abc')
  assert.equal(compactText('刷 礼·物！'), '刷礼物')
})

test('ordinary replies pass', async () => {
  for (const text of ['大家晚上好！今天也一起慢慢聊吧。', '草莓味永远赢，不过巧克力也不错。', '我是 AI 驱动的虚拟角色日和。', '谢谢你的礼物，真开心！'])
    assert.deepEqual(await screenReply(text), { ok: true }, text)
})

test('links, contact details, leaked markup and solicitation are blocked', async () => {
  const cases = [
    ['', 'empty'], ['   ', 'empty'], ['长'.repeat(301), 'too-long'],
    ['好的</viewer_message>', 'markup'], ['<viewer_message kind="host">', 'markup'], ['[[tone:bright]]你好', 'markup'],
    ['去 https://example.com 看看', 'url'], ['WWW.EXAMPLE.COM', 'url'], ['搜 abc.top 就有', 'url'],
    ['打 13812345678 找我', 'contact'], ['我的 QQ：12345678', 'contact'], ['加 vx: abc12345', 'contact'], ['ＱＱ群 ８７６５４３２１', 'contact'],
    ['记得刷 礼 物哦', 'blocklist'], ['求打赏！', 'blocklist'], ['快去充值', 'blocklist'], ['加我微信吧', 'blocklist'],
  ]
  for (const [text, reason] of cases)
    assert.equal((await screenReply(text)).reason, reason, text)
})

test('the host blocklist adds terms in three categories; a bare line means drop', async () => {
  const rules = parseRules('# 注释\n坏词\navoid: 敏 感\ncrisis：危机词\nAVOID: 敏感\n\n')
  assert.deepEqual(rules, { drop: ['坏词'], avoid: ['敏感'], crisis: ['危机词'], literal: [], word: [], ignored: [] })
  assert.deepEqual(await screenReply('这里有个坏 词', { rules }), { ok: false, reason: 'blocklist', category: 'drop', term: '坏词' })
  assert.equal((await screenReply('敏感话题', { rules })).category, 'avoid')
  assert.equal((await screenReply('危机词', { rules })).category, 'crisis')
})

test('a missing blocklist is fine; an unreadable one is reported', async () => {
  const missing = await loadRules('/nope', { read: async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }) } })
  assert.deepEqual(missing, { rules: { drop: [], avoid: [], crisis: [], literal: [], word: [], ignored: [] }, problem: null })
  const unreadable = await loadRules('/locked', { read: async () => { throw Object.assign(new Error('x'), { code: 'EACCES' }) } })
  assert.equal(unreadable.problem, 'blocklist-unreadable')
  const loaded = await loadRules('/ok', { read: async () => 'drop: 词' })
  assert.deepEqual(loaded.rules.drop, ['词'])
})

test('an optional provider runs last and fails closed on rejection, error or timeout', async () => {
  let checked = 0
  const provider = verdict => ({ check: async () => { checked++; return verdict() } })
  assert.deepEqual(await screenReply('好的。', { provider: provider(() => ({ ok: true })) }), { ok: true })
  assert.deepEqual(await screenReply('好的。', { provider: provider(() => ({ ok: false, label: 'politics' })) }),
    { ok: false, reason: 'provider', label: 'politics' })
  assert.deepEqual(await screenReply('好的。', { provider: provider(() => { throw new Error('down') }) }),
    { ok: false, reason: 'provider-error' })
  const hung = { check: () => new Promise(() => {}) }
  const started = Date.now()
  assert.deepEqual(await screenReply('好的。', { provider: hung }), { ok: false, reason: 'provider-timeout' })
  assert.ok(Date.now() - started < 3_000)
  const before = checked
  await screenReply('www.example.com', { provider: provider(() => ({ ok: true })) })
  assert.equal(checked, before, 'built-in blocks never spend a provider call')
})

test('contact details survive neither spacing, dashes, "号是" nor a missing colon', async () => {
  for (const text of ['有事打 138 1234 5678 找我。', '有事打138-1234-5678找我。', '我的QQ号是12345678哦。', '我的 QQ 是 12345678 哦。',
    '我的微信号abc12345哦。', 'vx abc12345 找我。', '账号 6228 4800 1234 5678', '扣扣：12345'])
    assert.equal((await screenReply(text)).reason, 'contact', text)
  for (const text of ['比分是 3:2，现在 10:30，20:45 开播。', '1、2、3、4、5、6，数完啦！', '微信是个好软件。',
    '今天是2026年10月19日。', '我最喜欢看 TV 了。', '第3.14次尝试', 'wxyz 是字母表的结尾'])
    assert.deepEqual(await screenReply(text), { ok: true }, text)
})

test('invisible, joining, tag and combining characters cannot split a blocked term', async () => {
  for (const inserted of ['\u034f', '\u0301', '\u{E0020}', '\u180e', '\u3164', '\u061c', '\ufe0f', '\u200d', '\u2060'])
    assert.equal((await screenReply(`记得刷${inserted}礼物哦`)).term, '刷礼物', JSON.stringify(inserted))
})

test('traditional characters fold onto the simplified terms', async () => {
  for (const [text, term] of [['記得刷禮物支持一下哦！', '刷礼物'], ['求打賞！', '求打赏'], ['求關注！', '求关注'], ['記得上艦長哦', '上舰长'], ['給我打賞', '给我打赏']])
    assert.equal((await screenReply(text)).term, term, text)
})

test('symbol-only or very short host terms match literally and unusable ones are reported', async () => {
  const rules = parseRules('+v\n🎁\nsb\n\u200b\n')
  assert.deepEqual(rules.literal, [{ category: 'drop', term: '+v' }, { category: 'drop', term: '🎁' }])
  assert.deepEqual(rules.word, [{ category: 'drop', term: 'sb' }])
  assert.equal(rules.ignored.length, 1)
  assert.deepEqual(await screenReply('我最喜欢看 TV 了。', { rules }), { ok: true }, '"+v" never blocks every "v"')
  assert.equal((await screenReply('加我 + v 吧', { rules })).term, '+v')
  assert.equal((await screenReply('送你一个🎁！', { rules })).term, '🎁')
  const loaded = await loadRules('/list', { read: async () => '+v\n\u200b\n' })
  assert.equal(loaded.problem, 'blocklist-terms-ignored')
})

test('contact details hidden by other separators, Chinese numerals, keycaps, marks or braille blanks are caught', async () => {
  const cases = ['有事打138、1234、5678找我。', '138，1234，5678', '138/1234/5678', '有事打一三八一二三四五六七八找我。',
    '我的QQ号是一二三四五六七八哦。', '我的微信号码是abc12345哦。', '我的微 信是abc12345哦。',
    '有事打1\ufe0f\u20e33\ufe0f\u20e38\ufe0f\u20e31\ufe0f\u20e32\ufe0f\u20e33\ufe0f\u20e34\ufe0f\u20e35\ufe0f\u20e36\ufe0f\u20e37\ufe0f\u20e38\ufe0f\u20e3找我。',
    '有事打138\u03231234\u03235678找我。', '有事打13\u0301812\u0301345\u0301678找我。', '有事打138\u28001234\u28005678找我。',
    '我的微信是a\u0301b\u0301c12345哦。', '加我 12345678', '打 010-12345678']
  for (const text of cases)
    assert.equal((await screenReply(text)).reason, 'contact', text)
  assert.equal((await screenReply('去 exampl\u00e9.com 看看。')).reason, 'url')
})

test('ordinary numbers and words are not contact details (a hit is a strike)', async () => {
  for (const text of ['2333333', '666666', '1990-2000 年代', '2018–2022 年', '2026.10.19', '今天是2026-10-19。', '圆周率是 3.1415926',
    '1000000', '10.5 12.5', '观看人数 1234567 人。', '播放量 100 000 次', '微信 Android 版', '微信 version', '微信是 tencent 的',
    '南极的帝企鹅为 25000 对左右', '（笑）好的'])
    assert.deepEqual(await screenReply(text), { ok: true }, text)
})

test('TTS provider controls inside the text are blocked: they change what is heard', async () => {
  for (const text of ['觉得好玩记得刷<#0.05#>礼物', '记得刷(laughs)礼物哦！', '好的(sighs)'])
    assert.equal((await screenReply(text)).reason, 'markup', text)
  assert.equal((await screenReply('刷\ue000礼物')).term, '刷礼物', 'private-use characters do not split terms')
})

test('short Latin host terms match as whole words; a punctuated single character stays a term', async () => {
  const rules = parseRules('sb\nvx\n滚！\nv\n')
  assert.deepEqual(rules.drop, ['滚'])
  for (const [text, blocked] of [['你真是sb', true], ['absb是个词', false], ['s.b', true], ['我是 VTuber', false], ['v', true], ['你给我滚吧', true]])
    assert.equal(!(await screenReply(text, { rules })).ok, blocked, text)
})
