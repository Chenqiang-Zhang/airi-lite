import assert from 'node:assert/strict'
import test from 'node:test'

import { STAGE_PROTOCOL } from '../../shared/performance-cues.mjs'
import { groupSentences, joinSpokenText, replySentenceStream } from '../../src/speech-sentences.ts'
import { parseRules } from './moderation.mjs'
import { createClipAllowance, planClips, planUtterance, screenUtterance } from './utterance.mjs'

async function stageSentences(text, delivery, cues, acts = []) {
  const sentences = []
  // The exact call src/speech.ts speak() makes for a reply.
  for await (const sentence of replySentenceStream(text, delivery, cues, '', acts))
    sentences.push(sentence)
  return sentences
}

test('the server plan matches what the stage will request, cue for cue', async () => {
  const cases = [
    ['你好。今天天气不错。', 'neutral', []],
    ['先开心一下。然后轻轻说。最后问你？', 'happy', [{ start: 6, delivery: 'soft' }, { start: 12, delivery: 'curious' }]],
    ['旧的语气名。', 'bright', [{ start: 0, delivery: 'bright' }]],
    ['看这个：https://example.com/a?b=1 好吗？', 'curious', []],
    ['```js\nconsole.log(1)\n```\n代码之后的一句。', 'neutral', []],
    [`${'很长的一句话'.repeat(40)}。`, 'soft', []],
    ['……', 'neutral', []],
  ]
  for (const [text, delivery, cues] of cases)
    assert.deepEqual(await planUtterance({ text, delivery, cues }), await stageSentences(text, delivery, cues), text.slice(0, 12))
  assert.deepEqual(await planUtterance({ text: '……' }), [], 'symbols only: nothing to buy')
  assert.deepEqual(await planUtterance({ text: '旧的语气名。', delivery: 'bright' }), [{ text: '旧的语气名。', delivery: 'happy' }], 'the old name plans as happy')
})

test('acts plan the same on server and stage, and only the sentence after one carries it', async () => {
  const cases = [
    ['哈哈，你也太逗了。再说一句。', 'happy', [{ start: 0, delivery: 'happy' }], [{ start: 0, act: 'laugh' }]],
    ['这个嘛我猜是草莓味。', 'curious', [], [{ start: 3, act: 'pause' }]],
    ['先说一句。唉，好吧。', 'neutral', [{ start: 5, delivery: 'sad' }], [{ start: 5, act: 'sigh' }]],
    ['好的。……', 'neutral', [], [{ start: 3, act: 'laugh' }]],
    ['两个动作。只算第一个。', 'neutral', [], [{ start: 5, act: 'sigh' }, { start: 0, act: 'laugh' }]],
  ]
  for (const [text, delivery, cues, acts] of cases)
    assert.deepEqual(await planUtterance({ text, delivery, cues, acts }), await stageSentences(text, delivery, cues, acts), text)
  assert.deepEqual(await planUtterance({ text: '哈哈，你也太逗了。再说一句。', delivery: 'happy', acts: [{ start: 0, act: 'laugh' }] }), [
    { text: '哈哈，你也太逗了。', delivery: 'happy', act: 'laugh' }, { text: '再说一句。', delivery: 'happy' },
  ])
  assert.deepEqual(await planUtterance({ text: '这个嘛我猜是草莓味。', acts: [{ start: 3, act: 'pause' }] }), [
    { text: '这个嘛', delivery: 'neutral' }, { text: '我猜是草莓味。', delivery: 'neutral', act: 'pause' },
  ], 'an act starts a new sentence')
  assert.deepEqual(await planUtterance({ text: '好的。……', acts: [{ start: 3, act: 'laugh' }] }), [{ text: '好的。', delivery: 'neutral' }], 'nothing to perform it before')
  const [plain] = await planUtterance({ text: '没有动作。' })
  assert.equal(Object.hasOwn(plain, 'act'), false, 'no act key without an act')
})

test('screening plans with the acts but still reads the joined words', async () => {
  // An act splitting "刷" from "礼物" must not hide the term from the gate.
  const verdict = await screenUtterance({ text: '记得刷礼物哦。', acts: [{ start: 3, act: 'pause' }] })
  assert.deepEqual([verdict.reason, verdict.term], ['blocklist', '刷礼物'])
  assert.deepEqual(await screenUtterance({ text: '哈哈，好呀。', acts: [{ start: 0, act: 'laugh' }] }), { ok: true })
})

test('screening covers the spaced words a joined Latin clip says, locally only', async () => {
  // Short Latin terms are whole-word rules, so the space a joined clip puts
  // between two sentences can make one appear.
  const rules = parseRules('sb')
  const spaced = await screenUtterance({ text: 'Look at this!Sb is here.' }, { rules })
  assert.deepEqual([spaced.ok, spaced.term, spaced.part], [false, 'sb', 'speech'])
  const split = await screenUtterance({ text: 'ok s!b you.' }, { rules })
  assert.deepEqual([split.ok, split.term], [false, 'sb'], 'the unspaced words are still read too')
  const checked = []
  const provider = { check: async (text) => { checked.push(text); return { ok: true } } }
  assert.deepEqual(await screenUtterance({ text: 'Hello Hiyori!Rest well.' }, { rules, provider }), { ok: true })
  assert.deepEqual(checked, ['Hello Hiyori!Rest well.', 'Hello Hiyori!Rest well.'], 'the paid check reads the caption and the speech once each, never the spaced form')
})

test('clips join same-tone finished sentences under the limit chain; the server and stage agree', async () => {
  const cases = [
    ['晚上好呀！今天弹幕好热闹。我们先从第一条开始吧。', 'happy', [], []],
    ['好！好！再见。', 'happy', [], []],
    ['先开心一下。然后轻轻说。最后问你？', 'happy', [{ start: 6, delivery: 'soft' }], []],
    ['哈哈，你也太逗了。再说一句。还有一句。', 'happy', [], [{ start: 9, act: 'laugh' }]],
    ['第一行\n第二行。', 'neutral', [], []],
    ['一。\n二。', 'neutral', [], []],
    ['Hello Hiyori! Rest with DeepSeek.', 'neutral', [], []],
    [`${'很长的一句话'.repeat(8)}。短句。`, 'soft', [], []],
  ]
  for (const [text, delivery, cues, acts] of cases) {
    const clips = await planClips({ text, delivery, cues, acts })
    assert.deepEqual(clips, groupSentences(await stageSentences(text, delivery, cues, acts)), text)
    assert.deepEqual(clips.flatMap(clip => clip.parts), (await planUtterance({ text, delivery, cues, acts })).map(sentence => sentence.text))
    for (const clip of clips)
      assert.equal(clip.text, joinSpokenText(clip.parts))
    assert.deepEqual(await planClips({ text, delivery, cues, acts }, { join: false }),
      (await planUtterance({ text, delivery, cues, acts })).map(sentence => ({ ...sentence, parts: [sentence.text] })), 'join: false is one clip per sentence')
  }
})

// Changing a join rule changes what the stage buys: bump STAGE_PROTOCOL so
// older stage pages reload, then update this table.
test('the clip plans are pinned to the stage protocol', async () => {
  const replies = [
    ['晚上好呀！今天弹幕好热闹。我们先从第一条开始吧。', 'happy', []],
    ['嗯……晚上本来就容易想多。不急着睡也没关系，先陪你说说话吧。', 'soft', []],
    ['草莓党举手！大福的话还是草莓的最好吃，软软糯糯。', 'happy', []],
    ['好！好！好！好！好！好！好！好！好！好！好！好！好！好！好！好！好！好！好！好！好！再见。', 'happy', []],
    ['这个梗我接住了！你们今天弹幕好热闹。还有呢？', 'happy', [{ start: 8, act: 'laugh' }]],
    ['这个嘛我猜是草莓味。', 'curious', [{ start: 3, act: 'pause' }]],
    ['Hello Hiyori! Rest with DeepSeek.', 'neutral', []],
  ]
  const plans = []
  for (const [text, delivery, acts] of replies)
    plans.push((await planClips({ text, delivery, acts })).map(clip => [clip.text, clip.act ?? null, clip.parts.length]))
  assert.deepEqual([STAGE_PROTOCOL, plans], [3, [
    [['晚上好呀！今天弹幕好热闹。我们先从第一条开始吧。', null, 3]],
    [['嗯……晚上本来就容易想多。不急着睡也没关系，先陪你说说话吧。', null, 2]],
    [['草莓党举手！大福的话还是草莓的最好吃，软软糯糯。', null, 2]],
    [['好！好！好！好！好！好！好！好！好！好！好！好！好！好！好！好！好！好！好！好！', null, 20], ['好！再见。', null, 2]],
    [['这个梗我接住了！', null, 1], ['你们今天弹幕好热闹。还有呢？', 'laugh', 2]],
    [['这个嘛', null, 1], ['我猜是草莓味。', 'pause', 1]],
    [['Hello Hiyori! Rest with DeepSeek.', null, 2]],
  ]])
})

test('the allowance is a multiset of planned clips and returns their sentences', () => {
  const allowance = createClipAllowance([
    { text: '好！', delivery: 'happy', parts: ['好！'] }, { text: '好！', delivery: 'happy', parts: ['好！'] },
    { text: '再见。明天见。', delivery: 'soft', parts: ['再见。', '明天见。'] },
  ])
  assert.equal(allowance.remaining, 3)
  assert.equal(allowance.take({ text: '好！', delivery: 'soft' }), null, 'delivery is part of the key')
  assert.deepEqual(allowance.take({ text: '好！', delivery: 'happy' }), ['好！'])
  assert.deepEqual(allowance.take({ text: '好！', delivery: 'happy' }), ['好！'])
  assert.equal(allowance.take({ text: '好！', delivery: 'happy' }), null, 'never more often than planned')
  assert.equal(allowance.take({ text: '再见。', delivery: 'soft' }), null, 'one sentence of a joined clip cannot be bought alone')
  assert.equal(allowance.take({ text: '再见。明天见', delivery: 'soft' }), null, 'exact text only')
  assert.deepEqual(allowance.take({ text: '再见。明天见。', delivery: 'soft' }), ['再见。', '明天见。'])
  assert.equal(allowance.remaining, 0)
  const unjoined = createClipAllowance([{ text: '一。', delivery: 'happy', parts: ['一。'] }, { text: '二。', delivery: 'happy', parts: ['二。'] }])
  assert.equal(unjoined.take({ text: '一。二。', delivery: 'happy' }), null, 'nor can a stage join its own')
})

test('the act is part of the allowance key: none added, none removed, none changed', () => {
  const allowance = createClipAllowance([{ text: '哈哈，好呀。', delivery: 'happy', act: 'laugh', parts: ['哈哈，好呀。'] }, { text: '再见。', delivery: 'happy', parts: ['再见。'] }])
  assert.equal(allowance.take({ text: '哈哈，好呀。', delivery: 'happy' }), null, 'a planned laugh cannot be dropped')
  assert.equal(allowance.take({ text: '哈哈，好呀。', delivery: 'happy', act: 'sigh' }), null)
  assert.equal(allowance.take({ text: '再见。', delivery: 'happy', act: 'pause' }), null, 'nor a pause added')
  assert.deepEqual(allowance.take({ text: '哈哈，好呀。', delivery: 'happy', act: 'laugh' }), ['哈哈，好呀。'])
  assert.deepEqual(allowance.take({ text: '再见。', delivery: 'happy', act: null }), ['再见。'], 'null is no act')
  assert.equal(allowance.remaining, 0)
  // Joining with a separator could be forged across fields; JSON cannot.
  const tricky = createClipAllowance([{ text: 'b', delivery: 'happy', act: 'laugh', parts: ['b'] }])
  assert.equal(tricky.take({ text: 'laugh","b', delivery: 'happy' }), null)
})
