import assert from 'node:assert/strict'
import test from 'node:test'

import { replySentenceStream } from '../../src/speech-sentences.ts'
import { createSentenceAllowance, planUtterance } from './utterance.mjs'

async function stageSentences(text, delivery, cues) {
  const sentences = []
  // The exact call src/speech.ts speak() makes for a reply.
  for await (const sentence of replySentenceStream(text, delivery, cues))
    sentences.push({ text: sentence.text, delivery: sentence.delivery })
  return sentences
}

test('the server plan matches what the stage will request, cue for cue', async () => {
  const cases = [
    ['你好。今天天气不错。', 'neutral', []],
    ['先开心一下。然后轻轻说。最后问你？', 'bright', [{ start: 6, delivery: 'soft' }, { start: 12, delivery: 'curious' }]],
    ['看这个：https://example.com/a?b=1 好吗？', 'curious', []],
    ['```js\nconsole.log(1)\n```\n代码之后的一句。', 'neutral', []],
    [`${'很长的一句话'.repeat(40)}。`, 'soft', []],
    ['……', 'neutral', []],
  ]
  for (const [text, delivery, cues] of cases)
    assert.deepEqual(await planUtterance({ text, delivery, cues }), await stageSentences(text, delivery, cues), text.slice(0, 12))
  assert.deepEqual(await planUtterance({ text: '……' }), [], 'symbols only: nothing to buy')
})

test('the allowance is a multiset of planned sentences', () => {
  const allowance = createSentenceAllowance([
    { text: '好！', delivery: 'bright' }, { text: '好！', delivery: 'bright' }, { text: '再见。', delivery: 'soft' },
  ])
  assert.equal(allowance.remaining, 3)
  assert.equal(allowance.take({ text: '好！', delivery: 'soft' }), false, 'delivery is part of the key')
  assert.equal(allowance.take({ text: '好！', delivery: 'bright' }), true)
  assert.equal(allowance.take({ text: '好！', delivery: 'bright' }), true)
  assert.equal(allowance.take({ text: '好！', delivery: 'bright' }), false, 'never more often than planned')
  assert.equal(allowance.take({ text: '再见', delivery: 'soft' }), false, 'exact text only')
  assert.equal(allowance.take({ text: '再见。', delivery: 'soft' }), true)
  assert.equal(allowance.remaining, 0)
})
