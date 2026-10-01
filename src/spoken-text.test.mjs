import assert from 'node:assert/strict'
import test from 'node:test'

import { cleanSpokenText, hasSpokenContent, SpokenTextFilter } from './spoken-text.ts'

function filter(chunks) {
  const parser = new SpokenTextFilter()
  return chunks.map(chunk => parser.push(chunk)).join('') + parser.finish()
}

function everySplit(input, expected) {
  assert.equal(filter([input]), expected, 'whole reply')
  assert.equal(filter([...input]), expected, 'one code point per delta')
  assert.equal(filter(input.split('')), expected, 'one UTF-16 code unit per delta')
  for (let split = 0; split <= input.length; split++) {
    assert.equal(filter([input.slice(0, split), input.slice(split)]), expected, `split at ${split}`)
  }
}

test('ordinary prose reaches the sentence buffer before the reply finishes', () => {
  const parser = new SpokenTextFilter()
  assert.equal(parser.push('嗯，今天挺开心。'), '嗯，今天挺开心。')
  assert.equal(parser.push('下一句也一样！'), '下一句也一样！')
  assert.equal(parser.finish(), '')
})

test('fenced code and language names never leak, including each delimiter character', () => {
  everySplit('这段可以复制。\n```python\nprint("私密代码")\n```\n就这样。', '这段可以复制。\n\n就这样。')
  everySplit('先说一句。\n   ~~~~js\n不朗读这里\n   ~~~~  \n后面还在。', '先说一句。\n\n后面还在。')
})

test('a fence needs the same marker and at least the opening run length', () => {
  everySplit('````\n~~~\n```\n代码仍不能读\n`````\n可以继续。', '\n可以继续。')
  everySplit('~~~\n ```\n隐藏\n~~~ trailing\n还是隐藏\n~~~\n读这里。', '\n读这里。')
  everySplit('```\n``` `\n还是隐藏\n```\n读这里。', '\n读这里。')
})

test('unterminated code stays silent even at finish', () => {
  everySplit('说完了。\n```js\n秘密代码', '说完了。\n')
  everySplit('```', '')
  everySplit('~~~lang', '')
})

test('fences only start at a line prefix with at most three spaces', () => {
  everySplit('    ```\n正文\n    ```', '    \n正文\n    ')
  everySplit('字面里的 ```name``` 仍是短标识。', '字面里的 name 仍是短标识。')
})

test('CRLF fences do not leak a delimiter, info string, or content', () => {
  everySplit('之前。\r\n```js\r\n代码\r\n```\r\n之后。', '之前。\r\n\n之后。')
})

test('quoted fences close in the same quote container without swallowing later prose', () => {
  everySplit('> ```js\n> 隐藏代码\n> ```\n正文。', '\n正文。')
  everySplit('> > ~~~\n> > 隐藏代码\n> > ~~~\n> 可以读。\n```\n隐藏\n```\n最后。', '\n可以读。\n\n最后。')
})

test('links read only their labels, including nested URL parentheses and relative destinations', () => {
  everySplit('可以看[这份说明](https://example.com/a_(b)?q=(x))，再看[更新](/docs/new)。', '可以看这份说明，再看更新。')
  everySplit('[**日和**](/personas "别读标题 (也别读)")在这里。', '日和在这里。')
  everySplit('[A\\]B](../a\\)b)好了。', 'A]B好了。')
  everySplit('[资料](https://example.com/it\'s_(new))后面。', '资料后面。')
})

test('images never read the alt text, destination, or title', () => {
  everySplit('看一下。![非常长的 alt](assets/image_(one).png "标题")继续说。', '看一下。继续说。')
  everySplit('![不完整的图片描述', '')
  everySplit('![不完整图片](', '')
  everySplit('![不读\\*alt\\*和\\]符号](./a.png)可以读。', '可以读。')
})

test('reference link/image identifiers are silent, including unfinished references', () => {
  everySplit('看[说明][docs-id]和[首页][]。', '看说明和首页。')
  everySplit('![不读 alt][image-id]继续。', '继续。')
  everySplit('[说明][private-destination', '说明')
  everySplit('[说明][escaped\\]reference]继续。', '说明继续。')
})

test('unfinished destinations remain suppressed; unfinished labels retain only their label', () => {
  everySplit('去[首页](https://private.invalid/token', '去首页')
  everySplit('去[首页]', '去首页')
  everySplit('去[首页', '去首页')
  everySplit('去[首页]？', '去首页？')
})

test('labels stream immediately, including sentences before the closing bracket', () => {
  const parser = new SpokenTextFilter()
  assert.equal(parser.push('[很好。'), '很好。')
  assert.equal(parser.push('下一句](http'), '下一句')
  assert.equal(parser.push('s://private.invalid/secret'), '')
  assert.equal(parser.finish(), '')
})

test('long labels stream rather than accumulating and images stay silent at the same size', () => {
  const label = '资料'.repeat(20_000)
  const parser = new SpokenTextFilter()
  const first = parser.push(`[${label}`)
  assert.equal(first, label)
  assert.equal(first + parser.push('](https://example.invalid/hidden)好了。') + parser.finish(), `${label}好了。`)
  assert.equal(filter([`![${label}`, '](./image.png)']), '')
})

test('huge destinations and fenced lines have constant retained string state', () => {
  const parser = new SpokenTextFilter()
  assert.equal(parser.push('[说明]('), '说明')
  assert.equal(parser.push('secret'.repeat(100_000)), '')
  assert.ok(JSON.stringify(parser).length < 1000)
  assert.equal(parser.push(')结束。') + parser.finish(), '结束。')

  const fenced = new SpokenTextFilter()
  assert.equal(fenced.push('```\n'), '')
  assert.equal(fenced.push('secret'.repeat(100_000)), '')
  assert.ok(JSON.stringify(fenced).length < 1000)
  assert.equal(fenced.push('\n```\n正文。') + fenced.finish(), '\n正文。')
})

test('bare HTTP(S) addresses are replaced once, preserving surrounding punctuation', () => {
  everySplit('去 https://example.com/a?q=1&next=(two)。好。', '去 网址。好。')
  everySplit('地址是HTTP://example.com/x, 下一句。', '地址是网址, 下一句。')
  everySplit('(https://example.com/a_(b))。', '(网址)。')
  everySplit('https://[::1]:3000/a. https://example.org', '网址. 网址')
})

test('an unfinished scheme is plain text, not a URL destination', () => {
  everySplit('http 谈好了。', 'http 谈好了。')
  everySplit('HTTPS:/', 'HTTPS:/')
  everySplit('hello there。', 'hello there。')
  everySplit('Ahoy, http2 协议。', 'Ahoy, http2 协议。')
})

test('a huge URL emits one replacement and retains only bounded punctuation', () => {
  const parser = new SpokenTextFilter()
  assert.equal(parser.push('https://'), '网址')
  assert.equal(parser.push('hidden'.repeat(100_000)), '')
  assert.equal(parser.push('?'.repeat(100_000)), '')
  assert.ok(JSON.stringify(parser).length < 1000)
  assert.equal(parser.push('。继续。'), '?'.repeat(16) + '。继续。')
})

test('line prefixes lose only common heading, quote, and list decoration', () => {
  everySplit('# 标题\n> 引用\n- 第一项\n+ 第二项\n* 第三项\n1. 第四项\n12) 第五项', '标题\n引用\n第一项\n第二项\n第三项\n第四项\n第五项')
  everySplit('### 标题\n> > - 引用里的列表\n2026年。\n#tag\n-5 度', '标题\n引用里的列表\n2026年。\n#tag\n-5 度')
})

test('short inline identifiers survive formatting, including single-character deltas', () => {
  everySplit('用 **Python**，再看 _这个_ 和 `snake_case`。', '用 Python，再看 这个 和 snake_case。')
  everySplit('普通的 snake_case 和 __强调__。', '普通的 snake_case 和 强调。')
  everySplit('用 ``带`反引号`` 标识。', '用 带反引号 标识。')
  everySplit('用 `https://example.com` 做示例。', '用 网址 做示例。')
  everySplit('用 `https://example.com`。\n```\n隐藏代码\n```\n后面。', '用 网址。\n\n后面。')
})

test('escaped inline markers are literal; escaped brackets do not open a link', () => {
  everySplit('\\*不是强调\\*，\\[不是链接\\]。', '*不是强调*，[不是链接]。')
})

test('emoji-only, whitespace, and punctuation do not count as readable body', () => {
  for (const text of ['🙂🥲✨', '……？！---', '\n  ', '1️⃣#️⃣*️⃣', '🇯🇵👩‍💻', 'ℹ️'])
    assert.equal(hasSpokenContent(filter(text.split(''))), false, text)
  for (const text of ['嗯。', 'OK!', '42', 'snake_case'])
    assert.equal(hasSpokenContent(filter(text.split(''))), true, text)
})

test('sentence-level cleaning removes emoji sequences without dropping real numbers or prose', () => {
  assert.equal(cleanSpokenText(filter('嗨😊！'.split(''))), '嗨！')
  assert.equal(cleanSpokenText(filter('今天🇯🇵，家人👨‍👩‍👧‍👦也开心。'.split(''))), '今天，家人也开心。')
  assert.equal(cleanSpokenText(filter('先做1️⃣，实际有12个步骤。👍🏽'.split(''))), '先做，实际有12个步骤。')
  assert.equal(cleanSpokenText(filter('  👩‍💻ℹ️1️⃣#️⃣*️⃣  '.split(''))), '')
  assert.equal(cleanSpokenText('数字 1、2、3。'), '数字 1、2、3。')
})

test('emoji components are removed before any output reaches a bounded sentence buffer', () => {
  everySplit('😊'.repeat(89) + '1️⃣', '')
  everySplit('啊'.repeat(179) + '😊', '啊'.repeat(179))
  everySplit('正文👨‍👩‍👧‍👦🇯🇵👍🏽，保留12个。', '正文，保留12个。')
})

test('the incremental keycap candidate survives a push/tone boundary without leaking a digit', () => {
  const parser = new SpokenTextFilter()
  assert.equal(parser.push('嗨1'), '嗨')
  assert.equal(parser.push('\uFE0F'), '')
  assert.equal(parser.push('\u20E3😊'), '')
  assert.equal(parser.push('，现在有12个。'), '，现在有12个。')
  assert.equal(parser.finish(), '')
})

test('real digits and literal symbols finish normally without changing Markdown lookbehind', () => {
  everySplit('编号1_2，地址 https://example.com/x1。', '编号1_2，地址 网址。')
  everySplit('最后是42', '最后是42')
  everySplit('\\#不是标题', '#不是标题')
  everySplit('\\*不是强调\\*', '*不是强调*')
  const parser = new SpokenTextFilter()
  assert.equal(parser.push('正文1'), '正文')
  assert.equal(parser.finish(), '1')
  assert.equal(parser.finish(), '')
})

test('incremental cleaning retains only one keycap candidate even for huge emoji replies', () => {
  const parser = new SpokenTextFilter()
  assert.equal(parser.push('😊'.repeat(100_000) + '1'), '')
  assert.ok(JSON.stringify(parser).length < 1000)
  assert.equal(parser.push('\uFE0F'), '')
  assert.ok(JSON.stringify(parser).length < 1000)
  assert.equal(parser.push('\u20E3'), '')
  assert.equal(parser.finish(), '')
})

test('a boundary drains a real held digit before outputting the following character', () => {
  const parser = new SpokenTextFilter()
  const boundaries = []
  assert.equal(parser.push('实际有42'), '实际有4')
  parser.atSentenceBoundary(text => boundaries.push(text))
  assert.deepEqual(boundaries, [])
  assert.equal(parser.push('个步骤。'), '个步骤。')
  assert.deepEqual(boundaries, ['2'])
  assert.equal(parser.finish(), '')
})

test('a boundary waits for a keycap, discarding its base before the following prose', () => {
  const parser = new SpokenTextFilter()
  const boundaries = []
  assert.equal(parser.push('嗨1'), '嗨')
  parser.atSentenceBoundary(text => boundaries.push(text))
  assert.equal(parser.push('\uFE0F'), '')
  assert.deepEqual(boundaries, [])
  assert.equal(parser.push('\u20E3后面。'), '后面。')
  assert.deepEqual(boundaries, [''])
})

test('repeated boundaries on one candidate retain only the newest callback', () => {
  const parser = new SpokenTextFilter()
  const boundaries = []
  parser.push('数1')
  for (let index = 0; index < 10_000; index++)
    parser.atSentenceBoundary(text => boundaries.push([index, text]))
  assert.ok(JSON.stringify(parser).length < 1000)
  assert.equal(parser.push('个。'), '个。')
  assert.deepEqual(boundaries, [[9_999, '1']])
})

test('finish drains the pending boundary once, including a numeric line prefix', () => {
  for (const text of ['42', '实际有42', '实际有42\uFE0F']) {
    const parser = new SpokenTextFilter()
    const boundaries = []
    const emitted = parser.push(text)
    parser.atSentenceBoundary(tail => boundaries.push(tail))
    assert.equal(parser.finish(), '')
    assert.equal(emitted + boundaries.join(''), text.replace('\uFE0F', ''))
    assert.equal(boundaries.length, 1)
    assert.equal(parser.finish(), '')
  }
})

test('cancel discards a pending boundary without emitting or invoking its callback', () => {
  const parser = new SpokenTextFilter()
  parser.push('实际有42')
  parser.atSentenceBoundary(() => assert.fail('canceled boundary cannot run'))
  parser.cancel()
  assert.equal(parser.finish(), '')
  assert.equal(parser.push('个步骤。'), '')
  parser.atSentenceBoundary(() => assert.fail('canceled parser cannot run a new boundary'))
})

test('finish is idempotent and post-finish pushes cannot create more speech', () => {
  const parser = new SpokenTextFilter()
  assert.equal(parser.push('正文。\n```\n未闭合代码'), '正文。\n')
  assert.equal(parser.finish(), '')
  assert.equal(parser.finish(), '')
  assert.equal(parser.push('```\n不应再输出'), '')
})
