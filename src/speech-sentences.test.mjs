import assert from 'node:assert/strict'
import test from 'node:test'
import { deliveryAtTime, normaliseDeliveryCues, replySentenceStream, SpeechSentenceStream } from './speech-sentences.ts'

test('a tone change flushes an unfinished clause without changing queued speech', async () => {
  const stream = new SpeechSentenceStream('', 'happy')
  stream.push('太好啦！不过')
  stream.setDelivery('soft')
  stream.push('今天先休息。')
  stream.setDelivery('curious')
  stream.push('明天呢？')
  stream.finish()
  const sentences = []
  for await (const sentence of stream) sentences.push(sentence)
  assert.deepEqual(sentences, [
    { text: '太好啦！', delivery: 'happy' },
    { text: '不过', delivery: 'happy' },
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
    { start: 0, delivery: 'happy' },
    { start: 3, delivery: 'soft' },
    { start: 8, delivery: 'curious' },
  ])
  const sentences = []
  for await (const sentence of stream) sentences.push(sentence)
  assert.deepEqual(sentences.map(sentence => sentence.delivery), ['happy', 'soft', 'curious'])
  assert.equal(sentences.map(sentence => sentence.text).join(''), text)
})

test('audio time selects the right cue again after seeking backward', () => {
  const cues = [
    { time: 0, delivery: 'happy' },
    { time: 2.4, delivery: 'soft' },
    { time: 4.1, delivery: 'curious' },
  ]
  assert.equal(deliveryAtTime(cues, 0), 'happy')
  assert.equal(deliveryAtTime(cues, 2.4), 'soft')
  assert.equal(deliveryAtTime(cues, 5), 'curious')
  assert.equal(deliveryAtTime(cues, 1), 'happy')
})

const collect = async stream => {
  const sentences = []
  for await (const sentence of stream) sentences.push(sentence)
  return sentences
}

test('repeated explicit delivery is idempotent and matches replay without cutting a clause', async () => {
  const prefix = '我刚才还'
  const text = `${prefix}在想，要不要换个话题。`
  for (const preferred of [undefined, 'happy']) {
    const stream = new SpeechSentenceStream('', preferred)
    stream.setDelivery('happy')
    stream.push(prefix)
    stream.setDelivery('happy')
    stream.setDelivery('happy')
    stream.push(text.slice(prefix.length))
    stream.finish()
    const actual = await collect(stream)
    assert.deepEqual(actual, [{ text, delivery: 'happy' }])
    assert.deepEqual(actual, await collect(replySentenceStream(text, preferred, [
      { start: 0, delivery: 'happy' },
      { start: prefix.length, delivery: 'happy' },
    ])))
  }
})

test('duplicate requested cues preserve a deferred keycap boundary and a newer reversion replaces it', async () => {
  for (const suffix of ['个步骤。', '\uFE0F\u20E3下一句。']) {
    const stream = new SpeechSentenceStream('', 'happy')
    stream.push('嗨1')
    stream.setDelivery('soft')
    stream.setDelivery('soft')
    stream.setDelivery('happy')
    stream.setDelivery('happy')
    stream.push(suffix)
    stream.finish()
    const actual = await collect(stream)
    assert.deepEqual(actual, [{
      text: suffix.startsWith('\uFE0F') ? '嗨下一句。' : '嗨1个步骤。',
      delivery: 'happy',
    }], 'a reverted pending cue neither survives nor cuts the original clause')
  }
})

test('streaming and replay omit code/destinations while retaining visible cue offsets', async () => {
  const text = '太好啦！\n```python\nprint("不该念出来。")\n```\n[先歇一下。](https://example.invalid/a_(b))\n明天呢？'
  const cues = [
    { start: 0, delivery: 'happy' },
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
    { text: '太好啦！', delivery: 'happy' },
    { text: '先歇一下。', delivery: 'soft' },
    { text: '明天呢？', delivery: 'curious' },
  ])
})

test('a cue in a link label does not retroactively change already streamed words', async () => {
  const stream = new SpeechSentenceStream('', 'happy')
  stream.push('[真的好耶。')
  stream.setDelivery('soft')
  stream.push('先歇一下。](https://example.invalid)')
  stream.finish()
  assert.deepEqual(await collect(stream), [
    { text: '真的好耶。', delivery: 'happy' },
    { text: '先歇一下。', delivery: 'soft' },
  ])
})

test('only code, images, emoji or punctuation produce no spoken sentences', async () => {
  for (const text of ['```python\n[x * 2 for x in [1,2,3]]\n```', '~~~js\nalert("。")', '![日和](https://example.invalid/a.png)', '😊✨！！！…']) {
    const stream = new SpeechSentenceStream('', 'happy')
    for (const fragment of text) stream.push(fragment)
    stream.finish()
    assert.deepEqual(await collect(stream), [])
    assert.equal(stream.text, text)
  }
})

test('emoji decoration is removed from mixed speech without changing the visible reply', async () => {
  const text = '好耶😊👩‍💻🇯🇵！1️⃣ 接着说42。'
  const stream = replySentenceStream(text, 'happy')
  assert.deepEqual(await collect(stream), [
    { text: '好耶！', delivery: 'happy' },
    { text: '接着说42。', delivery: 'happy' },
  ])
  assert.equal(stream.text, text)
})

test('forced length and tone boundaries cannot turn a keycap into a spoken digit', async () => {
  assert.deepEqual(await collect(replySentenceStream('😊'.repeat(89) + '1️⃣')), [])
  const longText = '哈'.repeat(179) + '1️⃣' + '😊'
  assert.equal((await collect(replySentenceStream(longText))).map(sentence => sentence.text).join(''), '哈'.repeat(179))
  const stream = new SpeechSentenceStream('', 'happy')
  stream.push('嗨1')
  stream.setDelivery('soft')
  stream.push('\uFE0F')
  stream.push('\u20E3')
  stream.finish()
  assert.deepEqual(await collect(stream), [{ text: '嗨', delivery: 'happy' }])
  assert.equal(stream.text, '嗨1️⃣')
})

test('a real final digit belongs wholly to its original tone, including a numeric line start', async () => {
  for (const prefix of ['实际有42', '42']) {
    const stream = new SpeechSentenceStream('', 'happy')
    stream.push(prefix)
    stream.setDelivery('soft')
    stream.push('个步骤。')
    stream.finish()
    assert.deepEqual(await collect(stream), [
      { text: prefix, delivery: 'happy' },
      { text: '个步骤。', delivery: 'soft' },
    ])
  }
})

test('multiple cues on one candidate flush the old tone once and use the newest next tone', async () => {
  for (const suffix of ['个步骤。', '\uFE0F\u20E3下一句。']) {
    const stream = new SpeechSentenceStream('', 'happy')
    stream.push('嗨1')
    stream.setDelivery('soft')
    stream.setDelivery('curious')
    stream.push(suffix)
    stream.finish()
    assert.deepEqual(await collect(stream), [
      { text: suffix.startsWith('\uFE0F') ? '嗨' : '嗨1', delivery: 'happy' },
      { text: suffix.startsWith('\uFE0F') ? '下一句。' : suffix, delivery: 'curious' },
    ])
  }
})

test('finish preserves a real incomplete candidate under the old tone; cancel emits nothing', async () => {
  for (const tail of ['42', '42\uFE0F']) {
    const stream = new SpeechSentenceStream('', 'happy')
    stream.push(`实际有${tail}`)
    stream.setDelivery('soft')
    stream.finish()
    assert.deepEqual(await collect(stream), [{ text: '实际有42', delivery: 'happy' }])
  }
  const canceled = new SpeechSentenceStream('', 'happy')
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
    const cues = [{ start: 0, delivery: 'happy' }, { start: prefix.length, delivery: 'soft' }]
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
    stream.setDelivery('happy')
    stream.push('下一句。')
    stream.finish()
    assert.deepEqual(await collect(stream), [
      { text: prefix, delivery: 'curious' },
      { text: '下一句。', delivery: 'happy' },
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

test('an act starts a new sentence, belongs to the next one with words, and only the first counts', async () => {
  const plan = async (...args) => {
    const sentences = []
    for await (const sentence of replySentenceStream(...args)) sentences.push(sentence)
    return sentences
  }
  // At the start of a reply: no split, the first sentence carries it.
  assert.deepEqual(await plan('哈哈，真的假的。我也想去。', 'happy', [], '', [{ start: 0, act: 'laugh' }]),
    [{ text: '哈哈，真的假的。', delivery: 'happy', act: 'laugh' }, { text: '我也想去。', delivery: 'happy' }])
  // Mid-sentence: the clause before it stays its own sentence.
  assert.deepEqual(await plan('这个嘛我想想，应该可以。', 'curious', [], '', [{ start: 3, act: 'pause' }]),
    [{ text: '这个嘛', delivery: 'curious' }, { text: '我想想，应该可以。', delivery: 'curious', act: 'pause' }])
  // A trailing act has nothing to go before, so it is dropped (before the
  // final 。 it still splits it off; the live brain drops such acts first).
  assert.deepEqual(await plan('好的。', 'neutral', [], '', [{ start: 2, act: 'sigh' }]), [{ text: '好的', delivery: 'neutral' }])
  // A tone change and an act at one offset: the act's sentence has the new tone.
  assert.deepEqual(await plan('还行吧。真的太好了！', 'neutral', [{ start: 4, delivery: 'happy' }], '', [{ start: 4, act: 'laugh' }]),
    [{ text: '还行吧。', delivery: 'neutral' }, { text: '真的太好了！', delivery: 'happy', act: 'laugh' }])
  // Only one act per reply; sentences without one have no act key at all.
  const two = await plan('一句。两句。', 'neutral', [], '', [{ start: 0, act: 'laugh' }, { start: 3, act: 'sigh' }])
  assert.deepEqual(two, [{ text: '一句。', delivery: 'neutral', act: 'laugh' }, { text: '两句。', delivery: 'neutral' }])
  assert.equal(Object.hasOwn(two[1], 'act'), false)
})

test('a tone change and an act at one deferred boundary both apply', async () => {
  // "1" may start a keycap, so the boundary is deferred until it resolves.
  const stream = new SpeechSentenceStream('', 'neutral')
  stream.push('好的1')
  stream.setDelivery('happy')
  stream.setAct('laugh')
  stream.push('就这样。')
  stream.finish()
  const sentences = []
  for await (const sentence of stream) sentences.push(sentence)
  assert.deepEqual(sentences, [{ text: '好的1', delivery: 'neutral' }, { text: '就这样。', delivery: 'happy', act: 'laugh' }])
})

test('old bright cues are read as happy and merged with a following happy cue', async () => {
  assert.deepEqual(normaliseDeliveryCues([{ start: 0, delivery: 'bright' }, { start: 3, delivery: 'happy' }], 6), [{ start: 0, delivery: 'happy' }])
  const sentences = []
  for await (const sentence of replySentenceStream('好耶好耶。', 'bright')) sentences.push(sentence)
  assert.deepEqual(sentences, [{ text: '好耶好耶。', delivery: 'happy' }])
})

test('joinSpokenText keeps CJK tight and spaces Latin words apart', async () => {
  const { joinSpokenText } = await import('./speech-sentences.ts')
  assert.equal(joinSpokenText(['你好。', '今天好。']), '你好。今天好。')
  assert.equal(joinSpokenText(['Hello Hiyori!', 'Rest well.']), 'Hello Hiyori! Rest well.')
  assert.equal(joinSpokenText(['好！', 'DeepSeek 来了。']), '好！DeepSeek 来了。', 'full-width end: no space')
  assert.equal(joinSpokenText(['OK.', '好的。']), 'OK.好的。', 'a CJK start: no space')
  assert.equal(joinSpokenText([]), '')
})

test('joinSentence refuses another tone, an act on the next, an unfinished clip and an over-long result', async () => {
  const { joinSentence, joinLimit, JOIN_FIRST_UNITS, JOIN_MAX_UNITS, JOIN_MIN_UNITS } = await import('./speech-sentences.ts')
  const happy = text => ({ text, delivery: 'happy' })
  assert.deepEqual(joinSentence(happy('一。'), happy('二。'), 40), happy('一。二。'))
  assert.deepEqual(joinSentence({ ...happy('哈哈。'), act: 'laugh' }, happy('好。'), 40), { ...happy('哈哈。好。'), act: 'laugh' }, 'the clip keeps its act at the start')
  assert.equal(joinSentence(happy('一。'), { text: '二。', delivery: 'sad' }, 40), null)
  assert.equal(joinSentence(happy('一。'), { ...happy('二。'), act: 'pause' }, 40), null)
  for (const unfinished of ['第一行', '我想想，', '等一下：', '嗯……'])
    assert.equal(joinSentence(happy(unfinished), happy('二。'), 40), null, unfinished)
  for (const finished of ['真的？', '好!', '对；', '他说“好。”', '（笑）好。）', '「好！」'])
    assert.ok(joinSentence(happy(finished), happy('二。'), 40), finished)
  assert.equal(joinSentence(happy('一二三。'), happy('四五。'), 6), null)
  assert.ok(joinSentence(happy('一二三。'), happy('四五。'), 7))
  assert.deepEqual([undefined, 0, 5, 15, 40, 150].map(joinLimit), [40, 20, 20, 30, 60, 60])
  assert.deepEqual([JOIN_FIRST_UNITS, JOIN_MIN_UNITS, JOIN_MAX_UNITS], [40, 20, 60])
})

test('groupSentences is greedy under the limit chain and flattens back to the sentences', async () => {
  const { groupSentences, joinSpokenText } = await import('./speech-sentences.ts')
  const happy = text => ({ text, delivery: 'happy' })
  assert.deepEqual(groupSentences([happy('只有一句。')]), [{ ...happy('只有一句。'), parts: ['只有一句。'] }])
  assert.deepEqual(groupSentences([]), [])
  const long = `${'长'.repeat(49)}。`
  assert.deepEqual(groupSentences([happy(long), happy('短。')]).map(clip => clip.parts.length), [1, 1], 'over the first limit: alone')
  const chain = [happy(`${'一'.repeat(9)}。`), happy(`${'二'.repeat(9)}。`), happy(`${'三'.repeat(19)}。`), happy(`${'四'.repeat(19)}。`), happy(`${'五'.repeat(19)}。`), happy(`${'六'.repeat(19)}。`), happy('七。')]
  const clips = groupSentences(chain)
  assert.deepEqual(clips.map(clip => clip.text.length), [40, 60, 2], '40, then up to twice that capped at 60')
  assert.deepEqual(clips.flatMap(clip => clip.parts), chain.map(sentence => sentence.text))
  for (const clip of clips)
    assert.equal(clip.text, joinSpokenText(clip.parts))
  assert.deepEqual(groupSentences(chain, false).map(clip => clip.parts.length), [1, 1, 1, 1, 1, 1, 1])
  const mixed = groupSentences([happy('一。'), { text: '二。', delivery: 'sad' }, { text: '三。', delivery: 'sad' }, { ...happy('四。'), act: 'laugh' }, happy('五。')])
  assert.deepEqual(mixed.map(clip => [clip.text, clip.delivery, clip.act ?? null]), [
    ['一。', 'happy', null], ['二。三。', 'sad', null], ['四。五。', 'happy', 'laugh'],
  ])
  assert.equal(Object.hasOwn(mixed[0], 'act'), false, 'no act key without an act')
})

test('takeReady never waits, takes only what accept wants, and the iterator neither skips nor repeats', async () => {
  const { SpeechSentenceStream } = await import('./speech-sentences.ts')
  const stream = new SpeechSentenceStream('', 'neutral')
  assert.equal(stream.takeReady(() => true), undefined, 'nothing queued')
  stream.push('一。二。三。四')
  assert.equal(stream.done, false)
  const seen = []
  const iterator = stream[Symbol.asyncIterator]()
  seen.push((await iterator.next()).value.text)
  assert.equal(stream.takeReady(sentence => sentence.text === '三。'), undefined, 'only the head is offered')
  seen.push(stream.takeReady(() => true).text)
  stream.finish()
  assert.equal(stream.done, true)
  for (let next = await iterator.next(); !next.done; next = await iterator.next())
    seen.push(next.value.text)
  assert.deepEqual(seen, ['一。', '二。', '三。', '四'])
  const cancelled = new SpeechSentenceStream('', 'neutral')
  cancelled.push('一。二。三')
  cancelled.cancel()
  assert.equal(cancelled.takeReady(() => true), undefined)
})

test('upcomingDelivery announces a tone change one lead ahead, inside the source or from the next clip', async () => {
  const { TONE_LEAD_SECONDS, upcomingDelivery } = await import('./speech-sentences.ts')
  assert.equal(TONE_LEAD_SECONDS, 0.18)
  const cues = [{ time: 0, delivery: 'happy' }, { time: 1, delivery: 'sad' }]
  // A change within the source (the completed replay).
  assert.equal(upcomingDelivery(cues, 0.81, 2, null), null, 'more than a lead before the cue')
  assert.equal(upcomingDelivery(cues, 0.83, 2, null), 'sad')
  assert.equal(upcomingDelivery(cues, 0.83, 2, 'shy'), 'sad', 'next only counts past the end')
  assert.equal(upcomingDelivery(cues, 1, 2, null), null, 'nothing once it is the current tone')
  assert.equal(upcomingDelivery(cues, 0.2, 2, null), null, 'a backward seek takes it back')
  // A change into the next clip past the end.
  assert.equal(upcomingDelivery(cues, 1.81, 2, 'shy'), null)
  assert.equal(upcomingDelivery(cues, 1.83, 2, 'shy'), 'shy')
  // The same tone, or no next clip ready.
  assert.equal(upcomingDelivery(cues, 1.9, 2, 'sad'), null)
  assert.equal(upcomingDelivery(cues, 1.9, 2, null), null)
  // At or past the end.
  assert.equal(upcomingDelivery(cues, 2, 2, 'shy'), 'shy')
  assert.equal(upcomingDelivery(cues, 2.5, 2, 'shy'), 'shy')
  assert.equal(upcomingDelivery(cues, 2.5, 2, null), null)
  assert.equal(upcomingDelivery(cues, 2.5, 2, 'sad'), null)
  // A custom lead.
  assert.equal(upcomingDelivery(cues, 0.5, 2, null, 0.5), 'sad', 'a cue exactly one lead ahead counts')
  // A cue inside the source's last lead (a short final clip in a replay) is
  // announced and stays announced until it is spoken.
  const short = [{ time: 0, delivery: 'happy' }, { time: 1.9, delivery: 'shy' }]
  assert.equal(upcomingDelivery(short, 1.75, 2, null), 'shy')
  assert.equal(upcomingDelivery(short, 1.85, 2, null), 'shy', 'not taken back once time + lead passes the end')
  assert.equal(upcomingDelivery(short, 1.85, 2, 'sad'), 'shy', 'the cue inside the source wins over the next clip')
  assert.equal(upcomingDelivery(cues, 0.4, 2, null, 0.5), null)
  assert.equal(upcomingDelivery(cues, 1.6, 2, 'shy', 0.5), 'shy')
  assert.equal(upcomingDelivery(cues, 0.99, 2, null, 0), null, 'no lead looks at nothing ahead')
  // Before any cue the tone is neutral, as in deliveryAtTime.
  assert.equal(upcomingDelivery([], 0, 0, 'happy'), 'happy')
  assert.equal(upcomingDelivery([], 0, 0, 'neutral'), null)
})
