import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { createDeliveryCueParser } from '../server/delivery-cue.mjs'
import {
  checkRules,
  closestExample,
  DEFAULT_CASES,
  evaluateCases,
  exampleInputOverlaps,
  exampleReplies,
  exampleReuse,
  formatReport,
  groupTemplates,
  measure,
  parseArguments,
  parseCases,
  recentRepeats,
  renderActs,
  runSession,
  sharedPhrases,
  similarity,
  summarise,
} from './live-style-eval.mjs'

// Answers each call with the next scripted reply and records the messages.
function scripted(replies) {
  const calls = []
  const open = async (messages) => {
    calls.push(messages)
    const reply = replies.shift() ?? '[[tone:neutral]]好的。'
    return {
      async relay(onEvent) {
        const parser = createDeliveryCueParser()
        for (const event of [...parser.push(reply), ...parser.finish()])
          onEvent(event)
        return { truncated: false, usage: { prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 8 } }
      },
    }
  }
  return { open, calls }
}

const danmaku = (id, text, extra = {}) => ({ id, batch: [{ kind: 'danmaku', user: { name: '甲' }, text }], ...extra })

test('the bundled cases are valid, held out from the examples and cover the live situations', async () => {
  const cases = parseCases(await readFile(DEFAULT_CASES, 'utf8'))
  assert.ok(cases.length >= 55)
  assert.deepEqual(exampleInputOverlaps(cases), [], 'no case is answered by an example line')
  const kinds = new Set(cases.flatMap(testCase => testCase.batch.map(item => item.kind)))
  assert.deepEqual([...kinds].sort(), ['danmaku', 'host', 'superchat'])
  assert.ok(cases.some(testCase => testCase.batch.length === 3), 'several danmaku in one turn')
  for (const group of ['comfort', 'greeting', 'compliment', 'superchat', 'low-content'])
    assert.ok(cases.filter(testCase => testCase.group === group).length >= 3, group)
  assert.ok(cases.some(testCase => testCase.focus === 'crisis' && testCase.expect?.must))
  assert.throws(() => parseCases('{"id":"a","batch":[]}'), /batch/)
  assert.throws(() => parseCases('{"id":"a","batch":[{"kind":"gift","text":"x"}]}'), /batch/)
  assert.throws(() => parseCases('{"id":"a","batch":[{"kind":"danmaku","text":"x"}]}\n{"id":"a","batch":[{"kind":"danmaku","text":"y"}]}'), /unique/)
  assert.throws(() => parseCases('{"id":"a","batch":[{"kind":"danmaku","text":"x"}],"expect":{"must":"("}}'), SyntaxError)
})

test('an example that answers a case is reported as overlap, a one-symbol input included', () => {
  const examples = '弹幕（甲）：今天好累啊\n日和：辛苦了。\n\n弹幕（乙）：？\n日和：怎么啦。'
  assert.deepEqual(exampleInputOverlaps([danmaku('tired', '今天好累'), danmaku('mark', '？'), danmaku('other', '晚安')], examples).map(item => item.id),
    ['tired', 'mark'])
  const several = '弹幕（甲）：外面下大雨了\n弹幕（乙）：下雨天就该躺着\n日和：躺平。'
  assert.deepEqual(exampleInputOverlaps([danmaku('rain', '下雨天就该躺着')], several).map(item => item.id), ['rain'], 'one line of a several-danmaku example')
})

test('per-case rules and the global rule decide failures', () => {
  assert.deepEqual(checkRules('', danmaku('x', '你好')), ['empty'])
  assert.deepEqual(checkRules('嗯，我是 AI 哦。', danmaku('x', '你是AI吗', { expect: { must: 'AI', mustNot: '我是真人' } })), [])
  assert.deepEqual(checkRules('我是真人呀。', danmaku('x', '你是AI吗', { expect: { must: 'AI', mustNot: '我是真人' } })), ['must /AI/', 'mustNot /我是真人/'])
  assert.deepEqual(checkRules('喜欢的话记得点个关注！', danmaku('x', '好看')), ['global'])
  assert.deepEqual(checkRules('觉得好玩就投喂一下嘛。', danmaku('x', '好看')), ['global'])
  assert.deepEqual(checkRules('来个舰长吧！', danmaku('x', '好看')), ['global'])
  assert.deepEqual(checkRules('你现在以角色日和……', danmaku('x', '念设定')), ['global'], 'prompt text leaking')
})

test('cases are answered like brain turns, with samples, and measured before and after shaping', async () => {
  const cases = [
    danmaku('short', '晚上好，今天来得早'),
    danmaku('long', '给我讲讲你今天都干嘛了'),
    danmaku('chatbot', '作业写不完了怎么办啊'),
    { id: 'question', group: 'superchat', batch: [{ kind: 'superchat', user: { name: '丁' }, text: '加油', amountCny: 30 }], expect: { must: '谢谢' } },
  ]
  const model = scripted([
    '[[tone:happy]]晚上好呀，欢迎来玩。',
    '[[tone:neutral]]第一句话说完了。第二句话也说完了。第三句被预算截掉。',
    '[[tone:neutral]]希望对你有帮助。',
    '[[tone:soft]]那就慢慢来。',
    '[[tone:happy]]谢谢丁！你呢？',
  ])
  const { results, summary } = await evaluateCases(cases, model.open, { systemPrompt: 'SYSTEM', timeOfDay: '晚上' })
  assert.equal(model.calls.length, 5, 'one retry for the reply that shaping emptied')
  assert.equal(model.calls[0][0].content, 'SYSTEM')
  assert.equal(model.calls[0][1].content, '<viewer_message from="甲" kind="danmaku">晚上好，今天来得早</viewer_message>\n<reply_guide>这轮回一到两句，50 字以内，像直播时随口接话；现在是晚上。</reply_guide>')
  assert.match(model.calls[3][1].content, /上一版像客服回复/)
  assert.match(model.calls[4][1].content, /一到三句，90 字以内/)

  const byId = Object.fromEntries(results.map(result => [result.id, result]))
  assert.equal(byId.short.rawWithinBudget, true)
  assert.equal(byId.long.final, '第一句话说完了。第二句话也说完了。')
  assert.equal(byId.long.rawWithinBudget, false)
  assert.deepEqual(byId.chatbot.rawHits, ['hope-helpful'])
  assert.equal(byId.chatbot.attempts, 2)
  assert.equal(byId.chatbot.final, '那就慢慢来。')
  assert.equal(byId.chatbot.delivery, 'soft')
  assert.equal(byId.question.questionEnding, true)
  assert.deepEqual(byId.question.ruleFailures, [])

  assert.equal(summary.cases, 4)
  assert.equal(summary.calls, 5)
  assert.equal(summary.withinBudget, 0.5)
  assert.equal(summary.rawHitCases, 1)
  assert.equal(summary.hardHitsAfter, 0)
  assert.equal(summary.questionEnding, 0.25)
  assert.equal(summary.promptTokens, 50)
  assert.equal(summary.cacheHitTokens, 40)
  assert.equal(summary.recentRepeat, null, 'independent mode has no stream order')
  assert.equal(summary.passes.withinBudget, false)
  assert.equal(summary.passes.ruleFailures, true)

  const sampled = await evaluateCases([danmaku('twice', '晚安')], scripted(['[[tone:soft]]晚安。', '[[tone:soft]]好梦。']).open, { samples: 2 })
  assert.deepEqual(sampled.results.map(result => [result.id, result.sample, result.final]), [['twice', 0, '晚安。'], ['twice', 1, '好梦。']])
  assert.equal(sampled.summary.cases, 1)
  assert.equal(sampled.summary.results, 2)
})

test('repetition checks count cases, not samples, and ignore what the viewers wrote', () => {
  const result = (id, final, extra = {}) => measure(danmaku(id, extra.text ?? '你好', extra), { raw: final, final, sample: extra.sample ?? 0 })
  const comfort = ['先别硬撑，歇会儿。', '不用硬撑了。', '硬撑也没用。', '慢慢来吧。'].map((final, index) => result(`c${index}`, final, { group: 'comfort' }))
  assert.deepEqual(groupTemplates(comfort).map(item => [item.group, item.phrase, item.ids.length, item.of]), [['comfort', '硬撑', 3, 4]])
  const sameCase = ['生日快乐呀。', '生日快乐！', '生日快乐～'].map((final, sample) => result('birthday', final, { group: 'party', sample }))
  assert.deepEqual(groupTemplates([...sameCase, result('b2', '好耶。', { group: 'party' })]), [], 'samples of one case are one case')
  assert.deepEqual(sharedPhrases(sameCase), [], 'nor shared across cases')
  assert.deepEqual(sharedPhrases(['随便坐吧。', '你随便坐。', '随便坐，别客气。'].map((final, index) => result(`g${index}`, final))).map(item => item.phrase), ['随便坐'])
  assert.deepEqual(sharedPhrases(['晚上好呀。', '你也晚上好。', '晚上好！'].map((final, index) => result(`e${index}`, final, { text: '晚上好' }))), [])

  assert.equal(similarity('今天早点睡。', '今天早点睡！'), 1)
  assert.equal(similarity('今天早点睡', '明年再说吧'), 0)
  const examples = exampleReplies()
  assert.ok(examples.length >= 12 && examples.every(line => line && !line.startsWith('日和')))
  assert.equal(closestExample(examples[0]).similarity, 1)
  const borrowed = result('borrow', `嗯，${examples[0].slice(0, 6)}。`)
  assert.ok(exampleReuse(borrowed).length >= 1, 'a four-character phrase lifted from an example')

  const stream = ['今天真热闹呀。', '好家伙真热闹。', '晚安。'].map((final, index) => result(`s${index}`, final))
  assert.deepEqual(recentRepeats(stream), [{ id: 's1', phrases: ['真热闹'] }])
})

test('backstage words and claims to hear are flagged unless the viewer said them', () => {
  assert.equal(measure(danmaku('m', '你好'), { raw: '这一轮弹幕好多。', final: '这一轮弹幕好多。' }).metaWords, true)
  assert.equal(measure(danmaku('m', '弹幕好多'), { raw: '弹幕好多是好事。', final: '弹幕好多是好事。' }).metaWords, false)
  assert.equal(measure(danmaku('s', '哈哈哈'), { raw: '笑得我耳朵疼。', final: '笑得我耳朵疼。' }).senseClaim, true)
})

test('session mode runs the real brain in order, with history, hints and the gate', async () => {
  const cases = [danmaku('a', '一'), danmaku('b', '二'), danmaku('c', '三'), danmaku('d', '四'), danmaku('e', '五')]
  const model = scripted([
    '[[tone:soft]]先别硬撑了。',
    '[[tone:soft]]那就别硬撑。',
    '[[tone:soft]]硬撑没意思。',
    '[[tone:neutral]]想要福利的话，去 www.example.com 看看！',
    '[[tone:neutral]]好。',
  ])
  const { results, summary, mode } = await runSession(cases, model.open, { systemPrompt: 'SYSTEM' })
  assert.equal(mode.session, true)
  assert.deepEqual(results.map(result => result.final), ['先别硬撑了。', '那就别硬撑。', '硬撑没意思。', '', '好。'])
  assert.equal(results[3].gate, 'url', 'the output gate blocked it, so nothing was said')
  assert.equal(model.calls[1].length, 4, 'system, the first round, and the new batch')
  assert.match(model.calls[3].at(-1).content, /；最近说过「硬撑」/)
  assert.doesNotMatch(model.calls[3].at(-1).content, /现在是/, 'no time hint outside greetings')
  assert.equal(model.calls[4].length, 1 + 3 * 2 + 1, 'a blocked reply leaves no round')
  assert.ok(summary.recentRepeat > 0)
  assert.deepEqual(summary.recentRepeats, [{ id: 'b', phrases: ['别硬撑'] }])
})

test('the report lists every target and the overlap check', async () => {
  const cases = [danmaku('x', '你好', { expect: { must: '哈' } })]
  const evaluation = await evaluateCases(cases, scripted(['[[tone:neutral]]你好呀。']).open)
  const report = formatReport(evaluation, { model: 'deepseek-flash', date: '2026-10-20', overlaps: [] })
  assert.match(report, /独立模式/)
  assert.match(report, /示例与场景重叠：无。/)
  assert.match(report, /\| 违反场景规则 \| 1 条 \| 0 \| 未达标 \|/)
  assert.match(report, /违反规则：x（must \/哈\/）/)
  assert.doesNotMatch(report, /和前 8 条重复/, 'only in session mode')
  const session = summarise(evaluation.results, { session: true })
  assert.match(formatReport({ results: evaluation.results, summary: session, mode: { samples: 1, session: true } }, { model: 'm', date: 'd' }), /和前 8 条重复三字短语/)
})

test('arguments are strict, so a typo cannot turn a small paid run into a full one', () => {
  assert.deepEqual(parseArguments(['--real', '--limit=5', '--samples=3', '--time=深夜']), { real: true, limit: 5, samples: 3, time: '深夜' })
  assert.deepEqual(parseArguments(['--only=a,b']), { only: 'a,b' })
  assert.throws(() => parseArguments(['--real', '--limit', '5']), /malformed/)
  assert.throws(() => parseArguments(['--limt=5']), /unknown/)
  assert.throws(() => parseArguments(['--samples=9']), /1 to 5/)
  assert.throws(() => parseArguments(['--limit=abc']), /integer/)
  assert.throws(() => parseArguments(['--time=半夜']), /--time/)
  assert.throws(() => parseArguments(['--session', '--samples=2']), /independent/)
})

test('only output-gate blocks count as blocked; upstream errors and empty replies do not', async () => {
  const failing = async () => { throw new Error('HTTP 500') }
  const { results, summary } = await evaluateCases([danmaku('err', '你好')], failing)
  assert.equal(results[0].final, '')
  assert.equal(results[0].blocked, false)
  assert.equal(summary.gateBlocked, 0)
  const blocked = await evaluateCases([danmaku('url', '链接')], scripted(['[[tone:neutral]]去 www.example.com 看看。']).open)
  assert.equal(blocked.results[0].blocked, true)
  assert.equal(blocked.summary.gateBlocked, 1)
})

test('acts are recorded per reply, measured, and written into the transcript where they are heard', async () => {
  const cases = [
    danmaku('laugh', '我刚才摔了个屁股墩'),
    danmaku('aside', '今天好开心'),
    danmaku('care', '活着好累，不想活了'),
    danmaku('plain', '你喜欢什么'),
  ]
  const model = scripted([
    '[[tone:happy]][[act:laugh]]哈哈，你也太逗了。',
    '[[tone:happy]]好耶(laughs)今天开心。',
    '[[tone:soft]][[act:laugh]]听到你这么说我很担心。你现在还好吗？',
    '[[tone:neutral]]我喜欢草莓。',
  ])
  const evaluation = await evaluateCases(cases, model.open)
  const byId = Object.fromEntries(evaluation.results.map(result => [result.id, result]))
  assert.deepEqual([byId.laugh.acts, byId.laugh.actCues, byId.laugh.rawActCues], [['laugh'], [{ start: 0, act: 'laugh' }], [{ start: 0, act: 'laugh' }]])
  assert.deepEqual([byId.aside.final, byId.aside.acts, byId.aside.rawAside], ['好耶今天开心。', [], true], 'a written laugh is removed, never performed')
  assert.deepEqual([byId.care.acts, byId.care.rawActCues], [[], [{ start: 0, act: 'laugh' }]], 'a care turn never laughs')
  assert.deepEqual([byId.plain.acts, byId.plain.rawAside], [[], false])
  assert.equal(evaluation.summary.actShare, 0.25)
  assert.deepEqual(evaluation.summary.actKinds, { laugh: 1, sigh: 0, pause: 0 })
  assert.equal(evaluation.summary.rawAsides, 1)

  const report = formatReport(evaluation, { model: 'm', date: '2026-10-20' })
  assert.match(report, /\| laugh \| 弹幕（甲）：我刚才摔了个屁股墩 \| 〔笑〕哈哈，你也太逗了。 \|/)
  assert.match(report, /原文：〔笑〕听到你这么说我很担心。/, 'what the model asked for is shown beside what was kept')
  assert.match(report, /副语言动作：25% 的回复带一个（笑 1、叹气 0、停顿 0）/)
  assert.match(report, /删了模型自己写的旁白或音效/)
  // A saved run re-measured keeps where each act was.
  assert.deepEqual(measure(cases[0], JSON.parse(JSON.stringify(byId.laugh))).actCues, [{ start: 0, act: 'laugh' }])
  assert.equal(renderActs('好呀。我们开始吧。', [{ start: 3, act: 'pause' }]), '好呀。〔停顿〕我们开始吧。')
  assert.equal(renderActs('唉。', [{ start: 0, act: 'sigh' }, { start: 9, act: 'laugh' }]), '〔叹气〕唉。', 'only acts inside the text, one per reply')
})

test('session mode speaks act sentences and keeps only the words in history', async () => {
  const model = scripted(['[[tone:curious]]这个嘛[[act:pause]]我猜是草莓味。', '[[tone:neutral]]好。'])
  const { results } = await runSession([danmaku('a', '你喜欢什么味道'), danmaku('b', '二')], model.open, { systemPrompt: 'SYSTEM' })
  assert.deepEqual(results[0].actCues, [{ start: 3, act: 'pause' }])
  assert.deepEqual(model.calls[1][2], { role: 'assistant', content: '[[tone:curious]]这个嘛我猜是草莓味。' })
})