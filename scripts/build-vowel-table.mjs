// Builds src/vowel-table.ts: the canonical pinyin final of every GB2312
// level 1 and 2 character (plus a few interjections), for the vowel lip sync
// in src/visemes.ts. An offline dev tool: it reads the lockfile-pinned
// pinyin-pro that kokoro-js already installs, so neither the app nor the
// server gains a dependency and the browser ships no dictionary.
//
//   node scripts/build-vowel-table.mjs           write src/vowel-table.ts
//   node scripts/build-vowel-table.mjs --check   exit 1 if it is stale
//
// It never touches the network; with pinyin-pro unreachable it exits 2.

import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
export const TABLE_PATH = join(ROOT, 'src', 'vowel-table.ts')
const KOKORO_PACKAGE = join(ROOT, 'node_modules', '@uzen', 'kokoro-js', 'package.json')
export const REGENERATE = 'node scripts/build-vowel-table.mjs'

// 齁 is the only reply-corpus character outside GB2312 L1+L2; 呣 and 欸 are
// interjections the persona may write.
export const EXTRAS = '呣欸齁'
// Where pinyin-pro's first single-character reading is wrong for speech:
// 哼 is the hum, not heng; 欸 the "ei?" particle; 呣 the syllabic m.
// Readings pinyin-pro gets wrong for how a streamer speaks: sentence-final
// 呗 is bei (pinyin-pro: bai), the greeting 嗨 is hai (hei), the interjection
// 喔 is o (wo).
export const OVERRIDES = Object.freeze({ 哼: 'hng', 欸: 'ei', 呣: 'm', 呗: 'bei', 嗨: 'hai', 喔: 'o' })
// Every final src/visemes.ts has keys for (its FINAL_KEYS). Anything else is
// a parsing gap, so the build fails instead of writing a blank shape.
export const FINALS = Object.freeze(['a', 'an', 'ang', 'ai', 'ao', 'o', 'uo', 'ou', 'ong',
  'e', 'en', 'eng', 'er', 'ê', 'ie', 'üe', 'üan', 'ei', 'i', 'in', 'ing', '-i', 'u', 'ü', 'ün',
  'ia', 'iang', 'iao', 'iou', 'ian', 'iong', 'io', 'ua', 'uan', 'uang', 'uai', 'uei', 'uen', 'ueng',
  'ng', 'm'])
const FINAL_SET = new Set(FINALS)
// The lip closure that b/p/m start with is kept as a key prefix.
export const BILABIAL_PREFIX = 'b:'

// GB2312 rows 16-55 are level 1 (3755) and 56-87 level 2 (3008). The WHATWG
// gbk decoder is a superset; its private-use fill-ins at the end of row 55
// are not Han and drop out.
export function gb2312Characters() {
  const decoder = new TextDecoder('gbk')
  const characters = []
  for (let row = 16; row <= 87; row++) {
    for (let cell = 1; cell <= 94; cell++) {
      const text = decoder.decode(new Uint8Array([0xA0 + row, 0xA0 + cell]))
      if (text.length === 1 && /\p{Script=Han}/u.test(text))
        characters.push(text)
    }
  }
  return characters
}

const Y_FINALS = Object.freeze({ ou: 'iou', ong: 'iong' })

// pinyin-pro's own finals lose the y/w medials (也 e, 我 o, 鱼 u) and the
// hidden nuclei of iu/ui/un, and do not mark the apical vowel, so the final
// is re-derived from the whole toneless syllable.
export function parseSyllable(syllable) {
  const text = String(syllable).toLowerCase().replace(/u:|v/g, 'ü')
  if (/^(?:ng|n|hng)$/.test(text))
    return { bilabial: false, final: 'ng' }
  if (/^h?m$/.test(text))
    return { bilabial: false, final: 'm' }
  const [, initial = '', rest] = /^(zh|ch|sh|[bpmfdtnlgkhjqxrzcsyw])?(.*)$/.exec(text)
  let final = rest
  if (initial === 'y')
    final = rest.startsWith('i') ? rest : rest.startsWith('u') ? `ü${rest.slice(1)}` : Y_FINALS[rest] ?? `i${rest}`
  else if (initial === 'w')
    final = rest === 'u' ? 'u' : `u${rest}`
  else if (/^[jqx]$/.test(initial) && rest.startsWith('u'))
    final = `ü${rest.slice(1)}`
  else if (/^[nl]$/.test(initial) && rest === 'ue')
    final = 'üe'
  else if (/^[bpmf]$/.test(initial) && rest === 'o')
    final = 'uo'
  else if (/^(?:zh|ch|sh|r|z|c|s)$/.test(initial) && rest === 'i')
    final = '-i'
  else if (rest === 'iu')
    final = 'iou'
  else if (rest === 'ui')
    final = 'uei'
  else if (rest === 'un')
    final = 'uen'
  if (!FINAL_SET.has(final))
    throw new Error(`${syllable}: no vowel keys for the final "${final}"`)
  return { bilabial: /^[bpm]$/.test(initial), final }
}

export function vowelKey(syllable) {
  const { bilabial, final } = parseSyllable(syllable)
  return bilabial ? `${BILABIAL_PREFIX}${final}` : final
}

// Through kokoro-js's own resolution: pinyin-pro is not a direct dependency,
// and a bare import from this repo fails under pnpm.
export function loadPinyinPro() {
  let require, manifest
  try {
    require = createRequire(realpathSync(KOKORO_PACKAGE))
    manifest = require.resolve('pinyin-pro/package.json')
  }
  catch (cause) {
    const error = new Error('pinyin-pro is not reachable through @uzen/kokoro-js; install the locked dependencies first (this script never downloads anything)', { cause })
    error.code = 'PINYIN_PRO_UNAVAILABLE'
    throw error
  }
  const { pinyin } = require('pinyin-pro')
  const { version } = JSON.parse(readFileSync(manifest, 'utf8'))
  const license = readFileSync(join(dirname(manifest), 'LICENSE'), 'utf8').trim()
  return { pinyin, version, license }
}

// The first single-character reading, so 了 is le (pinyin-pro reads 了 alone
// as liao). Context readings are left out on purpose: they would need a word
// list for about 0.4% of syllables.
export function readingOf(pinyin, character) {
  if (Object.hasOwn(OVERRIDES, character))
    return OVERRIDES[character]
  const reading = pinyin(character, { multiple: true, type: 'array', toneType: 'none' })[0]
  if (typeof reading !== 'string' || !/^[a-zêü]+$/.test(reading))
    throw new Error(`${character}: pinyin-pro has no reading`)
  return reading
}

export function buildVowelTable(pinyin) {
  const characters = gb2312Characters()
  if (characters.length !== 6763)
    throw new Error(`GB2312 L1+L2 decoded to ${characters.length} characters, not 6763`)
  const groups = new Map()
  const seen = new Set()
  for (const character of [...characters, ...EXTRAS]) {
    if (seen.has(character))
      continue
    seen.add(character)
    const key = vowelKey(readingOf(pinyin, character))
    groups.set(key, (groups.get(key) ?? '') + character)
  }
  const table = Object.fromEntries([...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
  return { table, count: seen.size }
}

export function renderVowelTable({ table, count }, { version, license }) {
  const lines = [
    `// Generated by scripts/build-vowel-table.mjs from pinyin-pro ${version}; do not edit.`,
    `// Regenerate: ${REGENERATE}   (--check exits 1 when this file is stale)`,
    '//',
    '// Key: the canonical pinyin final, with b: in front when the syllable starts',
    `// with b, p or m (a lip closure). Value: every character read that way, ${count}`,
    `// in all: GB2312 levels 1 and 2 plus ${EXTRAS}, by the first single-character`,
    `// reading, with ${Object.entries(OVERRIDES).map(([character, reading]) => `${character} ${reading}`).join(', ')}.`,
    '//',
    '// The readings come from pinyin-pro (https://github.com/zh-lx/pinyin-pro):',
    '//',
    ...license.split(/\r?\n/).map(line => line ? `// ${line}` : '//'),
    '',
    'export const VOWEL_TABLE: Readonly<Record<string, string>> = Object.freeze({',
    ...Object.entries(table).map(([key, characters]) => `  '${key}': '${characters}',`),
    '})',
    '',
  ]
  return lines.join('\n')
}

export function main(argv, { tablePath = TABLE_PATH } = {}) {
  const check = argv.includes('--check')
  let pinyinPro
  try {
    pinyinPro = loadPinyinPro()
  }
  catch (error) {
    console.error(error.message)
    return 2
  }
  const text = renderVowelTable(buildVowelTable(pinyinPro.pinyin), pinyinPro)
  if (check) {
    let current = null
    try {
      current = readFileSync(tablePath, 'utf8')
    }
    catch {}
    if (current !== text) {
      console.error(`${relative(ROOT, tablePath)} is stale; run ${REGENERATE}`)
      return 1
    }
    console.log(`${relative(ROOT, tablePath)} is up to date`)
    return 0
  }
  writeFileSync(tablePath, text)
  console.log(`wrote ${relative(ROOT, tablePath)} (${Buffer.byteLength(text)} bytes)`)
  return 0
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2))
