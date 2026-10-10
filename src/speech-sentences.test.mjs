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
      stream.push('第一句。下一')
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

test('repeated explicit delivery is idempotent and matches replay without cutting a clause', async () => {
  const prefix = '我刚才还'
  const text = `${prefix}在想，要不要换个话题。`
  for (const preferred of [undefined, 'bright']) {
    const stream = new SpeechSentenceStream('', preferred)
    stream.setDelivery('bright')
    stream.push(prefix)
    stream.setDelivery('bright')
    stream.setDelivery('bright')
    stream.push(text.slice(prefix.length))
    stream.finish()
    const actual = await collect(stream)
    assert.deepEqual(actual, [{ text, delivery: 'bright' }])
    assert.deepEqual(actual, await collect(replySentenceStream(text, preferred, [
      { start: 0, delivery: 'bright' },
      { start: prefix.length, delivery: 'bright' },
    ])))
  }
})

test('duplicate requested cues preserve a deferred keycap boundary and a newer reversion replaces it', async () => {
  for (const suffix of ['个步骤。', '\uFE0F\u20E3下一句。']) {
    const stream = new SpeechSentenceStream('', 'bright')
    stream.push('嗨1')
    stream.setDelivery('soft')
    stream.setDelivery('soft')
    stream.setDelivery('bright')
    stream.setDelivery('bright')
    stream.push(suffix)
    stream.finish()
    const actual = await collect(stream)
    assert.deepEqual(actual, [{
      text: suffix.startsWith('\uFE0F') ? '嗨下一句。' : '嗨1个步骤。',
      delivery: 'bright',
    }], 'a reverted pending cue neither survives nor cuts the original clause')
  }
})

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

test('compound endings and closing quotes survive speech filtering in fragmented and saved replies', async () => {
  for (const [text, expected] of [
    ['真的吗？！先试试。', ['真的吗？！', '先试试。']],
    ['(真的好吗？)先试试。', ['(真的好吗？)', '先试试。']],
    ['“真的吗?!”先试试。', ['“真的吗?!”', '先试试。']],
    ['"真的吗?!"先试试。', ['"真的吗?!"', '先试试。']],
  ]) {
    const replay = await collect(replySentenceStream(text, 'curious'))
    assert.deepEqual(replay, expected.map(text => ({ text, delivery: 'curious' })))
    for (const size of [1, 2, 7, text.length]) {
      const stream = new SpeechSentenceStream('', 'curious')
      for (let index = 0; index < text.length; index += size)
        stream.push(text.slice(index, index + size))
      stream.finish()
      assert.deepEqual(await collect(stream), replay)
      assert.equal(stream.text, text)
    }
  }
})

test('the first complete ending is available when new prose arrives, before finish', async () => {
  const stream = new SpeechSentenceStream('', 'curious')
  const consumer = stream[Symbol.asyncIterator]()
  let delivered = false
  const waiting = consumer.next().then(value => { delivered = true; return value })
  stream.push('（真的？')
  stream.push('！）')
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(delivered, false, 'an ending still at the available tail is observed, not prematurely submitted')
  stream.push('下一')
  assert.deepEqual((await waiting).value, { text: '（真的？！）', delivery: 'curious' })
  const next = consumer.next()
  stream.cancel()
  assert.equal((await next).done, true)
})

test('a tone boundary commits the whole ending under its original tone without moving later prose', async () => {
  for (const ending of ['真的吗？！', '“真的吗？！”', '真的吗?!', '真的吗?!）']) {
    const text = ending + '今天先休息。'
    const stream = new SpeechSentenceStream('', 'curious')
    for (const char of ending) stream.push(char)
    stream.setDelivery('soft')
    for (const char of '今天先休息。') stream.push(char)
    stream.finish()
    const expected = [
      { text: ending, delivery: 'curious' },
      { text: '今天先休息。', delivery: 'soft' },
    ]
    assert.deepEqual(await collect(stream), expected)
    assert.deepEqual(await collect(replySentenceStream(text, 'curious', [{ start: ending.length, delivery: 'soft' }])), expected)
  }
})

test('a pending ASCII ending uses the newest tone request only for later words', async () => {
  for (const prefix of ['真的吗?!', '实际是42!']) {
    const stream = new SpeechSentenceStream('', 'curious')
    stream.push(prefix)
    stream.setDelivery('soft')
    stream.setDelivery('bright')
    stream.push('下一句。')
    stream.finish()
    assert.deepEqual(await collect(stream), [
      { text: prefix, delivery: 'curious' },
      { text: '下一句。', delivery: 'bright' },
    ])
  }
})

test('reverting a deferred ASCII ending cue does not cut the original tone or add a silent sentence', async () => {
  for (const prefix of ['真的吗?!', '实际是42!']) {
    const stream = new SpeechSentenceStream('', 'curious')
    stream.push(prefix)
    stream.setDelivery('soft')
    stream.setDelivery('soft')
    stream.setDelivery('curious')
    stream.setDelivery('curious')
    stream.push('下一句。')
    stream.finish()
    assert.deepEqual(await collect(stream), [
      { text: prefix, delivery: 'curious' },
      { text: '下一句。', delivery: 'curious' },
    ])
  }
})

test('an image after a held exclamation remains silent across the tone boundary', async () => {
  const stream = new SpeechSentenceStream('', 'curious')
  stream.push('真的好吗?!')
  stream.setDelivery('soft')
  stream.push('[不朗读图片？](https://private.invalid/image.png)先休息。')
  stream.finish()
  assert.deepEqual(await collect(stream), [
    { text: '真的好吗?', delivery: 'curious' },
    { text: '先休息。', delivery: 'soft' },
  ])
})

test('a simultaneous digit and image candidate retains the real digit under its original tone', async () => {
  const prefix = '实际有42!'
  const suffix = '[不读图片?!](https://private.invalid/secret)下一句。'
  const text = prefix + suffix
  const expected = [
    { text: '实际有42', delivery: 'curious' },
    { text: '下一句。', delivery: 'soft' },
  ]
  for (const size of [1, 2, text.length]) {
    const stream = new SpeechSentenceStream('', 'curious')
    for (let index = 0; index < prefix.length; index += size)
      stream.push(prefix.slice(index, index + size))
    stream.setDelivery('soft')
    for (let index = 0; index < suffix.length; index += size)
      stream.push(suffix.slice(index, index + size))
    stream.finish()
    assert.deepEqual(await collect(stream), expected)
    assert.equal(stream.text, text)
  }
  assert.deepEqual(await collect(replySentenceStream(text, 'curious', [{ start: prefix.length, delivery: 'soft' }])), expected)
})

test('finish commits a held compound ending and cancel discards it with its deferred tone', async () => {
  for (const ending of ['真的吗？！', '真的吗?!', '实际是42!']) {
    const stream = new SpeechSentenceStream('', 'curious')
    stream.push(ending)
    stream.setDelivery('soft')
    stream.finish()
    assert.deepEqual(await collect(stream), [{ text: ending, delivery: 'curious' }])

    const canceled = new SpeechSentenceStream('', 'curious')
    canceled.push(ending)
    canceled.setDelivery('soft')
    canceled.cancel()
    await canceled.finished
    assert.equal((await canceled[Symbol.asyncIterator]().next()).done, true)
    canceled.finish()
    canceled.push('不该朗读。')
    assert.deepEqual(await collect(canceled), [])
  }
})

test('a line break releases speech before a long silent fenced body at every relevant fragment split', async () => {
  const prefix = '第一句？！\n'
  const fence = '```js\n' + 'secret();'.repeat(12_000)
  const suffix = '\n```\n下一句。'
  const text = prefix + fence + suffix
  const expected = [
    { text: '第一句？！', delivery: 'curious' },
    { text: '下一句。', delivery: 'soft' },
  ]
  for (const size of [1, 2, 7, prefix.length]) {
    const stream = new SpeechSentenceStream('', 'curious')
    const consumer = stream[Symbol.asyncIterator]()
    const first = consumer.next()
    for (let index = 0; index < prefix.length; index += size)
      stream.push(prefix.slice(index, index + size))
    assert.deepEqual((await first).value, expected[0], 'the spoken sentence is ready before any fence body arrives')
    stream.setDelivery('soft')
    stream.push(fence)
    const waiting = consumer.next()
    stream.push(suffix)
    stream.finish()
    assert.deepEqual((await waiting).value, expected[1])
    assert.equal((await consumer.next()).done, true)
    assert.equal(stream.text, text)
  }
  assert.deepEqual(await collect(replySentenceStream(text, 'curious', [{ start: prefix.length, delivery: 'soft' }])), expected)
})

test('cancel releases a consumer during a silent fenced continuation after an already delivered line', async () => {
  const stream = new SpeechSentenceStream('', 'curious')
  const consumer = stream[Symbol.asyncIterator]()
  stream.push('第一句？！\n')
  assert.deepEqual((await consumer.next()).value, { text: '第一句？！', delivery: 'curious' })
  stream.setDelivery('soft')
  stream.push('```js\n' + 'secret();'.repeat(12_000))
  const waiting = consumer.next()
  stream.cancel()
  assert.equal((await waiting).done, true)
  await stream.finished
  stream.push('\n```\n不能再念。')
  stream.finish()
  assert.deepEqual(await collect(stream), [])
})
