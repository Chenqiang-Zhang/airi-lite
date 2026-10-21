import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { collectMinimaxStream } from '../server/minimax.mjs'
import { ACT_PAUSE_SECONDS, isViseme, VISEMES } from '../shared/performance-cues.mjs'

import { mouthFrames } from './mouth.ts'
import { speechBeats } from './speech-beats.ts'
import { mockSpeechClip } from './stage/mock-speech.ts'
import { CLOSE_FRAMES, FINAL_KEYS, readingOf, STALE_TAIL, vowelUnits, withVowels } from './visemes.ts'
import { VOWEL_TABLE } from './vowel-table.ts'

const [A, I, U, E, O, N, M] = ['a', 'i', 'u', 'e', 'o', 'n', 'm'].map(viseme => VISEMES.indexOf(viseme))
const at = (text, start, end) => ({ text, start, end })
const closed = () => ({ open: 0, form: 0 })

// Frames closed except the [from, to) index ranges, which are open.
function envelope(count, ranges, open = 0.6) {
  const frames = Array.from({ length: count }, closed)
  for (const [from, to] of ranges) {
    for (let index = from; index < to; index++) frames[index] = { open, form: 0.1 }
  }
  return frames
}
const weights = (entries) => {
  const vowel = Array.from({ length: VISEMES.length }, () => 0)
  for (const [channel, value] of entries) vowel[channel] = value
  return vowel
}
const shape = frame => frame.vowel ? VISEMES[frame.vowel.indexOf(Math.max(...frame.vowel))] : null
const shapes = (frames, from = 0, to = frames.length) => frames.slice(from, to).map(shape)
function runs(list) {
  const out = []
  for (const value of list) {
    if (out.at(-1)?.[0] === value) out.at(-1)[1]++
    else out.push([value, 1])
  }
  return out
}
const clipDuration = clip => clip.samples.length / clip.sampleRate

// Every frame a track writes: open and form untouched, weights well formed.
function assertWellFormed(input, output) {
  assert.equal(output.length, input.length)
  assert.deepEqual(output.map(({ open, form }) => ({ open, form })), input.map(({ open, form }) => ({ open, form })))
  for (const frame of output) {
    if (!('vowel' in frame)) continue
    assert.ok(frame.open > 0, 'no vowel on a closed frame')
    assert.equal(frame.vowel.length, VISEMES.length)
    const total = frame.vowel.reduce((sum, value) => sum + value, 0)
    assert.ok(frame.vowel.every(value => value >= 0 && value <= 1))
    assert.ok(total >= 0.01 && total <= 1 + 1e-12, String(total))
  }
}

// src/stage/performance-debug.ts: LINES, ACT_LINES and the vowel test line.
const DEBUG_LINES = {
  neutral: '好的，我们来看下一个问题。',
  happy: '太好了，我超开心的！',
  soft: '没关系，慢慢来就好。',
  curious: '咦，这是怎么做到的？',
  surprised: '哇，真的假的？！',
  sad: '唉，有点可惜呢。',
  pout: '哼，才不要告诉你呢。',
  shy: '诶嘿，被你夸得有点不好意思。',
}
const DEBUG_ACT_LINES = {
  laugh: { delivery: 'happy', text: '哈哈，这也太好笑了吧！' },
  sigh: { delivery: 'sad', text: '唉，今天又没抽到。' },
  pause: { delivery: 'curious', text: '嗯，让我想想看。' },
}
const VOWEL_LINE = '啊、衣、乌、诶、哦，嗯，我们吧。'
const han = text => [...text].filter(character => /\p{Script=Han}/u.test(character))

test('readings are canonical finals, with b: for a b/p/m initial; non-Han units have none', () => {
  const expected = { 晚: 'uan', 好: 'ao', 也: 'ie', 有: 'iou', 鱼: 'ü', 月: 'üe', 我: 'uo', 为: 'uei', 天: 'ian',
    是: '-i', 嗯: 'ng', 哼: 'ng', 了: 'e', 们: 'b:en', 波: 'b:uo', 呗: 'b:ei', 嗨: 'ai', 喔: 'o' }
  for (const [character, reading] of Object.entries(expected)) assert.equal(readingOf(character), reading, character)
  for (const text of ['a', 'Hiyori', 'he', '2', '6', '，', '。', '…', '(laughs)', '日和', '', ' ', '__proto__', 'constructor'])
    assert.equal(readingOf(text), undefined, text)
})

test('the table covers GB2312 L1+L2 with each character under one key, and every key has vowel keys', () => {
  const all = Object.values(VOWEL_TABLE).join('')
  assert.ok([...all].length >= 6763)
  assert.equal(new Set(all).size, [...all].length, 'no character in two keys')
  assert.ok(Object.isFrozen(VOWEL_TABLE))
  for (const key of Object.keys(VOWEL_TABLE)) {
    const final = key.startsWith('b:') ? key.slice(2) : key
    assert.ok(Object.hasOwn(FINAL_KEYS, final), key)
    assert.ok(!(key.startsWith('b:') && ['ng', 'm'].includes(final)), key)
  }
  for (const character of '呣欸齁') assert.ok(readingOf(character), character)
})

test('every FINAL_KEYS entry uses VISEMES, starts at 0 and strictly increases below 1', () => {
  assert.ok(Object.isFrozen(FINAL_KEYS))
  for (const [final, list] of Object.entries(FINAL_KEYS)) {
    assert.ok(Object.isFrozen(list) && list.length >= 1 && list.length <= 3, final)
    assert.equal(list[0][1], 0, final)
    list.forEach(([viseme, fraction], index) => {
      assert.ok(isViseme(viseme), `${final}: ${viseme}`)
      assert.ok(fraction >= 0 && fraction < 1, final)
      if (index) assert.ok(fraction > list[index - 1][1], final)
    })
  }
  assert.deepEqual(FINAL_KEYS.iao, [['i', 0], ['a', 0.25], ['u', 0.7]])
  assert.deepEqual(FINAL_KEYS['-i'], [['n', 0]])
  assert.deepEqual(FINAL_KEYS.m, [['m', 0]])
})

test('all 62 Han characters of the debug lines, and the vowel test line, have a reading', () => {
  const lines = [...Object.values(DEBUG_LINES), ...Object.values(DEBUG_ACT_LINES).map(line => line.text)]
  const characters = new Set(han(lines.join('')))
  assert.equal(characters.size, 62)
  for (const character of [...characters, ...han(VOWEL_LINE)]) assert.ok(readingOf(character), character)
})

test('sources: no alignment or empty alignment returns the same array; words take precedence over characters', () => {
  const frames = envelope(40, [[0, 40]])
  for (const alignment of [{}, { words: [] }, { words: [], wordAlignmentAvailable: true }, { characters: [] },
    { words: [], wordAlignmentAvailable: true, characters: [] }, { characters: [at('，', 0, 1)] }])
    assert.equal(withVowels(frames, alignment, 1), frames, JSON.stringify(alignment))
  const characters = [at('啊', 0, 0.5), at('衣', 0.5, 1)]
  for (const duration of [0, -1, NaN, Infinity]) assert.equal(withVowels(frames, { characters }, duration), frames)
  assert.equal(withVowels([], { characters }, 1).length, 0)

  const words = [at('啊', 0, 0.5), at('衣', 0.5, 1)]
  const preferred = withVowels(frames, { words, characters: [at('乌', 0, 1)] }, 1)
  assert.equal(shape(preferred[10]), 'a')
  assert.equal(shape(preferred[30]), 'i')
  assert.ok(preferred.every(frame => !frame.vowel?.[U]))
  // Empty word metadata falls through to the characters, as in speechBeats.
  const fallback = withVowels(frames, { words: [], wordAlignmentAvailable: true, characters: [at('乌', 0, 1)] }, 1)
  assert.equal(shape(fallback[20]), 'u')
})

// MiniMax shape: the first word starts one grid step in, and every word is
// reported one token before it is voiced.
const LATE = [at('晚', 0.043, 0.171), at('上', 0.171, 0.4), at('好', 0.4, 0.7), at('。', 0.7, 0.9)]

test('lead check: one token late is shifted, on time is kept, ambiguous gives no track', () => {
  const late = envelope(40, [[7, 37]])
  const shifted = vowelUnits({ words: LATE, wordAlignmentAvailable: true }, late, 1)
  assert.equal(shifted.lead, 1)
  assert.deepEqual(shifted.units.map(({ text, reading, start, end }) => [text, reading, start, end]),
    [['晚', 'uan', 0.171, 0.4], ['上', 'ang', 0.4, 0.7], ['好', 'ao', 0.7, 1]])
  const lateFrames = withVowels(late, { words: LATE }, 1)
  // 晚 is u→a, voiced where 上 was reported.
  assert.equal(shape(lateFrames[8]), 'u')
  assert.equal(shape(lateFrames[13]), 'a')

  const onTime = envelope(40, [[1, 37]])
  const reported = vowelUnits({ words: LATE }, onTime, 1)
  assert.equal(reported.lead, 0)
  assert.deepEqual(reported.units.map(unit => unit.start), [0.043, 0.171, 0.4])
  assert.equal(shape(withVowels(onTime, { words: LATE }, 1)[2]), 'u')

  // Reported 2/6 voiced, shifted 4/10: neither rule holds.
  const ambiguous = Array.from({ length: 40 }, (_, index) => [5, 6, 12, 13, 14].includes(index) ? { open: 0.6, form: 0 } : closed())
  assert.equal(vowelUnits({ words: LATE }, ambiguous, 1), null)
  assert.equal(withVowels(ambiguous, { words: LATE }, 1), ambiguous)
  // A first word with no token after it cannot show a shift.
  assert.equal(vowelUnits({ words: [at('啊', 0.043, 0.171)] }, late, 1), null)
})

test('lead check: an on-time first word with a soft onset keeps its timings', () => {
  // 我 reported over frames 10-15 with the voice rising from frame 12 (4 of 6
  // voiced), 们 fully voiced: on time, so no shift, although the next word
  // is more voiced than the first.
  const words = [at('我', 0.25, 0.4), at('们', 0.4, 0.6), at('好', 0.6, 0.9)]
  const frames = envelope(40, [[12, 36]])
  const track = vowelUnits({ words }, frames, 1)
  assert.equal(track.lead, 0)
  assert.deepEqual(track.units.map(unit => [unit.text, unit.start]), [['我', 0.25], ['们', 0.4], ['好', 0.6]])
})

test('lead check: a (laughs) first word still shifts, and the laugh carries no shape', () => {
  const words = [at('(laughs)', 0.043, 0.256), at('这', 0.256, 1.067), at('啊', 1.067, 1.4), at('。', 1.4, 1.6)]
  // The laugh sounds in 这's reported interval, 这 in 啊's, 啊 in 。's.
  const frames = envelope(72, [[12, 40], [43, 61]])
  const track = vowelUnits({ words }, frames, 1.8)
  assert.equal(track.lead, 1)
  assert.deepEqual(track.units.map(unit => [unit.text, unit.reading]), [['(laughs)', undefined], ['这', 'e'], ['啊', 'a']])
  const output = withVowels(frames, { words }, 1.8)
  assert.ok(output.slice(0, 42).every(frame => !frame.vowel))
  assert.equal(shape(output[47]), 'e')
  assert.equal(shape(output[58]), 'a')
})

test('lead check: character alignment is used as reported, never shifted or dropped', () => {
  for (const frames of [envelope(40, [[7, 37]]), envelope(40, [[1, 37]])]) {
    const track = vowelUnits({ characters: LATE }, frames, 1)
    assert.equal(track.lead, 0)
    assert.deepEqual(track.units.map(unit => unit.start), [0.043, 0.171, 0.4])
  }
})

test('stale tail: more than a second of audio after the last word gives no track', () => {
  const words = [at('你', 0.025, 0.3), at('好', 0.3, 0.8)]
  const long = envelope(80, [[1, 32]])
  assert.equal(withVowels(long, { words }, 0.8 + STALE_TAIL + 0.2), long)
  const healthy = envelope(52, [[1, 32]])
  const output = withVowels(healthy, { words }, 1.3)
  assert.notEqual(output, healthy)
  assert.ok(output.some(frame => frame.vowel))
  // Characters (Eleven, the mock) have no such snapshot problem.
  assert.notEqual(withVowels(long, { characters: words }, 2), long)
})

test('stale tail on real speech-2.8 streams: the cumulative capture is flagged, a healthy one is not', async () => {
  const load = async (name, textLength) => {
    const raw = readFileSync(new URL(`../server/fixtures/${name}.sse`, import.meta.url), 'utf8')
    const result = await collectMinimaxStream(new Response(raw).body, { textLength })
    return { ...result, duration: Number(/"audio_length":(\d+)/.exec(raw)[1]) / 1000 }
  }
  const stale = await load('minimax-2.8-cumulative', 13)
  assert.ok(stale.duration - stale.words.at(-1).end > STALE_TAIL)
  const voiced = duration => envelope(Math.ceil(duration * 40), [[0, Math.ceil(duration * 40)]])
  const frames = voiced(stale.duration)
  assert.equal(vowelUnits(stale, frames, stale.duration), null)
  assert.equal(withVowels(frames, stale, stale.duration), frames)

  const healthy = await load('minimax-2.8-happy-short', 11)
  assert.ok(healthy.duration - healthy.words.at(-1).end < STALE_TAIL)
  assert.ok(vowelUnits(healthy, voiced(healthy.duration), healthy.duration))
})

test('spans: a pause after punctuation folds into the character before it and is gated to nothing', () => {
  const characters = [at('好', 0.1, 0.3), at('，', 0.3, 0.35), at('的', 0.8, 1)]
  const frames = envelope(44, [[4, 12], [32, 40]])
  const track = vowelUnits({ characters }, frames, 1.1)
  assert.deepEqual(track.units.map(unit => [unit.start, unit.end]), [[0.1, 0.8], [0.8, 1.1]])
  const output = withVowels(frames, { characters }, 1.1)
  assert.ok(output.slice(4, 12).every(frame => frame.vowel))
  assert.ok(output.slice(12, 32).every(frame => !frame.vowel))
  assert.equal(shape(output[34]), 'e')

  // Shifted MiniMax words: the pause is reported inside 的, voiced after 好.
  const words = [at('好', 0.043, 0.171), at('，', 0.171, 0.214), at('的', 0.214, 1), at('。', 1, 1.2)]
  const late = envelope(52, [[7, 12], [40, 46]])
  const shifted = vowelUnits({ words }, late, 1.3)
  assert.equal(shifted.lead, 1)
  assert.deepEqual(shifted.units.map(unit => [unit.text, unit.start, unit.end]), [['好', 0.171, 1], ['的', 1, 1.3]])
  const lateOutput = withVowels(late, { words }, 1.3)
  assert.deepEqual(runs(shapes(lateOutput, 7, 12)), [['a', 2], ['u', 3]])
  assert.ok(lateOutput.slice(12, 40).every(frame => !frame.vowel))
  assert.equal(shape(lateOutput[42]), 'e')
})

test('spans: blank units carry nothing and stop their neighbours', () => {
  // A dictionary name comes back as five identical units.
  const words = [at('是', 0.025, 0.2), ...[0.2, 0.3, 0.4, 0.45, 0.55].map((start, index, list) =>
    at('Hiyori', start, list[index + 1] ?? 0.6)), at('。', 0.6, 0.8)]
  const frames = envelope(36, [[1, 32]])
  const output = withVowels(frames, { words }, 0.9)
  assert.ok(output.slice(1, 7).every(frame => shape(frame) === 'n'))
  assert.ok(output.slice(8).every(frame => !frame.vowel))

  for (const blank of ['la', '2', '(laughs)', '日和']) {
    const characters = [at('你', 0, 0.2), at(blank, 0.2, 0.5), at('啊', 0.5, 0.7)]
    const voiced = envelope(28, [[0, 28]])
    const result = withVowels(voiced, { characters }, 0.7)
    assert.ok(result.slice(0, 7).every(frame => shape(frame) === 'i'), blank)
    assert.ok(result.slice(8, 18).every(frame => !frame.vowel), blank)
    // Only the next shape's lead and blur reach into the blank.
    assert.deepEqual(result[18].vowel, weights([[A, 0.25]]))
    assert.deepEqual(result[19].vowel, weights([[A, 0.75]]))
    assert.ok(result.slice(20, 27).every(frame => shape(frame) === 'a'), blank)
  }
})

test('layout: iao runs i→a→u over the voiced frames only, and a short hull keeps only the nucleus', () => {
  const characters = [at('聊', 0, 1)]
  const frames = envelope(40, [[10, 30]])
  const output = withVowels(frames, { characters }, 1)
  assert.deepEqual(runs(shapes(output)), [[null, 10], ['i', 4], ['a', 9], ['u', 7], [null, 10]])

  const short = withVowels(envelope(40, [[10, 12]]), { characters }, 1)
  assert.deepEqual(short[10].vowel, weights([[A, 0.75]]))
  assert.deepEqual(short[11].vowel, weights([[A, 0.25]]))
  assert.ok(short.every(frame => !frame.vowel?.[I] && !frame.vowel?.[U]))
  // uo keeps o, its longer key.
  assert.equal(shape(withVowels(envelope(10, [[4, 5]]), { characters: [at('我', 0, 0.25)] }, 0.25)[4]), 'o')
})

test('layout: shapes lead by one frame and blur by exactly [1/4, 1/2, 1/4]', () => {
  const characters = [at('啊', 0, 0.5), at('衣', 0.5, 1)]
  const output = withVowels(envelope(40, [[0, 40]]), { characters }, 1)
  const expected = Array.from({ length: 40 }, (_, index) =>
    index < 18 ? weights([[A, 1]])
      : index === 18 ? weights([[A, 0.75], [I, 0.25]])
        : index === 19 ? weights([[A, 0.25], [I, 0.75]])
          : index < 38 ? weights([[I, 1]])
            : index === 38 ? weights([[I, 0.75]]) : weights([[I, 0.25]]))
  assert.deepEqual(output.map(frame => frame.vowel), expected)
})

test('layout: the gate fades weights with the opening and leaves closed or faint frames without a vowel', () => {
  const characters = [at('啊', 0, 0.5), at('衣', 0.5, 1)]
  const frames = envelope(40, [[0, 40]])
  for (const index of [25, 26, 27]) frames[index] = { open: 0.075, form: 0.05 }
  frames[30] = { open: 0.001, form: 0 }
  frames[33] = closed()
  const output = withVowels(frames, { characters }, 1)
  assertWellFormed(frames, output)
  assert.ok(Math.abs(output[26].vowel[I] - 0.5) < 1e-12)
  assert.ok(!('vowel' in output[30]), 'below the minimum weight')
  assert.ok(!('vowel' in output[33]), 'closed')
  assert.equal(output[20].vowel[I], 1)
})

test('closure: two hard m frames at the lowest opening around a b/p/m onset', () => {
  const characters = [at('我', 0, 0.25), at('们', 0.25, 0.6)]
  const closures = output => output.flatMap((frame, index) => frame.vowel?.[M] ? [index] : [])
  for (const [dip, open, expected] of [[11, 0.3, 11], [9, 0.3, 9], [10, 0.05, 10]]) {
    const frames = envelope(24, [[0, 24]])
    frames[dip] = { open, form: 0 }
    const output = withVowels(frames, { characters }, 0.6)
    assertWellFormed(frames, output)
    assert.deepEqual(closures(output), Array.from({ length: CLOSE_FRAMES }, (_, offset) => expected + offset))
    // Hard: no lead, blur or gate, even on the faint dip.
    for (const index of closures(output)) assert.deepEqual(output[index].vowel, weights([[M, 1]]))
    assert.equal(shape(output[expected + CLOSE_FRAMES + 1]), 'e')
  }
  // A silent frame before the onset stays without a vowel; the voiced one closes.
  const silentOnset = withVowels(envelope(24, [[5, 21]]), { characters: [at('们', 0, 0.6)] }, 0.6)
  assert.ok(!silentOnset[4].vowel)
  assert.deepEqual(silentOnset[5].vowel, weights([[M, 1]]))
  assert.equal(shape(silentOnset[6]), 'e')
})

test('closure: only on hulls of four frames or more, and never for f or the syllabic m', () => {
  const characters = [at('们', 0, 0.25)]
  const short = withVowels(envelope(10, [[4, 7]]), { characters }, 0.25)
  assert.ok(short.every(frame => !frame.vowel?.[M]))
  assert.ok(short.some(frame => shape(frame) === 'e'))
  const four = withVowels(envelope(10, [[4, 8]]), { characters }, 0.25)
  assert.ok(four.some(frame => frame.vowel?.[M] === 1))
  // 发 fa has no closure; 呣 m is the m shape over its whole hull, blurred.
  assert.ok(withVowels(envelope(10, [[2, 9]]), { characters: [at('发', 0, 0.25)] }, 0.25).every(frame => !frame.vowel?.[M]))
  const hum = withVowels(envelope(10, [[2, 9]]), { characters: [at('呣', 0, 0.25)] }, 0.25)
  assert.deepEqual(runs(shapes(hum)), [[null, 2], ['m', 7], [null, 1]])
})

test('invariants: open and form are copied unchanged, the length is kept and the input is not touched', () => {
  for (const [text, act] of [[DEBUG_LINES.neutral], [VOWEL_LINE], [DEBUG_ACT_LINES.laugh.text, 'laugh']]) {
    const clip = mockSpeechClip({ text, delivery: 'neutral', ...(act ? { act } : {}) })
    const frames = mouthFrames(clip.samples, clip.sampleRate)
    const copy = structuredClone(frames)
    const output = withVowels(frames, clip, clipDuration(clip))
    assert.notEqual(output, frames)
    assertWellFormed(frames, output)
    assert.deepEqual(frames, copy)
    // speechBeats reads only open: beats are identical with the track.
    assert.deepEqual(speechBeats(clip, output, clipDuration(clip)), speechBeats(clip, frames, clipDuration(clip)))
  }
})

test('a pause shifts the track by exactly 16 frames at 24, 32, 44.1 and 48 kHz', () => {
  const delay = (items, seconds) => items.map(item => ({ ...item, start: item.start + seconds, end: item.end + seconds }))
  for (const sampleRate of [24_000, 32_000, 44_100, 48_000]) {
    const clip = mockSpeechClip({ text: VOWEL_LINE, delivery: 'neutral' }, { sampleRate })
    const pause = Math.round(ACT_PAUSE_SECONDS * sampleRate)
    const padded = new Float32Array(pause + clip.samples.length)
    padded.set(clip.samples, pause)
    for (const key of ['characters', 'words']) {
      const alignment = { [key]: clip.characters }
      const base = withVowels(mouthFrames(clip.samples, sampleRate), alignment, clipDuration(clip))
      const shifted = withVowels(mouthFrames(padded, sampleRate), { [key]: delay(clip.characters, pause / sampleRate) },
        padded.length / sampleRate)
      assert.ok(base.some(frame => frame.vowel), `${sampleRate} ${key}`)
      assert.equal(shifted.length, base.length + 16, `${sampleRate} ${key}`)
      assert.ok(shifted.slice(0, 16).every(frame => !frame.vowel))
      assert.deepEqual(shifted.slice(16), base, `${sampleRate} ${key}`)
    }
  }
})

test('mock: every aligned debug line covers 90% of its voiced frames, and the unaligned mock has no track', () => {
  const sentences = [...Object.entries(DEBUG_LINES).map(([delivery, text]) => ({ text, delivery })),
    ...Object.entries(DEBUG_ACT_LINES).map(([act, line]) => ({ ...line, act })),
    { text: VOWEL_LINE, delivery: 'neutral' }]
  for (const sentence of sentences) {
    const clip = mockSpeechClip(sentence)
    const frames = mouthFrames(clip.samples, clip.sampleRate)
    const output = withVowels(frames, clip, clipDuration(clip))
    assertWellFormed(frames, output)
    const first = Math.round(clip.characters.find(character => /\p{L}/u.test(character.text)).start * 40)
    const voiced = output.slice(first).filter(frame => frame.open >= 0.08)
    assert.ok(voiced.filter(frame => frame.vowel).length >= 0.9 * voiced.length, sentence.text)
    // The laugh and sigh before the first character carry no shape.
    assert.ok(output.slice(0, Math.max(0, first - 2)).every(frame => !frame.vowel), sentence.text)

    const unaligned = mockSpeechClip(sentence, { aligned: false })
    const plain = mouthFrames(unaligned.samples, unaligned.sampleRate)
    assert.equal(withVowels(plain, unaligned, clipDuration(unaligned)), plain)
  }

  const clip = mockSpeechClip({ text: VOWEL_LINE, delivery: 'neutral' })
  const output = withVowels(mouthFrames(clip.samples, clip.sampleRate), clip, clipDuration(clip))
  const during = character => {
    const { start, end } = clip.characters.find(each => each.text === character)
    return shapes(output, Math.round(start * 40), Math.round(end * 40)).filter(Boolean)
  }
  for (const [character, viseme] of [['啊', 'a'], ['衣', 'i'], ['乌', 'u'], ['哦', 'o'], ['嗯', 'n']]) {
    const list = during(character)
    assert.ok(list.length >= 5 && list.every(each => each === viseme), `${character}: ${list.join('')}`)
  }
  assert.ok(during('们').includes('m'))
  assert.equal(during('诶')[0], 'e')
  assert.equal(during('诶').at(-1), 'i')
})
