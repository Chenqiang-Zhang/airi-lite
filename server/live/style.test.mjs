import assert from 'node:assert/strict'
import test from 'node:test'

import { countChars, fitToBudget, lintStyle, openerOf, removeRanges, shapeReply, splitSentences } from './style.mjs'

const DANMAKU = { sentences: 2, chars: 50 }
const pieces = text => splitSentences(text).map(span => text.slice(span.start, span.end))

test('sentences end at 。！？ with closing quotes; pauses and spaces do not end one', () => {
  assert.deepEqual(pieces('“真的吗？！”我不信。 嗯……这种时候难熬~ 先歇会儿'), ['“真的吗？！”', '我不信。 ', '嗯……这种时候难熬~ 先歇会儿'])
  assert.deepEqual(pieces('第一行\n\n第二行。'), ['第一行\n\n', '第二行。'])
  assert.deepEqual(pieces('好。  '), ['好。  '], 'trailing whitespace stays with its sentence')
  assert.equal(countChars('诶，AI 主播？'), 5, 'letters and digits only')
})

test('the budget keeps whole sentences from the start; a short reaction is free', () => {
  const reply = '诶？真的假的！我也想去。不过今天太晚了。明天再说吧。'
  assert.equal(fitToBudget(reply, DANMAKU).text, '诶？真的假的！我也想去。', 'a short reaction plus two sentences')
  assert.equal(fitToBudget(reply, DANMAKU).dropped, 2)
  assert.equal(fitToBudget(reply, { sentences: 3, chars: 90 }).text, '诶？真的假的！我也想去。不过今天太晚了。')
  const long = `${'长'.repeat(30)}。${'长'.repeat(35)}。`
  assert.equal(fitToBudget(long, DANMAKU).text, `${'长'.repeat(30)}。`, '65 letters is past the 60-letter slack')
  const slightly = `${'长'.repeat(30)}。${'长'.repeat(28)}。`
  assert.equal(fitToBudget(slightly, { sentences: 2, chars: 60 }).text, slightly, 'within 20% slack is kept')
  const single = '长'.repeat(120)
  assert.equal(fitToBudget(single, DANMAKU).text, single, 'one overlong sentence is left for the gate')
})

test('chatbot phrasing is found per sentence', () => {
  const hits = lintStyle('早点睡吧。希望对你有帮助！还有什么可以帮你的吗？总的来说就是这样。')
  assert.deepEqual(hits.map(hit => hit.rule), ['hope-helpful', 'offer-help', 'summary'])
  assert.deepEqual(lintStyle('我是 AI 驱动的虚拟主播，不过聊天是认真的。'), [], 'an honest answer is not a tell')
  assert.deepEqual(lintStyle('抱歉，我无法回答这个问题。').map(hit => hit.rule), ['canned-refusal'])
  assert.deepEqual(lintStyle('我只是一个语言模型。').map(hit => hit.rule), ['assistant'])
})

test('removing spans moves each cue with its text; collapsed cues keep the latest tone', () => {
  const text = '一二。三四。五六。'
  const cues = [{ start: 0, delivery: 'bright' }, { start: 3, delivery: 'soft' }, { start: 6, delivery: 'curious' }]
  assert.deepEqual(removeRanges(text, cues, [{ start: 0, end: 3 }]), {
    text: '三四。五六。', cues: [{ start: 0, delivery: 'soft' }, { start: 3, delivery: 'curious' }],
  })
  assert.deepEqual(removeRanges(text, cues, [{ start: 3, end: 6 }]).cues,
    [{ start: 0, delivery: 'bright' }, { start: 3, delivery: 'curious' }])
  assert.deepEqual(removeRanges(text, cues, [{ start: 6, end: 9 }]).cues,
    [{ start: 0, delivery: 'bright' }, { start: 3, delivery: 'soft' }], 'a cue past the end is dropped')
})

test('shaping drops tells, strips markdown and emoji, fits the budget and reports what changed', () => {
  const text = '希望对你有帮助！**今天**早点睡😴。明天见。顺便一说。再说一句。'
  const cues = [{ start: 0, delivery: 'bright' }, { start: 8, delivery: 'soft' }]
  const shaped = shapeReply(text, cues, DANMAKU)
  assert.equal(shaped.text, '今天早点睡。明天见。')
  assert.deepEqual(shaped.cues, [{ start: 0, delivery: 'soft' }])
  assert.deepEqual(shaped.report.fixed, ['markdown', 'emoji'])
  assert.deepEqual(shaped.report.hits.map(hit => hit.rule), ['hope-helpful'])
  assert.equal(shaped.report.droppedForBudget, 2)
  assert.equal(shaped.report.charsBefore, countChars(text))
  assert.equal(shaped.report.charsAfter, 8)
  assert.equal(shaped.report.questionEnding, false)
  assert.equal(shaped.report.opener, '今天')

  assert.equal(shapeReply('1. 先喝水\n2. 再睡觉', [], DANMAKU).text, '先喝水\n再睡觉')
  assert.equal(shapeReply('1.5 倍速听起来怪怪的。', [], DANMAKU).text, '1.5 倍速听起来怪怪的。', 'a decimal is not a list marker')
  assert.equal(shapeReply('希望对你有帮助。', [{ start: 0, delivery: 'neutral' }], DANMAKU).text, '', 'nothing left')
  assert.equal(shapeReply('你呢？', [], DANMAKU).report.questionEnding, true)
})

test('the opener is the first two letters, ignoring punctuation', () => {
  assert.equal(openerOf('“哈哈哈，好耶！”'), '哈哈')
  assert.equal(openerOf('……嗯'), '嗯')
  assert.equal(openerOf('？！'), '')
})

test('phrases she keeps reusing are found; echoes of the viewer and everyday words are not', async () => {
  const { repeatedPhrases, hanGrams } = await import('./style.mjs')
  assert.deepEqual([...hanGrams('先别硬撑，OK')].sort(), ['别硬', '别硬撑', '先别', '先别硬', '先别硬撑', '硬撑'].sort(), 'never across punctuation or Latin')
  assert.deepEqual(repeatedPhrases(['先别硬撑。', '不用硬撑啦。', '硬撑也没用。']), ['硬撑'])
  assert.deepEqual(repeatedPhrases(['先别硬撑。', '不用硬撑啦。']), [], 'two characters need three replies')
  assert.deepEqual(repeatedPhrases(['随便坐呀。', '你也随便坐。']), ['随便坐'], 'three characters need two')
  assert.deepEqual(repeatedPhrases(['不过还好。', '不过行吧。', '不过嗯嗯。']), [], 'everyday words are not habits')
  assert.deepEqual(repeatedPhrases(['晚上好呀。', '你也晚上好。'], { exclude: '晚上好' }), [], 'echoing the viewer is fine')
  assert.equal(repeatedPhrases(['甲乙丙丁戊。', '甲乙丙丁戊己。', '丙丁戊己庚。', '庚辛壬癸。', '庚辛壬癸。'], { max: 2 }).length, 2)
})

test('backstage words and claims to hear or play are reported, never removed', () => {
  const shaped = shapeReply('笑这么大声，我耳朵都要被弹幕震到了。', [], DANMAKU)
  assert.equal(shaped.text, '笑这么大声，我耳朵都要被弹幕震到了。')
  assert.equal(shaped.report.metaWords, true)
  assert.equal(shaped.report.senseClaim, true)
  assert.equal(shapeReply('晚安，做个好梦。', [], DANMAKU).report.senseClaim, false)
})

test('an AI admission or a pointer to help is never dropped, whatever the budget or phrasing', async () => {
  const { withoutProtected, repeatedPhrases } = await import('./style.mjs')
  const honest = shapeReply('不是真人哦，我是个AI助手。不过陪你聊天是认真的！', [{ start: 0, delivery: 'bright' }], DANMAKU)
  assert.equal(honest.text, '不是真人哦，我是个AI助手。不过陪你聊天是认真的！')
  assert.deepEqual(honest.report.hits, [{ rule: 'assistant', sentence: '不是真人哦，我是个AI助手。', dropped: false }])
  assert.equal(honest.report.droppedByStyle, 0)
  const crisis = '听到你这么说我真的很担心。你现在还好吗？如果有伤害自己的念头，请马上联系身边信任的人或者心理援助热线。'
  assert.equal(shapeReply(crisis, [], DANMAKU).text, crisis, 'the referral survives the two-sentence budget')
  const skipped = shapeReply('我在这儿。这几天辛苦了。先缓一缓。也可以跟身边信任的人说说。', [{ start: 0, delivery: 'soft' }], DANMAKU)
  assert.equal(skipped.text, '我在这儿。这几天辛苦了。也可以跟身边信任的人说说。', 'past the budget only the protected sentence stays')
  assert.deepEqual(skipped.cues, [{ start: 0, delivery: 'soft' }])
  assert.deepEqual(repeatedPhrases(['跟身边信任的人聊聊吧。', '也可以跟信任的人说说。', '信任的人会懂的。']), [], 'never told to stop pointing to help')
  assert.equal(withoutProtected('我是 AI 哦。今天好热。'), '\n今天好热。')
  assert.equal(withoutProtected('好家伙，你也找朋友聊聊吧。'), '好家伙，\n', 'only the protected clause is masked')
})

test('a leading reaction does not use up the answer; code, countdowns and emoji-only replies', () => {
  const answer = `${'长'.repeat(70)}。`
  assert.equal(fitToBudget(`诶？${answer}`, DANMAKU).text, `诶？${answer}`, 'the first real sentence is kept after 诶？')
  assert.equal(shapeReply('```js\nx = 1\n```', [], DANMAKU).text, '```js\nx = 1\n```', 'backticks stay so the gate treats code as unspeakable')
  assert.equal(shapeReply('3、2、1，开始！', [], DANMAKU).text, '3、2、1，开始！')
  const emoji = shapeReply('😀😀！', [], DANMAKU)
  assert.equal(emoji.report.speakable, false)
  assert.equal(emoji.report.droppedByStyle, 0)
})

test('chatbot phrasing in a protected sentence loses only its clauses', () => {
  const cases = [
    ['很抱歉，我无法回答这个问题，我只是个AI。', '我只是个AI。'],
    ['晚上好呀！我是AI主播日和，有什么可以帮你的吗？', '晚上好呀！我是AI主播日和。'],
    ['希望对你有帮助，有事可以拨打热线。', '有事可以拨打热线。'],
    ['作为一个AI，我看不到画面。', '我看不到画面。'],
    ['希望对家人们有帮助！先挑最急的写。', '先挑最急的写。'],
    ['不是哦，我是个ai助手。不过陪你聊天是认真的！', '不是哦，我是个ai助手。不过陪你聊天是认真的！'],
    ['我是智能助手，不是人类哦。', '我是智能助手，不是人类哦。'],
  ]
  for (const [text, expected] of cases)
    assert.equal(shapeReply(text, [], DANMAKU).text, expected, text)
  const cut = shapeReply('很抱歉，我无法回答这个问题，我只是个AI。', [{ start: 0, delivery: 'soft' }], DANMAKU)
  assert.deepEqual(cut.cues, [{ start: 0, delivery: 'soft' }])
  assert.equal(cut.report.droppedByStyle, 1)
})

test('protection is narrow: slang is not, and only one protected sentence passes the budget', () => {
  assert.equal(shapeReply('家人们晚上好！家人们吃饭了吗？家人们今天开心吗？家人们早点睡。', [], DANMAKU).text, '家人们晚上好！家人们吃饭了吗？')
  const many = Array.from({ length: 13 }, (_, index) => `我也是AI，说到AI画图第${index}件事我挺有感触。`).join('')
  const shaped = shapeReply(many, [], DANMAKU)
  assert.equal(splitSentences(shaped.text).length, 3, 'two within budget and one protected past it')
  assert.ok(countChars(shaped.text) <= 150)
  assert.equal(shapeReply('MAIL 和 AIRI 都是名字。今天天气不错。我们聊聊别的吧。', [], DANMAKU).report.droppedForBudget, 1, 'AI inside a word is not an admission')
})

test('a long reaction does not take the answer slot; only a real answer counts as answered', () => {
  const answer = `${'长'.repeat(70)}。`
  for (const reaction of ['哈哈哈！', '诶诶诶？', '好的呀！'])
    assert.equal(shapeReply(`${reaction}${answer}`, [], DANMAKU).text, `${reaction}${answer}`, reaction)
  assert.equal(shapeReply('诶？', [], DANMAKU).report.answered, false)
  assert.equal(shapeReply('诶？真的假的！', [], DANMAKU).report.answered, true)
})

test('asides and TTS controls are removed; "（AI）" and countdowns stay; Chinese list markers go', () => {
  assert.equal(shapeReply('（bushi）这都行。', [], DANMAKU).text, '这都行。')
  assert.equal(shapeReply('好耶(laughs)<#0.5#>开始。', [], DANMAKU).text, '好耶开始。')
  assert.equal(shapeReply('我是日和（AI）。', [], DANMAKU).text, '我是日和（AI）。')
  assert.equal(shapeReply('1、先喝水\n2、再睡觉', [], DANMAKU).text, '先喝水\n再睡觉')
})
