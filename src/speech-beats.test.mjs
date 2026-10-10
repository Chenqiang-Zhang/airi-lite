import assert from 'node:assert/strict'
import test from 'node:test'
import { speechBeats, speechBeatAtTime, SPEECH_BEAT_COOLDOWN_SECONDS } from './speech-beats.ts'

const frame = open => ({ open, form: 0 })
function peaks(times, duration = 3) {
  const frames = Array.from({ length: Math.ceil(duration * 40) }, () => frame(0))
  for (const time of times) {
    const index = Math.round(time * 40)
    frames[index - 1] = frame(0.2)
    frames[index] = frame(0.6)
    frames[index + 1] = frame(0.3)
  }
  return frames
}
const interval = (text, start, end) => ({ text, start, end })

test('nonuniform actual character intervals pick measured peaks, never equal subdivisions or gaps', () => {
  const characters = [interval('你', .11, .37), interval('好', .91, 1.19), interval('呀', 2.03, 2.64)]
  const events = speechBeats({ characters }, peaks([.1, .25, .8, 1.05, 1.8, 2.4]), 3)
  assert.deepEqual(events.map(event => event.peak), [.25, 1.05, 2.4])
  for (const event of events) {
    const original = characters.find(character => event.peak > character.start && event.peak < character.end)
    assert.ok(original)
    assert.ok(event.start >= original.start && event.end <= original.end)
  }
  const track = [{ time: 0, duration: 3, events }]
  for (const gap of [0, .1, .37, .8, 1.19, 1.8, 2.7]) assert.equal(speechBeatAtTime(track, gap), 0)
  assert.equal(speechBeatAtTime(track, 1.05), 1)
})

test('words take precedence; words are not split into guessed character times', () => {
  const events = speechBeats({ words: [interval('hello', .12, .63)],
    characters: [interval('字', .8, 1.3)] }, peaks([.25, 1.05]), 3)
  assert.deepEqual(events.map(event => event.peak), [.25])
})

test('missing alignment is distinct from aligned punctuation, zero duration, silence and weak audio', () => {
  assert.equal(speechBeats({}, peaks([.25]), 3), null)
  assert.equal(speechBeats({ words: [] }, peaks([.25]), 3), null)
  for (const alignment of [{ characters: [] }, { characters: [interval('，', 0, 3), interval(' ', 0, 3)] },
    { words: [interval('!!!', 0, 3)] }, { characters: [interval('你', .25, .25)] }])
    assert.deepEqual(speechBeats(alignment, peaks([.25]), 3), [])
  const alignment = { characters: [interval('你', 0, 3)] }
  assert.deepEqual(speechBeats(alignment, Array.from({ length: 120 }, () => frame(0)), 3), [])
  assert.deepEqual(speechBeats(alignment, peaks([.25]).map(value => frame(value.open * .1)), 3), [])
  assert.deepEqual(speechBeats(alignment, peaks([.25]), 0), [])
})

test('factual word availability distinguishes empty provider alignment from legacy empty sentinel', () => {
  const frames = peaks([.25, 1.05])
  assert.equal(speechBeats({ words: [] }, frames, 3), null)
  assert.deepEqual(speechBeats({ words: [], wordAlignmentAvailable: true }, frames, 3), [])
  assert.deepEqual(speechBeats({ words: [interval('你', .25, .25)], wordAlignmentAvailable: true }, frames, 3), [])
  assert.deepEqual(speechBeats({ words: [], wordAlignmentAvailable: true,
    characters: [interval('字', .1, .6)] }, frames, 3).map(event => event.peak), [.25],
  'available character intervals remain preferable to empty word metadata')
  assert.deepEqual(speechBeats({ words: [interval('字', .1, .6)], wordAlignmentAvailable: true }, frames, 3)
    .map(event => event.peak), [.25])
})

test('strict peak eligibility and actual duration never borrow a peak outside partial coverage', () => {
  const frames = peaks([.25, .5, 1.05, 2.4])
  assert.deepEqual(speechBeats({ characters: [interval('字', .25, .5)] }, frames, 3), [])
  const events = speechBeats({ characters: [interval('字', .91, 1.3), interval('尾', 2.2, 3.02)] }, frames, 2.41)
  assert.deepEqual(events.map(event => event.peak), [1.05, 2.4])
  assert.equal(events.at(-1).end, 2.41)
  assert.equal(speechBeatAtTime([{ time: 0, duration: 2.41, events }], 2.41), null)
})

test('sparse cooldown remains deterministic across overlaps and frame-rate-independent media reads', () => {
  const events = speechBeats({ words: [interval('一个', 0, 3), interval('重叠', .1, 2.7)] },
    peaks([.25, .5, .8, 1.05, 1.4, 1.8, 2.4]), 3)
  assert.deepEqual(events.map(event => event.peak), [.25, 1.05, 1.8])
  for (let index = 1; index < events.length; index++)
    assert.ok(events[index].peak - events[index - 1].peak >= SPEECH_BEAT_COOLDOWN_SECONDS)
  const track = [{ time: 0, duration: 3, events }]
  for (const fps of [30, 60]) {
    for (let frame = 0; frame < fps; frame++) speechBeatAtTime(track, frame / fps)
    assert.equal(speechBeatAtTime(track, 1.05), 1)
    assert.equal(speechBeatAtTime(track, .25), 1, 'backward lookup has no consumed-event state')
  }
})

test('clip offsets preserve peak strengths for second queued segment, full replay and backward seek', () => {
  const events = speechBeats({ characters: [interval('字', .1, .63)] }, peaks([.25]), 3)
  const standalone = [{ time: 0, duration: 3, events }]
  const queued = [{ time: 0, duration: .173, events: [] }, { time: .173, duration: 3, events }]
  const replay = [{ time: 0, duration: .319, events: null }, { time: .319, duration: .173, events: [] },
    { time: .492, duration: 3, events }]
  for (const local of [.25, .3, .18, .25]) {
    const expected = speechBeatAtTime(standalone, local)
    assert.ok(Math.abs(speechBeatAtTime(queued, .173 + local) - expected) < 1e-12)
    assert.ok(Math.abs(speechBeatAtTime(replay, .492 + local) - expected) < 1e-12)
  }
  assert.equal(speechBeatAtTime(replay, .1), null)
  assert.equal(speechBeatAtTime(replay, .4), 0)
})

test('a previous clip peak constrains cooldown without changing provider timestamps', () => {
  const events = speechBeats({ characters: [interval('字', 0, 3)] }, peaks([.25, 1.05]), 3, -.1)
  assert.deepEqual(events.map(event => event.peak), [1.05])
})
