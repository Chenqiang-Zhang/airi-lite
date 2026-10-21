import assert from 'node:assert/strict'
import test from 'node:test'

import { replySentenceStream } from '../../src/speech-sentences.ts'
import { createSentenceAllowance, planUtterance, screenUtterance } from './utterance.mjs'

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

test('the allowance is a multiset of planned sentences', () => {
  const allowance = createSentenceAllowance([
    { text: '好！', delivery: 'happy' }, { text: '好！', delivery: 'happy' }, { text: '再见。', delivery: 'soft' },
  ])
  assert.equal(allowance.remaining, 3)
  assert.equal(allowance.take({ text: '好！', delivery: 'soft' }), false, 'delivery is part of the key')
  assert.equal(allowance.take({ text: '好！', delivery: 'happy' }), true)
  assert.equal(allowance.take({ text: '好！', delivery: 'happy' }), true)
  assert.equal(allowance.take({ text: '好！', delivery: 'happy' }), false, 'never more often than planned')
  assert.equal(allowance.take({ text: '再见', delivery: 'soft' }), false, 'exact text only')
  assert.equal(allowance.take({ text: '再见。', delivery: 'soft' }), true)
  assert.equal(allowance.remaining, 0)
})

test('the act is part of the allowance key: none added, none removed, none changed', () => {
  const allowance = createSentenceAllowance([{ text: '哈哈，好呀。', delivery: 'happy', act: 'laugh' }, { text: '再见。', delivery: 'happy' }])
  assert.equal(allowance.take({ text: '哈哈，好呀。', delivery: 'happy' }), false, 'a planned laugh cannot be dropped')
  assert.equal(allowance.take({ text: '哈哈，好呀。', delivery: 'happy', act: 'sigh' }), false)
  assert.equal(allowance.take({ text: '再见。', delivery: 'happy', act: 'pause' }), false, 'nor a pause added')
  assert.equal(allowance.take({ text: '哈哈，好呀。', delivery: 'happy', act: 'laugh' }), true)
  assert.equal(allowance.take({ text: '再见。', delivery: 'happy', act: null }), true, 'null is no act')
  assert.equal(allowance.remaining, 0)
  // Joining with a separator could be forged across fields; JSON cannot.
  const tricky = createSentenceAllowance([{ text: 'b', delivery: 'happy', act: 'laugh' }])
  assert.equal(tricky.take({ text: 'laugh","b', delivery: 'happy' }), false)
})
