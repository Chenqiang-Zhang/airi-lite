import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { buildVowelTable, EXTRAS, gb2312Characters, loadPinyinPro, main, parseSyllable, REGENERATE, renderVowelTable, TABLE_PATH, vowelKey } from './build-vowel-table.mjs'

const SCRIPT = fileURLToPath(new URL('./build-vowel-table.mjs', import.meta.url))

// The table is built from the locked pinyin-pro that kokoro-js installs; a
// checkout without node_modules cannot rebuild it, but still uses it.
function pinyinPro() {
  try {
    return loadPinyinPro()
  }
  catch (error) {
    if (error.code === 'PINYIN_PRO_UNAVAILABLE') return null
    throw error
  }
}

test('--check matches the committed src/vowel-table.ts', (t) => {
  if (!pinyinPro()) return t.skip('pinyin-pro is not reachable through kokoro-js')
  const result = spawnSync(process.execPath, [SCRIPT, '--check'], { encoding: 'utf8', timeout: 120_000 })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /up to date/)
})

test('--check exits 1 on a stale or missing table, and a build brings it back', (t) => {
  if (!pinyinPro()) return t.skip('pinyin-pro is not reachable through kokoro-js')
  const directory = mkdtempSync(join(tmpdir(), 'vowel-table-'))
  const tablePath = join(directory, 'vowel-table.ts')
  const errors = t.mock.method(console, 'error', () => {})
  t.mock.method(console, 'log', () => {})
  try {
    assert.equal(main(['--check'], { tablePath }), 1)
    writeFileSync(tablePath, readFileSync(TABLE_PATH, 'utf8').replace("'a': '啊", "'a': '"))
    assert.equal(main(['--check'], { tablePath }), 1)
    assert.match(errors.mock.calls.at(-1).arguments[0], /is stale; run node scripts\/build-vowel-table\.mjs/)
    assert.equal(main([], { tablePath }), 0)
    assert.equal(readFileSync(tablePath, 'utf8'), readFileSync(TABLE_PATH, 'utf8'))
    assert.equal(main(['--check'], { tablePath }), 0)
  }
  finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the table holds GB2312 L1+L2 and the extras, each character once, deterministically', (t) => {
  const pro = pinyinPro()
  if (!pro) return t.skip('pinyin-pro is not reachable through kokoro-js')
  const built = buildVowelTable(pro.pinyin)
  assert.equal(built.count, 6763 + EXTRAS.length)
  const all = Object.values(built.table).join('')
  assert.equal([...all].length, built.count)
  assert.equal(new Set(all).size, built.count)
  assert.equal(renderVowelTable(buildVowelTable(pro.pinyin), pro), renderVowelTable(built, pro))
})

test('GB2312 levels 1 and 2 decode to 6763 Han characters in GB2312 order', () => {
  const characters = gb2312Characters()
  assert.equal(characters.length, 6763)
  assert.equal(new Set(characters).size, 6763)
  assert.ok(characters.every(character => /^\p{Script=Han}$/u.test(character)))
  // Level 1 is ordered by reading and ends at 座; level 2 starts at 亍.
  assert.equal(characters[0], '啊')
  assert.equal(characters[3754], '座')
  assert.equal(characters[3755], '亍')
  for (const character of EXTRAS) assert.ok(!characters.includes(character), character)
})

test('canonical finals are re-derived from the whole syllable', () => {
  const cases = {
    // y and w spell medials that pinyin-pro's own finals drop.
    yi: 'i', yin: 'in', ying: 'ing', ya: 'ia', yao: 'iao', ye: 'ie', yan: 'ian', yang: 'iang',
    you: 'iou', yong: 'iong', yo: 'io', yu: 'ü', yue: 'üe', yuan: 'üan', yun: 'ün',
    wu: 'u', wa: 'ua', wo: 'uo', wai: 'uai', wei: 'uei', wan: 'uan', wen: 'uen', wang: 'uang', weng: 'ueng',
    // j/q/x write ü as u; n/l write it.
    ju: 'ü', que: 'üe', xuan: 'üan', jun: 'ün', lü: 'ü', nüe: 'üe', lue: 'üe', lv: 'ü',
    // bo/po/mo/fo are uo; iu/ui/un hide their nucleus.
    bo: 'uo', po: 'uo', mo: 'uo', fo: 'uo', duo: 'uo', o: 'o', lo: 'o',
    liu: 'iou', gui: 'uei', lun: 'uen',
    // The apical vowel is not the spread i.
    zhi: '-i', chi: '-i', shi: '-i', ri: '-i', zi: '-i', ci: '-i', si: '-i', di: 'i', ji: 'i',
    // Syllabic nasals.
    ng: 'ng', n: 'ng', hng: 'ng', m: 'm', hm: 'm',
    a: 'a', ai: 'ai', er: 'er', ê: 'ê', ei: 'ei', zhong: 'ong', heng: 'eng', kei: 'ei',
  }
  for (const [syllable, final] of Object.entries(cases))
    assert.equal(parseSyllable(syllable).final, final, syllable)
})

test('b, p and m initials keep the closure as a key prefix; f and the syllabic m do not', () => {
  assert.equal(vowelKey('men'), 'b:en')
  assert.equal(vowelKey('bo'), 'b:uo')
  assert.equal(vowelKey('pa'), 'b:a')
  assert.equal(vowelKey('miu'), 'b:iou')
  assert.equal(vowelKey('fo'), 'uo')
  assert.equal(vowelKey('fan'), 'an')
  assert.equal(vowelKey('m'), 'm')
  assert.equal(vowelKey('hm'), 'm')
  assert.equal(vowelKey('ma'), 'b:a')
})

test('a final without vowel keys fails the build instead of writing a blank shape', () => {
  for (const syllable of ['xyz', 'r', 'q', 'ba1'])
    assert.throws(() => parseSyllable(syllable), /no vowel keys/, syllable)
})

test('the committed table carries the pinyin-pro MIT notice and the regeneration command', () => {
  const text = readFileSync(TABLE_PATH, 'utf8')
  const header = text.slice(0, text.indexOf('export const'))
  assert.ok(header.includes(REGENERATE))
  assert.ok(header.includes('--check'))
  assert.ok(header.includes('MIT License'))
  assert.ok(header.includes('Copyright (c) 2022-present zh-lx'))
  assert.ok(header.includes('The above copyright notice and this permission notice shall be included in all'))
  assert.ok(header.includes('pinyin-pro 3.29.4'))
})
