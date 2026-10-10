import assert from 'node:assert/strict'
import test from 'node:test'

import { SentenceBuffer } from './sentence-buffer.ts'

test('keeps names split across streaming deltas intact', () => {
  const buffer = new SentenceBuffer()
  assert.deepEqual(buffer.push('Deep'), [])
  assert.deepEqual(buffer.push('Seek 今天好快。下'), ['DeepSeek 今天好快。'])
  assert.deepEqual(buffer.push('一句呢？'), [])
  assert.deepEqual(buffer.finish(), ['下一句呢？'])
})

test('flushes text without final punctuation', () => {
  const buffer = new SentenceBuffer()
  assert.deepEqual(buffer.push('嗯，我在'), [])
  assert.deepEqual(buffer.finish(), ['嗯，我在'])
})

test('bounds long unpunctuated text at a comma when possible', () => {
  const buffer = new SentenceBuffer()
  const text = `${'今天很开心'.repeat(24)}，${'我们继续聊'.repeat(24)}`
  const ready = buffer.push(text)
  assert.ok(ready.length >= 1)
  assert.equal([...ready, ...buffer.finish()].join(''), text)
})

test('a forced length boundary never splits a supplementary character pair', () => {
  const buffer = new SentenceBuffer()
  const text = '啊'.repeat(179) + '𠮷' + '再继续'.repeat(90)
  const sentences = [...buffer.push(text), ...buffer.finish()]
  assert.equal(sentences.join(''), text)
  for (const sentence of sentences)
    assert.ok(sentence.isWellFormed())
})

function collectFragments(text, chunkSize) {
  const buffer = new SentenceBuffer()
  const sentences = []
  for (let start = 0; start < text.length; start += chunkSize)
    sentences.push(...buffer.push(text.slice(start, start + chunkSize)))
  return [...sentences, ...buffer.finish()]
}

test('a complete long sentence is bounded identically for whole and split deltas', () => {
  const text = '啊'.repeat(500) + '。'
  const expected = collectFragments(text, text.length)
  assert.deepEqual(expected.map(sentence => sentence.length), [180, 180, 141])
  assert.equal(expected.join(''), text)
  for (const chunkSize of [1, 2, 17, 179, 180, 181, 200])
    assert.deepEqual(collectFragments(text, chunkSize), expected)
})

test('short completed sentences do not let later long sentences or tails bypass the bound', () => {
  const text = '先说一句。' + '甲'.repeat(181) + '！' + '乙'.repeat(400) + '？' + '丙'.repeat(400)
  const expected = collectFragments(text, text.length)
  assert.equal(expected[0], '先说一句。')
  assert.equal(expected.join(''), text)
  assert.ok(expected.every(sentence => sentence.length <= 180))
  for (const chunkSize of [1, 59, 180, 181, 400])
    assert.deepEqual(collectFragments(text, chunkSize), expected)
})

test('punctuation exactly at the limit fits, while the next unit cannot exceed it', () => {
  for (const count of [179, 180, 181]) {
    const text = '甲'.repeat(count) + '。'
    const expected = collectFragments(text, text.length)
    assert.equal(expected.join(''), text)
    assert.ok(expected.every(sentence => sentence.length <= 180))
    assert.deepEqual(expected.map(sentence => sentence.length), count === 179 ? [180] : [180, count - 179])
    assert.deepEqual(collectFragments(text, 1), expected)
  }
})

test('comma selection includes its punctuation within the limit and keeps the previous minimum', () => {
  for (const comma of ['，', ',']) {
    for (const index of [59, 60, 179, 180]) {
      const text = '甲'.repeat(index) + comma + '乙'.repeat(220) + '。'
      const expected = collectFragments(text, text.length)
      assert.equal(expected[0].length, index >= 60 && index < 180 ? index + 1 : 180)
      assert.equal(expected.join(''), text)
      assert.ok(expected.every(sentence => sentence.length <= 180))
      for (const chunkSize of [1, 179, 180, 181])
        assert.deepEqual(collectFragments(text, chunkSize), expected)
    }
    const text = '甲'.repeat(70) + comma + '乙'.repeat(69) + comma + '丙'.repeat(250) + '。'
    assert.equal(collectFragments(text, text.length)[0], text.slice(0, 141), 'the last eligible comma wins')
  }
})

test('complete long sentences keep supplementary letters intact even across delta pair splits', () => {
  for (const prefixLength of [178, 179, 180]) {
    const text = '甲'.repeat(prefixLength) + '𠮷' + '乙'.repeat(220) + '。'
    const expected = collectFragments(text, text.length)
    assert.equal(expected.join(''), text)
    assert.ok(expected.every(sentence => sentence.length <= 180 && sentence.isWellFormed()))
    for (const chunkSize of [1, 179, 180, 181])
      assert.deepEqual(collectFragments(text, chunkSize), expected)
  }
})

test('a terminal at the available end observes the next fragment without waiting for the reply', () => {
  const buffer = new SentenceBuffer()
  assert.deepEqual(buffer.push('（真的吗？'), [])
  assert.deepEqual(buffer.push('！'), [])
  assert.deepEqual(buffer.push('）'), [])
  assert.deepEqual(buffer.push('先试试。'), ['（真的吗？！）'])
  assert.deepEqual(buffer.finish(), ['先试试。'])
  assert.deepEqual(buffer.finish(), [])
})

test('compound terminals and closing marks stay with their words at every possible transport split', () => {
  const cases = [
    ['真的吗？！先试试。', ['真的吗？！', '先试试。']],
    ['(真的好吗？)先试试。', ['(真的好吗？)', '先试试。']],
    ['“真的吗？！”先试试。', ['“真的吗？！”', '先试试。']],
    ['「真的吗?!」先试试。', ['「真的吗?!」', '先试试。']],
    ['他说：「『真的吗？！』」先试试。', ['他说：「『真的吗？！』」', '先试试。']],
    ['"真的吗?!"先试试。', ['"真的吗?!"', '先试试。']],
    ["'don't worry?!'先试试。", ["'don't worry?!'", '先试试。']],
    ['你好吗？！？；先试试。', ['你好吗？！？；', '先试试。']],
  ]
  for (const [text, expected] of cases) {
    assert.deepEqual(collectFragments(text, text.length), expected)
    for (const size of [1, 2, 3, 7])
      assert.deepEqual(collectFragments(text, size), expected, `${text}: chunk ${size}`)
    for (let split = 0; split <= text.length; split++) {
      const buffer = new SentenceBuffer()
      assert.deepEqual([
        ...buffer.push(text.slice(0, split)),
        ...buffer.push(text.slice(split)),
        ...buffer.finish(),
      ], expected, `${text}: split ${split}`)
    }
  }
})

test('an opening quote of the next sentence is not stolen by the preceding ending', () => {
  for (const text of ['你好。“真的吗？！”再试试。', '你好。"真的吗?!"再试试。', "你好。'真的吗?!'再试试。"]) {
    const expected = [text.slice(0, 3), text.slice(3, -4), '再试试。']
    for (const size of [1, 2, text.length])
      assert.deepEqual(collectFragments(text, size), expected)
  }
  assert.deepEqual(collectFragments("don't worry?!'真的吗?!'再试试。", 1), ["don't worry?!", "'真的吗?!'", '再试试。'])
})

test('clear closing punctuation belongs to the preceding ending without a matching parser stack', () => {
  for (const closer of [')', ']', '}', '）', '］', '｝', '》', '〉', '」', '』', '】', '〕', '〗', '〙', '〛', '”', '’', '»', '›']) {
    const text = `好嘛？！${closer}下一句。`
    const expected = [`好嘛？！${closer}`, '下一句。']
    assert.deepEqual(collectFragments(text, 1), expected)
    assert.deepEqual(collectFragments(text, text.length), expected)
  }
})

test('terminal observation does not weaken the UTF-16 cap, including huge punctuation tails', () => {
  for (const prefix of ['甲'.repeat(178), '甲'.repeat(179), '甲'.repeat(180), '甲'.repeat(177) + '𠮷']) {
    for (const suffix of ['？！）下一句。', '?!"下一句。', '！'.repeat(400) + '）下一句。']) {
      const text = prefix + suffix
      const expected = collectFragments(text, text.length)
      assert.equal(expected.join(''), text)
      assert.ok(expected.every(sentence => sentence.length <= 180 && sentence.isWellFormed()))
      for (const size of [1, 2, 179, 180, 181])
        assert.deepEqual(collectFragments(text, size), expected)
    }
  }
})

test('an ASCII quote opened before a forced bound can close on a later sentence', () => {
  const text = '"' + '甲'.repeat(200) + '?!"下一句。'
  const expected = ['"' + '甲'.repeat(179), '甲'.repeat(21) + '?!"', '下一句。']
  for (const size of [1, 2, 180, text.length])
    assert.deepEqual(collectFragments(text, size), expected)
})

test('ellipsis remains part of the clause rather than becoming a hard sentence boundary', () => {
  const text = '嗯……我想想，先试试。'
  assert.deepEqual(collectFragments(text, 1), [text])
  assert.deepEqual(collectFragments(text, text.length), [text])
})

test('a line break submits immediately and does not borrow a closing mark from the next line', () => {
  const buffer = new SentenceBuffer()
  assert.deepEqual(buffer.push('真的吗？'), [])
  assert.deepEqual(buffer.push('！\n'), ['真的吗？！'])
  assert.deepEqual(buffer.push('）下一句。\n'), ['）下一句。'])
  assert.deepEqual(buffer.finish(), [])
  for (const text of ['第一句。\n下一句。', '真的吗？！\n）下一句。', '第一句。\r\n下一句。']) {
    const expected = collectFragments(text, text.length)
    for (const size of [1, 2, 3, 7])
      assert.deepEqual(collectFragments(text, size), expected)
  }
})
