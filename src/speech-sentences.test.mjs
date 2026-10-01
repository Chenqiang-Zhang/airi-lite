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

const collect = async stream => {
  const sentences = []
  for await (const sentence of stream) sentences.push(sentence)
  return sentences
}

test('streaming and replay omit code/destinations while retaining visible cue offsets', async () => {
  const text = '太好啦！\n```python\nprint("不该念出来。")\n```\n[先歇一下。](https://example.invalid/a_(b))\n明天呢？'
  const cues = [
    { start: 0, delivery: 'bright' },
    { start: text.indexOf('print') + 2, delivery: 'soft' },
    { start: text.indexOf('明天'), delivery: 'curious' },
  ]
  const streaming = new SpeechSentenceStream()
  for (let index = 0; index < text.length; index++) {
    for (const cue of cues.filter(cue => cue.start === index)) streaming.setDelivery(cue.delivery)
    streaming.push(text[index])
  }
  streaming.finish()
  const spoken = await collect(streaming)
  assert.equal(streaming.text, text)
  assert.deepEqual(spoken, await collect(replySentenceStream(text, undefined, cues)))
  assert.deepEqual(spoken, [
    { text: '太好啦！', delivery: 'bright' },
    { text: '先歇一下。', delivery: 'soft' },
    { text: '明天呢？', delivery: 'curious' },
  ])
})

test('a cue in a link label does not retroactively change already streamed words', async () => {
  const stream = new SpeechSentenceStream('', 'bright')
  stream.push('[真的好耶。')
  stream.setDelivery('soft')
  stream.push('先歇一下。](https://example.invalid)')
  stream.finish()
  assert.deepEqual(await collect(stream), [
    { text: '真的好耶。', delivery: 'bright' },
    { text: '先歇一下。', delivery: 'soft' },
  ])
})

test('only code, images, emoji or punctuation produce no spoken sentences', async () => {
  for (const text of ['```python\n[x * 2 for x in [1,2,3]]\n```', '~~~js\nalert("。")', '![日和](https://example.invalid/a.png)', '😊✨！！！…']) {
    const stream = new SpeechSentenceStream('', 'bright')
    for (const fragment of text) stream.push(fragment)
    stream.finish()
    assert.deepEqual(await collect(stream), [])
    assert.equal(stream.text, text)
  }
})

test('emoji decoration is removed from mixed speech without changing the visible reply', async () => {
  const text = '好耶😊👩‍💻🇯🇵！1️⃣ 接着说42。'
  const stream = replySentenceStream(text, 'bright')
  assert.deepEqual(await collect(stream), [
    { text: '好耶！', delivery: 'bright' },
    { text: '接着说42。', delivery: 'bright' },
  ])
  assert.equal(stream.text, text)
})

test('forced length and tone boundaries cannot turn a keycap into a spoken digit', async () => {
  assert.deepEqual(await collect(replySentenceStream('😊'.repeat(89) + '1️⃣')), [])
  const longText = '哈'.repeat(179) + '1️⃣' + '😊'
  assert.equal((await collect(replySentenceStream(longText))).map(sentence => sentence.text).join(''), '哈'.repeat(179))
  const stream = new SpeechSentenceStream('', 'bright')
  stream.push('嗨1')
  stream.setDelivery('soft')
  stream.push('\uFE0F')
  stream.push('\u20E3')
  stream.finish()
  assert.deepEqual(await collect(stream), [{ text: '嗨', delivery: 'bright' }])
  assert.equal(stream.text, '嗨1️⃣')
})

test('a real final digit belongs wholly to its original tone, including a numeric line start', async () => {
  for (const prefix of ['实际有42', '42']) {
    const stream = new SpeechSentenceStream('', 'bright')
    stream.push(prefix)
    stream.setDelivery('soft')
    stream.push('个步骤。')
    stream.finish()
    assert.deepEqual(await collect(stream), [
      { text: prefix, delivery: 'bright' },
      { text: '个步骤。', delivery: 'soft' },
    ])
  }
})

test('multiple cues on one candidate flush the old tone once and use the newest next tone', async () => {
  for (const suffix of ['个步骤。', '\uFE0F\u20E3下一句。']) {
    const stream = new SpeechSentenceStream('', 'bright')
    stream.push('嗨1')
    stream.setDelivery('soft')
    stream.setDelivery('curious')
    stream.push(suffix)
    stream.finish()
    assert.deepEqual(await collect(stream), [
      { text: suffix.startsWith('\uFE0F') ? '嗨' : '嗨1', delivery: 'bright' },
      { text: suffix.startsWith('\uFE0F') ? '下一句。' : suffix, delivery: 'curious' },
    ])
  }
})

test('finish preserves a real incomplete candidate under the old tone; cancel emits nothing', async () => {
  for (const tail of ['42', '42\uFE0F']) {
    const stream = new SpeechSentenceStream('', 'bright')
    stream.push(`实际有${tail}`)
    stream.setDelivery('soft')
    stream.finish()
    assert.deepEqual(await collect(stream), [{ text: '实际有42', delivery: 'bright' }])
  }
  const canceled = new SpeechSentenceStream('', 'bright')
  canceled.push('实际有42')
  canceled.setDelivery('soft')
  const waiting = canceled[Symbol.asyncIterator]().next()
  canceled.cancel()
  assert.equal((await waiting).done, true)
  canceled.finish()
  canceled.push('个步骤。')
  assert.deepEqual(await collect(canceled), [])
})

test('streaming and replay agree when a cue falls after a real digit or inside a keycap', async () => {
  for (const [prefix, suffix] of [['实际有42', '个步骤。'], ['嗨1', '\uFE0F\u20E3下一句。']]) {
    const text = prefix + suffix
    const cues = [{ start: 0, delivery: 'bright' }, { start: prefix.length, delivery: 'soft' }]
    const stream = new SpeechSentenceStream()
    for (let index = 0; index < text.length; index++) {
      for (const cue of cues.filter(cue => cue.start === index)) stream.setDelivery(cue.delivery)
      stream.push(text[index])
    }
    stream.finish()
    assert.deepEqual(await collect(stream), await collect(replySentenceStream(text, undefined, cues)))
    assert.equal(stream.text, text)
  }
})
