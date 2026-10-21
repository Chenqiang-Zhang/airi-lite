import assert from 'node:assert/strict'
import test from 'node:test'

import { isPronunciationRule, matchPronunciation, MINIMAX_PRONUNCIATION, substitutedLength,
  validatePronunciationTable } from './minimax-pronunciation.mjs'

test('the shipped table is exactly the name, frozen and valid', () => {
  assert.deepEqual(MINIMAX_PRONUNCIATION, ['日和/(ri4)(he2)', 'Hiyori/(ri4)(he2)'])
  assert.ok(Object.isFrozen(MINIMAX_PRONUNCIATION))
  assert.equal(validatePronunciationTable(MINIMAX_PRONUNCIATION), MINIMAX_PRONUNCIATION)
  // The commented-out candidates are valid too, ready to enable.
  validatePronunciationTable([...MINIMAX_PRONUNCIATION, '弹幕/(dan4)(mu4)', '睡不着/(shui4)(bu5)(zhao2)',
    '卡壳/(qia3)(ke2)', '发型/(fa4)(xing2)', '吐槽/(tu3)(cao2)', '绷不住/(beng1)(bu5)(zhu4)', '很丧/(hen3)(sang4)'])
})

test('a rule is one key and one pinyin or kana respelling', () => {
  for (const rule of ['处理/(chu3)(li3)', '东京/トウキョウ', '日和/ひより', 'Hiyori/(ri4)(he2)', 'Hiyori/ひより',
    '日/(ri4)', 'a/(a1)', 'x'.repeat(16) + '/(a1)', '日和ちゃん/(ri4)(he2)(qiang1)', 'Ｈｉｙｏｒｉ/(ri4)(he2)',
    '𠀀/(a1)', 'ab/' + '(a1)'.repeat(16), '东京/' + 'ア'.repeat(16), '吗/(ma5)', '东京/トウキョー', '（笑）/(xiao4)'])
    assert.equal(isPronunciationRule(rule), true, rule)
  const refused = [
    // Not one string with exactly one '/'.
    undefined, null, 42, ['日和/(ri4)(he2)'], { toString: () => '日和/(ri4)(he2)' }, new String('日和/(ri4)(he2)'),
    '', '日和', '日和(ri4)(he2)', '日和/(ri4)/(he2)', '日/和/(ri4)', '/(ri4)', '日和/',
    // Key: length, well-formedness, whitespace, control characters, syntax.
    'x'.repeat(17) + '/(a1)', '\ud800/(a1)', '\udc00和/(a1)', '日 和/(ri4)(he2)', ' 日和/(ri4)(he2)', '日和 /(ri4)(he2)',
    '日\t和/(ri4)(he2)', '日\n和/(ri4)(he2)', '日\u3000和/(ri4)(he2)', '日\u00a0和/(ri4)(he2)', '日\u0000和/(ri4)(he2)',
    '日\u007f和/(ri4)(he2)', '日\u0085和/(ri4)(he2)', '日(和/(ri4)(he2)', '日)和/(ri4)(he2)', '[日]/(ri4)', '<日>/(ri4)',
    '#日/(ri4)', 'a]/(a1)', 'a</(a1)',
    // Pinyin: lowercase letters, a tone 1-5, half-width brackets, nothing else.
    '日/ri4', '日/(ri)', '日/(ri0)', '日/(ri6)', '日/(Ri4)', '日/(RI4)', '日/(rí4)', '日/(ri44)', '日/(r i4)', '日/( ri4)',
    '日/(ri4) ', '日/ (ri4)', '日/(ri4', '日/ri4)', '日/（ri4）', '日/[ri4]', '日/()', '日/(4)', '日/(abcdefg1)',
    '日/(ri4)x', '日/x(ri4)', '日/(ri4)(he2', '日/(ri4)，(he2)',
    // One syllable per Han character.
    '日和/(ri4)', '日和/(ri4)(he2)(he2)', '日/(ri4)(he2)', '𠀀/(a1)(a1)',
    // A non-Han key's respelling is bounded like kana.
    'ab/' + '(a1)'.repeat(17),
    // Kana: hiragana/katakana only, 1-16.
    '东京/' + 'ア'.repeat(17), '东京/トウ キョウ', '东京/东京', '东京/ｱ', '东京/トウkyou', '东京/(tou1)キョウ',
  ]
  for (const rule of refused)
    assert.equal(isPronunciationRule(rule), false, JSON.stringify(rule))
})

test('a table with a bad rule, a repeated or nested key, or too many rules fails', () => {
  const ok = Array.from({ length: 32 }, (_, index) => `k${String.fromCharCode(97 + index % 26)}${index}x/(a1)`)
  assert.equal(validatePronunciationTable(ok), ok)
  assert.deepEqual(validatePronunciationTable([]), [])
  for (const table of [
    undefined, null, '日和/(ri4)(he2)', { 0: '日和/(ri4)(he2)', length: 1 },
    [...ok, 'zz/(a1)'],
    ['日和/(ri4)(he2)', '日和 /(ri4)(he2)'],
    ['日和/(ri4)(he2)', 42],
    ['日和/(ri4)(he2)', '日和/ひより'],
    ['Hiyori/(ri4)(he2)', 'hiyori/ひより'],
    ['HIYORI/(ri4)(he2)', 'Hiyori/(ri4)(he2)'],
    ['日和/(ri4)(he2)', '日和酱/(ri4)(he2)(jiang4)'],
    ['日和酱/(ri4)(he2)(jiang4)', '日和/(ri4)(he2)'],
    ['Hiyori/(ri4)(he2)', 'yori/(yao2)(li3)'],
    ['yori/(yao2)(li3)', 'HIYORI/(ri4)(he2)'],
  ])
    assert.throws(() => validatePronunciationTable(table), JSON.stringify(table))
})

test('matching returns the rules whose key occurs, in table order, ignoring Latin case', () => {
  const table = ['弹幕/(dan4)(mu4)', '日和/(ri4)(he2)', 'Hiyori/(ri4)(he2)', '卡壳/(qia3)(ke2)']
  assert.deepEqual(matchPronunciation('你好', table), [])
  assert.deepEqual(matchPronunciation('', table), [])
  assert.deepEqual(matchPronunciation('卡壳了，弹幕好多', table), ['弹幕/(dan4)(mu4)', '卡壳/(qia3)(ke2)'])
  assert.deepEqual(matchPronunciation('Hiyori，也就是日和日和', table), ['日和/(ri4)(he2)', 'Hiyori/(ri4)(he2)'])
  for (const text of ['hiyori', 'HIYORI', 'HiYoRi酱', '我是hiYORI。'])
    assert.deepEqual(matchPronunciation(text, table), ['Hiyori/(ri4)(he2)'], text)
  // Substrings match (MiniMax's behaviour is unverified, so the rule is sent).
  assert.deepEqual(matchPronunciation('Hiyorin', table), ['Hiyori/(ri4)(he2)'])
  assert.deepEqual(matchPronunciation('日 和', table), [])
  assert.deepEqual(matchPronunciation('Hiyor i', table), [])
  // Invalid rules and repeated keys in a hand-built table are skipped.
  assert.deepEqual(matchPronunciation('日和', ['日和', '日和/(ri4)', 42, '日和/(ri4)(he2)', '日和/ひより']), ['日和/(ri4)(he2)'])
  assert.deepEqual(matchPronunciation('HIYORI', ['hiyori/ひより', 'Hiyori/(ri4)(he2)']), ['hiyori/ひより'])
  assert.deepEqual(matchPronunciation('日和', undefined), [])
  assert.deepEqual(matchPronunciation('日和', '日和/(ri4)(he2)'), [])
})

test('the substituted length counts every occurrence of each matched key', () => {
  const table = ['日和/(ri4)(he2)', 'Hiyori/ひより', '卡壳/(qia3)(ke2)']
  assert.equal(substitutedLength('你好', table), 2)
  // 日和 (2) → (ri4)(he2) (10): +8 for each of the two.
  assert.equal(substitutedLength('日和说日和', table), 5 + 2 * 8)
  assert.equal('(ri4)(he2)说(ri4)(he2)'.length, 5 + 2 * 8)
  // A shorter respelling shortens the text; Latin case is ignored.
  assert.equal(substitutedLength('我是HIYORI和hiyori', table), 15 - 2 * 3)
  assert.equal(substitutedLength('卡壳的日和', table), 5 + 9 + 8)
  assert.equal(substitutedLength('日和', []), 2)
  assert.equal(substitutedLength('日和', ['bad']), 2)
  // Occurrences do not overlap.
  assert.equal(substitutedLength('aaaa', ['aa/(a1)']), 4 + 2 * 2)
})
