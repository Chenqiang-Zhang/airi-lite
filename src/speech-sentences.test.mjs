import assert from 'node:assert/strict'
import test from 'node:test'
import { deliveryAtTime, replySentenceStream, SpeechSentenceStream } from './speech-sentences.ts'

test('a tone change flushes an unfinished clause without changing queued speech', async () => {
  const stream = new SpeechSentenceStream('', 'bright')
  stream.push('太好啦！不过')
  stream.setDelivery('soft')
  stream.push('今天先休息。')
  stream.setDelivery('curious')
  stream.push('明天呢？')
  stream.finish()
  const sentences = []
  for await (const sentence of stream) sentences.push(sentence)
  assert.deepEqual(sentences, [
    { text: '太好啦！', delivery: 'bright' },
    { text: '不过', delivery: 'bright' },
    { text: '今天先休息。', delivery: 'soft' },
    { text: '明天呢？', delivery: 'curious' },
  ])
})

test('cancel wakes an empty consumer both before the first sentence and between sentences', async () => {
  for (const betweenSentences of [false, true]) {
    const stream = new SpeechSentenceStream()
    const consumer = stream[Symbol.asyncIterator]()
    if (betweenSentences) {
      stream.push('第一句。')
      assert.equal((await consumer.next()).value.text, '第一句。')
    }
    const waiting = consumer.next()
    stream.cancel()
    await stream.finished
    assert.equal((await waiting).done, true)
    stream.push('取消后不能加入这句。')
    assert.equal((await consumer.next()).done, true)
  }
})

test('saved reply offsets reproduce tone changes when speech is generated again', async () => {
  const text = '好耶！先歇一下。明天呢？'
  const stream = replySentenceStream(text, 'neutral', [
    { start: 0, delivery: 'bright' },
    { start: 3, delivery: 'soft' },
    { start: 8, delivery: 'curious' },
  ])
  const sentences = []
  for await (const sentence of stream) sentences.push(sentence)
  assert.deepEqual(sentences.map(sentence => sentence.delivery), ['bright', 'soft', 'curious'])
  assert.equal(sentences.map(sentence => sentence.text).join(''), text)
})

test('audio time selects the right cue again after seeking backward', () => {
  const cues = [
    { time: 0, delivery: 'bright' },
    { time: 2.4, delivery: 'soft' },
    { time: 4.1, delivery: 'curious' },
  ]
  assert.equal(deliveryAtTime(cues, 0), 'bright')
  assert.equal(deliveryAtTime(cues, 2.4), 'soft')
  assert.equal(deliveryAtTime(cues, 5), 'curious')
  assert.equal(deliveryAtTime(cues, 1), 'bright')
})
