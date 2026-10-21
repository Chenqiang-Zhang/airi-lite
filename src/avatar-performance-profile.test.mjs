import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { EMOTIONS } from '../shared/performance-cues.mjs'
import { SNAPSHOT_GRID, settlePose, snapshotCases, snapshotPoses } from '../scripts/avatar-performance-snapshot.mjs'
import { attachAvatarPerformance } from './avatar-performance.ts'
import { FALLBACK_AVATAR_PROFILE, parseAvatarProfile, pulseEnvelope, smoothstep } from './avatar-profile.ts'

const FRAME = 1000 / 30
const activeJson = () => JSON.parse(readFileSync(new URL('./avatar-profiles/active.json', import.meta.url), 'utf8'))
const HIYORI = parseAvatarProfile(activeJson()).profile
const clamp = (value, [minimum, maximum]) => Math.max(minimum, Math.min(maximum, value))
const eyes = open => ({ ParamEyeLOpen: open, ParamEyeROpen: open })

// active.json as the pre-P3 code saw Hiyori: no speaking layer, acts or
// gestures, the four newer tones borrowing a face again, and happy and the
// mouth range as they were before the stronger faces of 2026-10-21.
function legacyView() {
  const json = activeJson()
  delete json.speaking
  json.acts = {}
  json.motions = structuredClone(FALLBACK_AVATAR_PROFILE.motions)
  json.mouth = structuredClone(FALLBACK_AVATAR_PROFILE.mouth)
  for (const emotion of ['happy', 'surprised', 'sad', 'pout', 'shy']) json.expressions[emotion] = structuredClone(FALLBACK_AVATAR_PROFILE.expressions[emotion])
  const { profile, problems } = parseAvatarProfile(json)
  assert.deepEqual(problems, [])
  return profile
}

// Like the unit-test fixture (Cubism restores the motion baseline before
// each frame, no clamping), plus an optional pre-physics hook and a log of
// which pass wrote what.
function rig({ profile = HIYORI, reduced = false, prePhysics = false, port, random } = {}) {
  let time = 0
  let phase = 'face'
  let pre = null
  let afterPre = null
  const state = { reduced }
  const values = new Map()
  const writes = []
  const model = new EventEmitter()
  model.coreModel = {
    getParameterValueById: id => values.get(id) ?? 0,
    setParameterValueById: (id, value, weight = 1) => {
      writes.push({ phase, id })
      values.set(id, (values.get(id) ?? 0) * (1 - weight) + value * weight)
    },
    addParameterValueById: (id, value) => {
      writes.push({ phase, id })
      values.set(id, (values.get(id) ?? 0) + value)
    },
  }
  const actor = attachAvatarPerformance(model, {
    profile,
    now: () => time,
    reducedMotion: () => state.reduced,
    motions: port,
    random,
    prePhysics: prePhysics ? listener => {
      pre = listener
      return () => { pre = null }
    } : undefined,
  })
  const frame = (milliseconds = FRAME, baseline = {}, { skipPre = false } = {}) => {
    time += milliseconds
    values.clear()
    writes.length = 0
    for (const [id, value] of Object.entries(baseline)) values.set(id, value)
    if (pre && !skipPre) {
      phase = 'pre'
      pre()
      afterPre = Object.fromEntries(values)
    }
    phase = 'face'
    model.emit('beforeModelUpdate')
    return Object.fromEntries(values)
  }
  return { actor, frame, model, writes, state, afterPre: () => afterPre, now: () => time, hooked: () => pre !== null }
}

function fakePort() {
  const port = {
    calls: [],
    isBusy: false,
    busy: () => port.isBusy,
    play(group, index, force) {
      port.calls.push([group, index, force])
      return Promise.resolve(true)
    },
    failed: () => false,
    current: () => null,
    stop() { port.calls.push(['stop']) },
    count: group => ({ Idle: 3, Flick: 1, FlickDown: 1, Tap: 1, 'Tap@Body': 1, 'Flick@Body': 1 })[group] ?? 0,
  }
  return port
}

test('the fallback and Hiyori\'s legacy view settle to the pre-P3 snapshot within 1e-12, with the same keys', () => {
  const snapshot = JSON.parse(readFileSync(new URL('./avatar-performance.snapshot.json', import.meta.url), 'utf8'))
  assert.deepEqual(snapshot.grid, structuredClone(SNAPSHOT_GRID), 'the snapshot was made from this case grid')
  const expected = snapshotPoses(snapshot)
  assert.equal(expected.length, 7200)
  for (const [name, profile] of [['fallback', FALLBACK_AVATAR_PROFILE], ['hiyori legacy', legacyView()]]) {
    let index = 0
    let worst = 0
    for (const testCase of snapshotCases()) {
      const pose = settlePose(attachAvatarPerformance, testCase, { profile })
      const want = expected[index++]
      assert.equal(Object.keys(pose).sort().join(), Object.keys(want).sort().join(), `${name} ${JSON.stringify(testCase)} keys`)
      for (const key of Object.keys(want)) worst = Math.max(worst, Math.abs(pose[key] - want[key]))
    }
    assert.ok(worst <= 1e-12, `${name}: worst difference ${worst}`)
  }
})

test('Hiyori wears 8 distinct faces, the ones changed by P3 exactly as their JSON says', () => {
  const baseline = {
    ParamMouthOpenY: 0.4, ParamMouthForm: -1, ParamCheek: -0.2, ParamEyeLSmile: 0.3, ParamEyeRSmile: 0.3,
    ParamBrowLForm: 0.2, ParamBrowRForm: 0.2, ...eyes(1), ParamAngleX: 2, ParamAngleY: -3, ParamAngleZ: 1, ParamEyeBallX: 0.1, ParamEyeBallY: -0.1,
  }
  const settled = tone => {
    const { actor, frame } = rig()
    actor.setDelivery(tone)
    for (let index = 0; index < 20; index++) frame(50, baseline)
    return frame(50, baseline)
  }
  const faces = Object.fromEntries(EMOTIONS.map(emotion => [emotion, settled(emotion)]))
  assert.equal(new Set(Object.values(faces).map(face => JSON.stringify(face))).size, 8)
  assert.deepEqual(settled('bright'), faces.happy)
  assert.deepEqual(settled('invented'), faces.neutral)
  for (const emotion of ['happy', 'surprised', 'sad', 'pout', 'shy']) {
    const expression = HIYORI.expressions[emotion]
    const expected = { ...baseline, ParamMouthOpenY: 0 }
    for (const [id, value] of Object.entries(expression.add ?? {})) expected[id] += value
    for (const [id, value] of Object.entries(expression.scale ?? {})) expected[id] *= value
    for (const [id, [target, strength]] of Object.entries(expression.blend ?? {})) expected[id] = expected[id] * (1 - strength) + target * strength
    expected.ParamMouthForm = clamp(expression.mouthForm ?? 0, HIYORI.mouth.formRange)
    assert.deepEqual(Object.keys(faces[emotion]).sort(), Object.keys(expected).sort(), emotion)
    for (const [id, value] of Object.entries(expected))
      assert.ok(Math.abs(faces[emotion][id] - value) < 1e-12, `${emotion} ${id}: ${faces[emotion][id]} vs ${value}`)
  }
})

test('faces ease by smoothstep: half at +150 ms and all at +300 ms, at 30 and 60 fps', () => {
  for (const milliseconds of [1000 / 30, 1000 / 60]) {
    const { actor, frame, now } = rig()
    frame(milliseconds)
    actor.setDelivery('happy')
    frame(milliseconds)
    const start = now()
    assert.equal(actor.inspect().weights.happy, 0, 'the ease starts at the frame that sees the request')
    let crossed = false
    while (now() - start < 400) {
      frame(milliseconds)
      const elapsed = now() - start
      const { happy, neutral } = actor.inspect().weights
      assert.ok(Math.abs(happy - smoothstep(elapsed / 300)) < 1e-9, `${milliseconds} ms frames, +${elapsed}`)
      assert.ok(Math.abs(happy + neutral - 1) < 1e-12)
      if (Math.abs(elapsed - 150) < 1e-6) assert.ok(Math.abs(happy - 0.5) < 1e-9)
      if (happy > 0.5 && !crossed) {
        crossed = true
        assert.ok(elapsed >= 150 && elapsed < 150 + milliseconds)
      }
      if (elapsed > 300 + 1e-6) assert.equal(happy, 1)
    }
  }
})

test('neutral relaxes over 1000 ms only once speech has died down; mid-reply it eases in 300 ms', () => {
  const neutralAt = (rigged, start) => {
    const samples = []
    while (rigged.now() - start < 1100) {
      rigged.frame()
      samples.push([rigged.now() - start, rigged.actor.inspect().weights.neutral])
    }
    return samples
  }
  const speaking = rig()
  speaking.actor.setActivity('speaking')
  speaking.actor.setMouth(0.5, 0)
  speaking.actor.setDelivery('happy')
  for (let index = 0; index < 30; index++) speaking.frame()
  speaking.actor.setDelivery('neutral')
  speaking.frame()
  for (const [elapsed, weight] of neutralAt(speaking, speaking.now()))
    assert.ok(Math.abs(weight - smoothstep(elapsed / 300)) < 1e-9, `mid-reply +${elapsed}`)

  // Just after the voice stops the speaking weight is still high: same 300 ms.
  const pausing = rig()
  pausing.actor.setActivity('speaking')
  pausing.actor.setDelivery('happy')
  for (let index = 0; index < 30; index++) pausing.frame()
  pausing.actor.setActivity('thinking')
  pausing.actor.setDelivery('neutral')
  pausing.frame()
  assert.ok(pausing.actor.inspect().activityWeights.speaking >= 0.5)
  for (const [elapsed, weight] of neutralAt(pausing, pausing.now()))
    assert.ok(Math.abs(weight - smoothstep(elapsed / 300)) < 1e-9)

  const released = rig()
  released.actor.setActivity('speaking')
  released.actor.setDelivery('happy')
  for (let index = 0; index < 30; index++) released.frame()
  released.actor.setActivity('idle')
  for (let index = 0; index < 45; index++) released.frame()
  assert.ok(released.actor.inspect().activityWeights.speaking < 0.01)
  released.actor.setDelivery('neutral')
  released.frame()
  const samples = neutralAt(released, released.now())
  for (const [elapsed, weight] of samples)
    assert.ok(Math.abs(weight - smoothstep(elapsed / 1000)) < 1e-9, `release +${elapsed}`)
  assert.equal(samples.at(-1)[1], 1)
})

test('asking for A, then B, then A between two frames does not restart the ease', () => {
  const { actor, frame, now } = rig()
  frame()
  actor.setDelivery('happy')
  frame()
  const start = now()
  frame()
  frame()
  actor.setDelivery('soft')
  actor.setDelivery('happy')
  frame()
  assert.equal(actor.inspect().target, 'happy')
  assert.ok(Math.abs(actor.inspect().weights.happy - smoothstep((now() - start) / 300)) < 1e-9)
  // The fallback's borrowed faces: soft, sad and shy are one face, so no ease.
  const fallback = rig({ profile: FALLBACK_AVATAR_PROFILE })
  fallback.actor.setDelivery('sad')
  for (let index = 0; index < 5; index++) fallback.frame()
  const before = fallback.actor.inspect().weights.soft
  fallback.actor.setDelivery('shy')
  fallback.frame()
  assert.equal(fallback.actor.inspect().target, 'soft')
  assert.ok(fallback.actor.inspect().weights.soft > before)
})

test('laugh, sigh and pause pulses rise, hold and release within their timings', () => {
  // Each act moves one parameter linearly in its envelope.
  const probes = {
    laugh: { baseline: { ParamEyeLSmile: 0 }, envelope: pose => pose.ParamEyeLSmile / (0.85 * 0.9) },
    sigh: { baseline: eyes(1), envelope: pose => (1 - pose.ParamEyeLOpen) / 0.25 },
    pause: { baseline: { ParamEyeBallX: 0 }, envelope: pose => pose.ParamEyeBallX / 0.35 },
  }
  for (const [act, probe] of Object.entries(probes)) {
    const pulse = HIYORI.acts[act]
    const total = pulse.attackMs + pulse.holdMs + pulse.releaseMs
    const { actor, frame, now } = rig()
    frame(FRAME, probe.baseline)
    actor.performAct(act)
    const start = now()
    let peak = 0
    while (now() - start < total + 200) {
      const pose = frame(1000 / 60, probe.baseline)
      const age = now() - start
      const envelope = probe.envelope(pose)
      peak = Math.max(peak, envelope)
      assert.ok(Math.abs(envelope - pulseEnvelope(age, pulse)) < 1e-9, `${act} +${age}`)
      if (age >= pulse.attackMs && age < pulse.attackMs + pulse.holdMs) assert.ok(Math.abs(envelope - 1) < 1e-9)
      if (age >= total) {
        assert.ok(Math.abs(envelope) < 1e-12)
        assert.equal(actor.inspect().act, null)
      }
    }
    assert.ok(Math.abs(peak - 1) < 1e-9)
  }
})

test('the laugh shake is bounded and grows with the mouth opening', () => {
  const shake = opening => {
    const { actor, frame } = rig()
    actor.setActivity('speaking')
    actor.setMouth(opening, 0)
    frame()
    actor.performAct('laugh')
    let largest = 0
    for (let index = 0; index < 60; index++) largest = Math.max(largest, Math.abs(frame(1000 / 60).ParamBodyAngleY ?? 0))
    return largest
  }
  const closed = shake(0)
  const open = shake(0.6)
  assert.ok(closed > 0.3, 'some shake even between syllables')
  assert.ok(open > closed * 2, `${open} vs ${closed}`)
  assert.ok(open <= 1.5 + 1e-12)
})

test('under reduced motion an act keeps its face but drops head and body ops and the shake', () => {
  const { actor, frame } = rig({ reduced: true })
  frame()
  actor.performAct('laugh')
  let pose
  for (let index = 0; index < 9; index++) pose = frame(FRAME, { ParamEyeLSmile: 0 })
  assert.ok(Math.abs(pose.ParamEyeLSmile - 0.85 * 0.9) < 1e-9)
  assert.ok(Math.abs(pose.ParamMouthForm - 0.25) < 1e-9)
  for (const id of ['ParamAngleZ', 'ParamAngleY', 'ParamBodyAngleY']) assert.equal(pose[id], undefined, id)
})

test('clearReaction ends a pulse, an unknown act gives none, and the same act within 700 ms is one act', () => {
  const { actor, frame } = rig()
  frame()
  actor.performAct('sigh')
  assert.ok(frame(200, eyes(1)).ParamEyeLOpen < 1)
  actor.clearReaction()
  assert.equal(frame(FRAME, eyes(1)).ParamEyeLOpen, 1)
  assert.equal(actor.inspect().act, null)
  actor.performAct('giggle')
  frame()
  assert.equal(actor.inspect().act, null)
  const fallback = rig({ profile: FALLBACK_AVATAR_PROFILE })
  fallback.actor.performAct('laugh')
  assert.equal(fallback.frame(100, { ParamEyeLSmile: 0 }).ParamEyeLSmile, 0, 'the fallback has no acts')

  const again = rig()
  again.frame()
  again.actor.performAct('laugh')
  again.frame(300)
  again.actor.performAct('laugh')
  again.frame(100)
  assert.equal(again.actor.inspect().act.ageMs, 400, 'a cue 300 ms later is ignored')
  again.frame(400)
  again.actor.performAct('laugh')
  again.frame(16)
  assert.equal(again.actor.inspect().act.ageMs, 16, '800 ms later it is a new laugh')
})

test('body sway follows the voice level, is bounded, and stills within 3 s of silence', () => {
  const run = opening => {
    const rigged = rig()
    rigged.actor.setActivity('speaking')
    rigged.actor.setMouth(opening, 0)
    const poses = []
    for (let index = 0; index < 90; index++) {
      poses.push(rigged.frame())
      const { sway, envelope } = rigged.actor.inspect()
      assert.equal(poses.at(-1).ParamBodyAngleX, sway.ParamBodyAngleX)
      assert.ok(Math.abs(sway.ParamBodyAngleX) <= 1.2 * envelope.level + 1e-12)
      assert.ok(Math.abs(sway.ParamBodyAngleZ) <= 0.9 * envelope.level + 1e-12)
    }
    return { rigged, poses }
  }
  const loud = run(0.6)
  const quiet = run(0.25)
  assert.ok(loud.poses.some(pose => Math.abs(pose.ParamBodyAngleX) > 0.5))
  for (let index = 70; index < 90; index++) {
    // Settled: level 1 at 0.6 (full at 0.5), 0.5 at 0.25.
    assert.ok(Math.abs(quiet.poses[index].ParamBodyAngleX - loud.poses[index].ParamBodyAngleX * 0.5) < 1e-6)
    assert.ok(Math.abs(quiet.poses[index].ParamBodyAngleZ - loud.poses[index].ParamBodyAngleZ * 0.5) < 1e-6)
  }
  loud.rigged.actor.setMouth(0, 0)
  let pose
  for (let index = 0; index < 90; index++) pose = loud.rigged.frame()
  assert.ok(Math.abs(pose.ParamBodyAngleX ?? 0) < 1e-3)
  assert.equal(pose.ParamBodyAngleX, undefined, 'fully still: no write at all')
  assert.equal(loud.rigged.actor.inspect().envelope.level, 0)
})

test('head drift runs only while speaking and never touches the aligned-beat pitch', () => {
  const idle = rig()
  for (let index = 0; index < 90; index++) {
    const pose = idle.frame()
    assert.equal(pose.ParamAngleX, 0)
    assert.equal(pose.ParamAngleZ, 0)
  }
  const { actor, frame } = rig()
  actor.setActivity('speaking')
  let moved = 0
  for (let index = 0; index < 90; index++) {
    const beat = [0, 0.2, 0.7, 1, 0.4][index % 5]
    actor.setMouth(0.6, 0, beat)
    const pose = frame(FRAME, { ParamAngleY: 0 })
    assert.equal(pose.ParamAngleY, beat ? -beat * 0.9 : 0)
    moved = Math.max(moved, Math.abs(pose.ParamAngleX))
    assert.ok(Math.abs(pose.ParamAngleX) <= 1.5 + 1e-12)
  }
  assert.ok(moved > 0.5, `drift moved AngleX by ${moved}`)
})

test('reduced motion and the fallback profile have no sway or drift', () => {
  const reduced = rig({ reduced: true })
  reduced.actor.setActivity('speaking')
  reduced.actor.setMouth(0.6, 0)
  for (let index = 0; index < 60; index++) {
    const pose = reduced.frame()
    for (const id of ['ParamBodyAngleX', 'ParamBodyAngleZ', 'ParamAngleX', 'ParamAngleZ']) assert.equal(pose[id], undefined, id)
    assert.equal(pose.ParamMouthOpenY, 0.6)
  }
  const fallback = rig({ profile: FALLBACK_AVATAR_PROFILE })
  fallback.actor.setActivity('speaking')
  fallback.actor.setMouth(0.6, 0)
  for (let index = 0; index < 60; index++) {
    const pose = fallback.frame()
    assert.equal(pose.ParamBodyAngleX, undefined)
    assert.equal(pose.ParamAngleX, 0)
    assert.equal(pose.ParamAngleZ, 0)
  }
})

test('with the pre-physics hook, pose writes on physics inputs happen before physics and face writes after; one listener', () => {
  const hooked = rig({ prePhysics: true })
  const plain = rig()
  assert.ok(hooked.hooked())
  assert.equal(hooked.model.listenerCount('beforeModelUpdate'), 1)
  assert.equal(plain.model.listenerCount('beforeModelUpdate'), 1)
  for (const { actor } of [hooked, plain]) {
    actor.setActivity('speaking')
    actor.setMouth(0.6, 0.1)
    actor.setDelivery('pout')
  }
  const baseline = { ...eyes(1), ParamEyeLSmile: 0.5, ParamBrowLForm: 0.2 }
  for (let index = 0; index < 40; index++)
    assert.deepEqual(hooked.frame(FRAME, baseline), plain.frame(FRAME, baseline), 'the same pose either way')
  const pre = new Set(hooked.writes.filter(write => write.phase === 'pre').map(write => write.id))
  const face = new Set(hooked.writes.filter(write => write.phase === 'face').map(write => write.id))
  for (const id of pre) assert.ok(HIYORI.parameters.prePhysics.includes(id), `${id} written before physics`)
  for (const id of ['ParamBodyAngleX', 'ParamBodyAngleZ', 'ParamAngleX', 'ParamAngleZ']) assert.ok(pre.has(id), id)
  for (const id of ['ParamBodyAngleX', 'ParamBodyAngleZ']) assert.ok(!face.has(id), id)
  for (const id of ['ParamMouthOpenY', 'ParamMouthForm', 'ParamEyeLSmile', 'ParamBrowLForm', 'ParamEyeLOpen', 'ParamEyeBallX']) assert.ok(face.has(id) && !pre.has(id), id)
  const { sway, drift } = hooked.actor.inspect()
  const afterPre = hooked.afterPre()
  assert.equal(afterPre.ParamBodyAngleX, sway.ParamBodyAngleX)
  assert.ok(Math.abs(afterPre.ParamAngleZ - (-4 + drift.ParamAngleZ)) < 1e-12, 'pout tilt and drift are in before physics')
  const last = hooked.frame(FRAME, baseline)
  assert.equal(last.ParamAngleZ, hooked.afterPre().ParamAngleZ, 'later writes add nothing to AngleZ while speaking')
  assert.ok(plain.writes.every(write => write.phase === 'face'))
  // A frame whose hook never fired still gets its pose, after physics.
  plain.frame(FRAME, baseline)
  assert.deepEqual(hooked.frame(FRAME, baseline, { skipPre: true }), plain.frame(FRAME, baseline))
  assert.equal(hooked.actor.inspect().prePhysics, true)
  hooked.actor.destroy()
  assert.equal(hooked.model.listenerCount('beforeModelUpdate'), 0)
  assert.equal(hooked.hooked(), false)
})

test('the blink guard holds open eyes through a strong syllable, from the beat or only its lookahead', () => {
  for (const [beat, ahead] of [[0.3, 0.3], [0, 0.4], [0.4, null]]) {
    const { actor, frame } = rig()
    actor.setActivity('speaking')
    actor.setMouth(0.6, 0, beat, ahead)
    for (let index = 0; index < 5; index++) assert.equal(frame(FRAME, eyes(1)).ParamEyeLOpen, 1)
    for (let index = 0; index < 4; index++) {
      const pose = frame(FRAME, eyes(0))
      assert.ok(pose.ParamEyeLOpen >= 0.95 && pose.ParamEyeROpen >= 0.95, `${beat}/${ahead}: ${pose.ParamEyeLOpen}`)
    }
  }
  // Unaligned audio: an onset emphasis strong enough counts too.
  const onset = rig()
  onset.actor.setActivity('speaking')
  onset.actor.setMouth(0, 0)
  onset.frame(FRAME, eyes(1))
  onset.actor.setMouth(0.5, 0)
  for (let index = 0; index < 5; index++) onset.frame(FRAME, eyes(1))
  assert.ok(onset.frame(FRAME, eyes(0)).ParamEyeLOpen >= 0.95)
})

test('the blink guard leaves half-closed lids alone, never lowers, and releases within about 160 ms', () => {
  const lids = rig()
  lids.actor.setActivity('speaking')
  lids.actor.setMouth(0.6, 0, 0.5, 0.5)
  for (let index = 0; index < 10; index++) assert.equal(lids.frame(FRAME, eyes(0.8)).ParamEyeLOpen, 0.8)
  for (let index = 0; index < 4; index++) assert.equal(lids.frame(FRAME, eyes(0.2)).ParamEyeLOpen, 0.2, 'not engaged at onset, not engaged later')

  const { actor, frame } = rig()
  actor.setActivity('speaking')
  actor.setMouth(0.6, 0, 0.5, 0.5)
  for (let index = 0; index < 6; index++) frame(FRAME, eyes(1))
  for (const open of [1.2, 1.05, 0.999]) assert.ok(frame(FRAME, eyes(open)).ParamEyeLOpen >= open)
  assert.equal(frame(FRAME, eyes(1.2)).ParamEyeLOpen, 1.2)
  actor.setMouth(0.6, 0, 0, 0)
  let pose
  for (let index = 0; index < 5; index++) pose = frame(FRAME, eyes(0))
  assert.ok(pose.ParamEyeLOpen < 0.4, `${pose.ParamEyeLOpen} after 167 ms`)
  for (let index = 0; index < 20; index++) pose = frame(FRAME, eyes(0))
  assert.equal(pose.ParamEyeLOpen, 0)
  assert.equal(actor.inspect().blink.hold, 0)
})

test('sad\'s narrower eyes still apply over the blink floor; browser speech and silence never guard', () => {
  const sad = rig()
  sad.actor.setActivity('speaking')
  sad.actor.setDelivery('sad')
  sad.actor.setMouth(0.6, 0, 0, 0)
  for (let index = 0; index < 15; index++) sad.frame(FRAME, eyes(1))
  sad.actor.setMouth(0.6, 0, 0.5, 0.5)
  for (let index = 0; index < 6; index++) assert.ok(Math.abs(sad.frame(FRAME, eyes(1)).ParamEyeLOpen - 0.85) < 1e-12)
  const held = sad.frame(FRAME, eyes(0)).ParamEyeLOpen
  assert.ok(held >= 0.8 && held <= 0.85, String(held))

  for (const mouth of [[null, 0, null, null], 'silent']) {
    const { actor, frame } = rig()
    if (mouth === 'silent') actor.setActivity('idle')
    else {
      actor.setActivity('speaking')
      actor.setMouth(...mouth)
    }
    for (let index = 0; index < 5; index++) frame(FRAME, eyes(1))
    for (let index = 0; index < 5; index++) assert.equal(frame(FRAME, eyes(0)).ParamEyeLOpen, 0)
  }
  const fallback = rig({ profile: FALLBACK_AVATAR_PROFILE })
  fallback.actor.setActivity('speaking')
  fallback.actor.setMouth(0.6, 0, 1, 1)
  for (let index = 0; index < 5; index++) fallback.frame(FRAME, eyes(1))
  assert.equal(fallback.frame(FRAME, eyes(0)).ParamEyeLOpen, 0)
})

test('lip sync stays exact under a motion that opens the mouth and pulls its form', () => {
  const motion = { ParamMouthOpenY: 1, ParamMouthForm: -2 }
  for (const [tone, form, bias] of [['neutral', 0.2, 0], ['happy', 0.2, HIYORI.expressions.happy.mouthForm], ['sad', 0.2, -0.4], ['pout', -0.32, -0.5]]) {
    const { actor, frame } = rig()
    actor.setActivity('speaking')
    actor.setDelivery(tone)
    actor.setMouth(0.7, form)
    let pose
    for (let index = 0; index < 20; index++) pose = frame(50, motion)
    assert.equal(pose.ParamMouthOpenY, 0.7)
    assert.ok(Math.abs(pose.ParamMouthForm - clamp(form + bias, HIYORI.mouth.formRange)) < 1e-12, `${tone}: ${pose.ParamMouthForm}`)
    actor.setActivity('idle')
    pose = frame(16, motion)
    assert.equal(pose.ParamMouthOpenY, 0)
    assert.ok(Math.abs(pose.ParamMouthForm - bias) < 1e-12)
  }
})

test('gestures go through the motion port: one offer per tone per turn, never while busy or under reduced motion', async () => {
  const port = fakePort()
  const { actor, state } = rig({ port, random: () => 0 })
  actor.beginTurn()
  actor.cueTone('happy')
  actor.cueTone('happy')
  actor.cueTone('bright')
  await Promise.resolve()
  assert.deepEqual(port.calls, [['Flick', 0, false]])
  assert.equal(actor.inspect().motion.lastTone, 'happy')

  const busy = fakePort()
  busy.isBusy = true
  const waiting = rig({ port: busy, random: () => 0 })
  waiting.actor.cueTone('surprised')
  waiting.actor.performAct('laugh')
  assert.equal(await waiting.actor.tap(), false)
  assert.deepEqual(busy.calls, [])
  assert.deepEqual(waiting.actor.inspect().motion.decisions.map(decision => decision.code), ['busy', 'busy', 'busy'])
  busy.isBusy = false
  assert.equal(await waiting.actor.tap(), true)
  assert.deepEqual(busy.calls, [['Tap', 0, false]])

  const calm = fakePort()
  const reduced = rig({ port: calm, random: () => 0, reduced: true })
  reduced.actor.cueTone('shy')
  reduced.actor.performAct('laugh')
  assert.equal(await reduced.actor.playMotion('Idle', 1), false)
  assert.deepEqual(calm.calls, [])
  assert.equal(await reduced.actor.playMotion('Idle', 1, { force: true }), true)
  assert.deepEqual(calm.calls, [['Idle', 1, true]])

  state.reduced = false
  actor.setActivity('speaking')
  assert.equal(actor.idleIndex('Idle', 3), 0, 'Idle is weighted while she speaks')
  actor.setDebug({ ignoreGates: true })
  assert.equal(actor.inspect().motion.ignoreGates, true)
})

test('without a motion port, gestures resolve false; debug hold and reduced-motion simulation work', async () => {
  const { actor, frame } = rig()
  assert.equal(await actor.tap(), false)
  assert.equal(await actor.playMotion('Idle', 0, { force: true }), false)
  assert.equal(actor.idleIndex('Idle', 3), null)
  actor.beginTurn()
  actor.cueTone('happy')
  assert.equal(actor.inspect().motion, null)

  actor.setDelivery('happy')
  actor.setDebug({ hold: 'sad' })
  for (let index = 0; index < 15; index++) frame()
  assert.equal(actor.inspect().target, 'sad')
  assert.equal(actor.inspect().requested, 'happy')
  assert.equal(actor.inspect().weights.sad, 1)
  actor.setDebug({ hold: null })
  frame()
  assert.equal(actor.inspect().target, 'happy')

  actor.setActivity('attentive')
  for (let index = 0; index < 15; index++) frame()
  actor.setDebug({ reducedMotion: true })
  assert.equal(frame().ParamAngleY, undefined)
  assert.equal(actor.inspect().reducedMotion, true)
  actor.setDebug({ reducedMotion: null })
  assert.ok(frame().ParamAngleY > 1)
  const info = actor.inspect()
  assert.deepEqual(info.profile, { id: 'hiyori', name: HIYORI.name })
  assert.equal(info.prePhysics, false)
  assert.equal(info.activity, 'attentive')
})

test('under reduced motion the blink guard still holds the eyes for an unaligned voice', () => {
  const { actor, frame } = rig({ reduced: true })
  actor.setActivity('speaking')
  actor.setMouth(0, 0)
  frame(FRAME, eyes(1))
  actor.setMouth(0.5, 0)
  for (let index = 0; index < 5; index++) frame(FRAME, eyes(1))
  assert.ok(frame(FRAME, eyes(0)).ParamEyeLOpen >= 0.95, 'the guard is not a head motion')
})
