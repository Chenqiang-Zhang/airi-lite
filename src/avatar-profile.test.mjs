import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { ACTS, EMOTIONS } from '../shared/performance-cues.mjs'
import {
  FALLBACK_AVATAR_PROFILE, MAX_PROFILE_PROBLEMS, faceWeightsAt, follow, parseAvatarProfile, pulseEnvelope, resolveAvatarProfile, smoothstep,
} from './avatar-profile.ts'

const profilesDirectory = new URL('./avatar-profiles/', import.meta.url)
const readJson = url => JSON.parse(readFileSync(url, 'utf8'))
const active = () => readJson(new URL('active.json', profilesDirectory))
const visible = object => Object.keys(object).filter(key => !key.startsWith('_'))

test('every tracked profile parses cleanly, names exactly the 8 emotions and only known acts, and resolves against its installed model', () => {
  const files = readdirSync(profilesDirectory).filter(name => name.endsWith('.json'))
  assert.ok(files.includes('active.json'))
  for (const file of files) {
    const json = readJson(new URL(file, profilesDirectory))
    const { profile, problems } = parseAvatarProfile(json)
    assert.deepEqual(problems, [], file)
    assert.deepEqual(visible(json.expressions).sort(), [...EMOTIONS].sort(), file)
    for (const keys of [visible(json.acts ?? {}), visible(json.motions?.acts ?? {})])
      for (const act of keys) assert.ok(ACTS.includes(act), `${file}: ${act}`)
    for (const emotion of visible(json.motions?.emotions ?? {})) assert.ok(EMOTIONS.includes(emotion), `${file}: ${emotion}`)
    assert.equal(profile.id, json.id)

    const modelUrl = new URL(`../public/${profile.model}`, import.meta.url)
    if (!existsSync(modelUrl)) continue // Live2D sample assets are installed separately.
    const settings = readJson(modelUrl)
    const display = settings.FileReferences.DisplayInfo
    const parameters = display ? new Set(readJson(new URL(display, modelUrl)).Parameters.map(parameter => parameter.Id)) : null
    const resolved = resolveAvatarProfile(profile, {
      hasParameter: id => parameters ? parameters.has(id) : true,
      motionCount: group => settings.FileReferences.Motions?.[group]?.length ?? 0,
    })
    assert.deepEqual(resolved.problems, [], `${file} against ${profile.model}`)
  }
})

test('active.json keeps the pre-P3 neutral, soft, curious and activities exactly; happy and shy smile with the eyes', () => {
  const { profile } = parseAvatarProfile(active())
  for (const emotion of ['neutral', 'soft', 'curious'])
    assert.deepEqual(profile.expressions[emotion], FALLBACK_AVATAR_PROFILE.expressions[emotion], emotion)
  // Chosen from screenshots on 2026-10-21: Hiyori's eye smile only shows on
  // narrowed eyes, so both narrow the eyes as well as raising the smile.
  const { happy, shy } = profile.expressions
  assert.deepEqual([happy.mouthForm, happy.scale.ParamEyeLOpen, happy.blend.ParamEyeLSmile], [0.6, 0.72, [1, 0.9]])
  assert.deepEqual([shy.mouthForm, shy.scale.ParamEyeROpen, shy.blend.ParamEyeRSmile], [0.3, 0.82, [0.8, 0.85]])
  assert.ok(profile.mouth.formRange[1] >= happy.mouthForm, 'the smile is not clamped away')
  assert.deepEqual(profile.activities, FALLBACK_AVATAR_PROFILE.activities)
  assert.deepEqual(profile.timing, FALLBACK_AVATAR_PROFILE.timing)
  assert.equal(profile.model, FALLBACK_AVATAR_PROFILE.model)
  assert.deepEqual(profile.layout, FALLBACK_AVATAR_PROFILE.layout)
  // The four newer tones get faces of their own.
  for (const emotion of ['surprised', 'sad', 'pout', 'shy']) assert.equal(profile.expressions[emotion].like, undefined)
})

test('a profile that is not an object, or has a bad version or model path, falls back as a whole', () => {
  for (const input of [null, undefined, 'hiyori', 42, [], [active()]]) {
    const { profile, problems } = parseAvatarProfile(input)
    assert.equal(profile, FALLBACK_AVATAR_PROFILE)
    assert.match(problems[0], /^profile: must be an object/)
  }
  for (const version of [0, 2, '1', undefined]) {
    const { profile, problems } = parseAvatarProfile({ ...active(), version })
    assert.equal(profile, FALLBACK_AVATAR_PROFILE)
    assert.deepEqual(problems.map(problem => problem.split(':')[0]), ['version'])
  }
  for (const model of ['models/../secrets/x.model3.json', 'models/hiyori/../../x.model3.json', '/models/hiyori/hiyori.model3.json',
    'https://cdn.example.com/models/x/y.model3.json', 'models/hiyori/hiyori.json', 'models/hiyori/hiyori.model3.json.js', 'hiyori.model3.json', 42]) {
    const { profile, problems } = parseAvatarProfile({ ...active(), model })
    assert.equal(profile, FALLBACK_AVATAR_PROFILE, String(model))
    assert.match(problems[0], /^model: /)
  }
  assert.ok(Object.isFrozen(FALLBACK_AVATAR_PROFILE.expressions.soft.blend.ParamCheek))
})

test('an invalid value names its path and replaces only that section with the built-in one', () => {
  const clean = parseAvatarProfile(active()).profile
  const cases = [
    ['expressions', json => { json.expressions.angry = { add: { ParamCheek: 0.1 } } }, 'expressions.angry: not an emotion'],
    ['expressions', json => { delete json.expressions.shy }, 'expressions.shy: is required'],
    ['layout', json => { json.layout.fitWidth = NaN }, 'layout.fitWidth: must be a finite number'],
    ['layout', json => { json.layout.anchorY = 0 }, 'layout.anchorY: must be above 0 and at most 4'],
    ['timing', json => { json.timing.easeInMs = Infinity }, 'timing.easeInMs: must be a finite number'],
    ['expressions', json => { json.expressions.sad.blend.ParamBrowLForm[1] = 1.2 }, 'expressions.sad.blend.ParamBrowLForm[1]: strength must be 0..1'],
    ['expressions', json => { json.expressions.happy.add.ParamCheek = Number.NaN }, 'expressions.happy.add.ParamCheek: must be a finite number'],
    ['expressions', json => { json.expressions.shy = { like: 'soft' }; json.expressions.surprised = { like: 'shy' } }, 'expressions.surprised.like: shy wears soft; like cannot chain'],
    ['expressions', json => { json.expressions.sad = { like: 'sad' } }, 'expressions.sad.like: cannot wear its own face'],
    ['expressions', json => { json.expressions.pout = { like: 'neutral', add: { ParamAngleZ: -4 } } }, 'expressions.pout: like cannot be combined with add, scale, blend or mouthForm'],
    ['expressions', json => { json.expressions.pout = { like: 'grumpy' } }, 'expressions.pout.like: must be one of the 8 emotions'],
    ['expressions', json => { json.expressions.happy.add['Param-Cheek'] = 0.1 }, 'expressions.happy.add.Param-Cheek: not a parameter id'],
    ['parameters', json => { json.parameters.prePhysics.push('ParamHairFront') }, 'parameters.prePhysics[4]: ParamHairFront must also be in parameters.motion'],
    ['parameters', json => { json.parameters.eyeOpen = ['A', 'B', 'C', 'D', 'E'] }, 'parameters.eyeOpen: at most 4 parameter ids'],
    ['mouth', json => { json.mouth.formRange = [0.1, 0.6] }, 'mouth.formRange[0]: must be -3..0'],
    ['acts', json => { json.acts.sigh.holdMs = 3000; json.acts.sigh.releaseMs = 1000 }, 'acts.sigh: attackMs + holdMs + releaseMs must be at most 4000'],
    ['acts', json => { json.acts.giggle = json.acts.laugh }, 'acts.giggle: not an act'],
    ['motions', json => { json.motions.emotions.happy.motions = Array.from({ length: 9 }, () => ({ group: 'Flick', index: 0 })) }, 'motions.emotions.happy.motions: at most 8 motions'],
    ['motions', json => { json.motions.emotions.happy.chance = 1.5 }, 'motions.emotions.happy.chance: must be 0..1'],
    ['motions', json => { json.motions.maxPerTurn = 1.5 }, 'motions.maxPerTurn: must be an integer'],
    ['motions', json => { json.motions.idle.calmOnBusy = 'yes' }, 'motions.idle.calmOnBusy: must be true or false'],
    ['speaking', json => { json.speaking.sway.ParamBodyAngleX.periodMs = 10 }, 'speaking.sway.ParamBodyAngleX.periodMs: must be 50..600000'],
    ['speaking', json => { delete json.speaking.envelope }, 'speaking.envelope: is required'],
  ]
  for (const [section, change, message] of cases) {
    const json = active()
    change(json)
    const { profile, problems } = parseAvatarProfile(json)
    assert.ok(problems.includes(message), `${message}\n  got: ${problems.join(' | ')}`)
    assert.deepEqual(profile[section], FALLBACK_AVATAR_PROFILE[section], `${section} falls back`)
    for (const other of Object.keys(clean).filter(key => key !== section))
      assert.deepEqual(profile[other], clean[other], `${message}: ${other} is kept`)
    assert.ok(Object.isFrozen(profile) && Object.isFrozen(profile.expressions.happy))
  }
})

test('unknown keys are reported but kept out, notes are ignored, and at most 20 messages are listed', () => {
  const clean = parseAvatarProfile(active()).profile
  assert.equal(clean._notes, undefined)
  assert.equal(clean.motions._notes, undefined)
  const typo = active()
  typo.expresions = typo.expressions
  typo.expressions.happy._why = 'notes go anywhere'
  typo.layout.zoom = 2
  const parsed = parseAvatarProfile(typo)
  assert.deepEqual(parsed.problems, ['expresions: unknown key, ignored', 'layout.zoom: unknown key, ignored'])
  assert.deepEqual(parsed.profile, clean)

  const noisy = active()
  noisy.expressions.happy.add = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`ParamX${index}`, 99]))
  const { problems } = parseAvatarProfile(noisy)
  assert.equal(problems.length, MAX_PROFILE_PROBLEMS)
  assert.equal(problems[0], 'expressions.happy.add.ParamX0: must be -30..30')
  assert.equal(problems.at(-1), 'and 11 more problems')

  const named = parseAvatarProfile({ ...active(), id: 'Mao Pro', name: '' })
  assert.equal(named.profile.id, FALLBACK_AVATAR_PROFILE.id)
  assert.deepEqual(named.problems.map(problem => problem.split(':')[0]), ['id', 'name'])
  assert.deepEqual(named.profile.expressions, clean.expressions, 'a bad id or name does not drop the sections')
})

test('resolving against a model drops unknown ids and unplayable refs with problems, and expands index-less refs', () => {
  const json = active()
  json.motions.emotions.happy.motions.push({ group: 'Flick', index: 3 })
  const { profile } = parseAvatarProfile(json)
  const missing = new Set(['ParamCheek', 'ParamBodyAngleZ'])
  const counts = { Idle: 4, Flick: 1, Tap: 2, FlickDown: 1 }
  const { profile: resolved, problems } = resolveAvatarProfile(profile, {
    hasParameter: id => !missing.has(id),
    motionCount: group => counts[group] ?? 0,
  })
  assert.equal(resolved.expressions.happy.add.ParamCheek, undefined)
  assert.deepEqual(resolved.expressions.happy.blend.ParamEyeLSmile, [1, 0.9])
  assert.equal(resolved.expressions.soft.blend.ParamCheek, undefined)
  assert.ok(!resolved.parameters.motion.includes('ParamBodyAngleZ'))
  assert.ok(!resolved.parameters.prePhysics.includes('ParamBodyAngleZ'))
  assert.equal(resolved.speaking.sway.ParamBodyAngleZ, undefined)
  assert.deepEqual(resolved.motions.tap.motions, [{ group: 'Tap', index: 0 }, { group: 'Tap', index: 1 }])
  assert.deepEqual(resolved.motions.emotions.shy.motions, [])
  assert.deepEqual(resolved.motions.emotions.happy.motions, [{ group: 'Flick', index: 0 }])
  assert.deepEqual(resolved.motions.idle, profile.motions.idle)
  for (const expected of [
    'expressions.happy.add.ParamCheek: ParamCheek is not in the model, dropped',
    'parameters.motion[5]: ParamBodyAngleZ is not in the model, dropped',
    'motions.emotions.shy.motions[0]: no motion group Tap@Body, dropped',
    'motions.emotions.happy.motions[1]: Flick has 1 motions, index 3 dropped',
    'motions.idle.busyWeights: Idle has 4 motions; the missing weights count as 0',
  ]) assert.ok(problems.includes(expected), `${expected}\n  got: ${problems.join(' | ')}`)
  assert.ok(problems.length <= MAX_PROFILE_PROBLEMS)
  assert.ok(Object.isFrozen(resolved.motions.tap.motions[1]))
  // Unchanged parts come through as they were.
  assert.deepEqual(resolved.layout, profile.layout)
  assert.deepEqual(resolved.acts.pause, profile.acts.pause)

  const noIdle = resolveAvatarProfile(profile, { hasParameter: () => true, motionCount: group => group === 'Idle' ? 0 : 1 })
  assert.equal(noIdle.profile.motions.idle, undefined)
  assert.ok(noIdle.problems.includes('motions.idle.group: no motion group Idle, Idle weighting dropped'))
  const fallback = resolveAvatarProfile(FALLBACK_AVATAR_PROFILE, { hasParameter: () => true, motionCount: () => 1 })
  assert.deepEqual(fallback.problems, [])
  assert.equal('speaking' in fallback.profile, false)
})

test('face weights ease by smoothstep, always sum to 1 and stay continuous when retargeted', () => {
  const neutral = EMOTIONS.map(emotion => Number(emotion === 'neutral'))
  const track = { from: neutral, to: 'happy', start: 1000, duration: 300 }
  const at = (t, which = track) => Object.fromEntries(EMOTIONS.map((emotion, index) => [emotion, faceWeightsAt(which, t)[index]]))
  assert.equal(at(1000).happy, 0)
  assert.equal(at(1150).happy, 0.5)
  assert.equal(at(1150).neutral, 0.5)
  assert.equal(at(1300).happy, 1)
  assert.equal(at(5000).neutral, 0)
  assert.equal(at(900).neutral, 1, 'before the start the old face holds')
  for (let t = 900; t <= 1400; t += 7) {
    const sum = faceWeightsAt(track, t).reduce((total, weight) => total + weight, 0)
    assert.ok(Math.abs(sum - 1) < 1e-12, `sum at ${t}`)
  }
  const retarget = { from: faceWeightsAt(track, 1100), to: 'soft', start: 1100, duration: 300 }
  assert.deepEqual(faceWeightsAt(retarget, 1100), faceWeightsAt(track, 1100))
  let previous = faceWeightsAt(retarget, 1100)
  for (let t = 1101; t <= 1400; t++) {
    const next = faceWeightsAt(retarget, t)
    assert.ok(next.every((weight, index) => Math.abs(weight - previous[index]) < 0.01), `continuous at ${t}`)
    assert.ok(Math.abs(next.reduce((total, weight) => total + weight, 0) - 1) < 1e-12)
    previous = next
  }
  assert.equal(faceWeightsAt({ from: neutral, to: 'sad', start: 0, duration: 0 }, 0)[EMOTIONS.indexOf('sad')], 1)
  assert.equal(smoothstep(-1), 0)
  assert.equal(smoothstep(2), 1)
})

test('act envelopes are 0 outside, 1 in the hold and monotonic on each edge', () => {
  const pulse = { attackMs: 80, holdMs: 500, releaseMs: 400 }
  for (const age of [-1, -500, 980, 981, 10_000, Number.NaN]) assert.equal(pulseEnvelope(age, pulse), 0, String(age))
  for (const age of [80, 200, 579.9]) assert.equal(pulseEnvelope(age, pulse), 1)
  assert.equal(pulseEnvelope(40, pulse), 0.5)
  assert.equal(pulseEnvelope(780, pulse), 0.5)
  let previous = 0
  for (let age = 0; age <= 80; age++) {
    const value = pulseEnvelope(age, pulse)
    assert.ok(value >= previous)
    previous = value
  }
  for (let age = 580; age <= 990; age++) {
    const value = pulseEnvelope(age, pulse)
    assert.ok(value <= previous)
    previous = value
  }
  assert.equal(pulseEnvelope(0, { attackMs: 0, holdMs: 100, releaseMs: 0 }), 1)
  assert.equal(pulseEnvelope(100, { attackMs: 0, holdMs: 100, releaseMs: 0 }), 0)
})

test('the follower gives the same value at 30 and 60 fps for a held input', () => {
  for (const [start, target] of [[0, 1], [1, 0], [0.3, 0.8]]) {
    let thirty = start
    let sixty = start
    for (let frame = 0; frame < 30; frame++) thirty = follow(thirty, target, 1000 / 30, 40, 160)
    for (let frame = 0; frame < 60; frame++) sixty = follow(sixty, target, 1000 / 60, 40, 160)
    assert.ok(Math.abs(thirty - sixty) < 1e-12, `${start} -> ${target}`)
  }
  assert.ok(Math.abs(follow(0, 1, 40, 40, 160) - (1 - Math.exp(-1))) < 1e-12, 'attack constant while rising')
  assert.ok(Math.abs(follow(1, 0, 160, 40, 160) - Math.exp(-1)) < 1e-12, 'release constant while falling')
  assert.equal(follow(0.5, 0.5, 33, 40, 160), 0.5)
})
