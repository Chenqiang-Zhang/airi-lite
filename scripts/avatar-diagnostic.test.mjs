import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { attachAvatarPerformance } from '../src/avatar-performance.ts'
import { createPitchShadow, LOW_MOUTH_OPEN_THRESHOLD } from './avatar-diagnostic.mjs'

// An independent, minimal reference for the installed Cubism 4 setter/add
// contract. Do not use the shadow helper for both sides of the comparison.
function cubismPitchReference(minimum = -30, maximum = 30) {
  let pitch = 0
  const coreModel = {
    getParameterValueById(id) { return id === 'ParamAngleY' ? pitch : 0 },
    setParameterValueById(id, value, weight = 1) {
      if (id !== 'ParamAngleY') return
      if (value > maximum) value = maximum
      if (value < minimum) value = minimum
      pitch = weight === 1 ? value : pitch * (1 - weight) + value * weight
    },
    addParameterValueById(id, value, weight = 1) {
      if (id === 'ParamAngleY') coreModel.setParameterValueById(id, pitch + value * weight)
    },
  }
  return {
    coreModel,
    setBaseline(value) { coreModel.setParameterValueById('ParamAngleY', value) },
    getPitch() { return pitch },
  }
}

function actorFor(pitchModel, now) {
  let apply
  const actor = attachAvatarPerformance({
    coreModel: pitchModel.coreModel,
    on(_event, listener) { apply = listener },
    off() { apply = null },
  }, { now })
  return { actor, render() { apply?.() } }
}

test('shadow clamps the requested target before blending, including zero/full weights', () => {
  const shadow = createPitchShadow()
  const core = shadow.coreModel
  shadow.setBaseline(30)
  core.setParameterValueById('ParamAngleY', -60, 0.25)
  assert.equal(shadow.getPitch(), 15, 'clamping after blending would incorrectly produce 7.5')
  shadow.setBaseline(-30)
  core.setParameterValueById('ParamAngleY', 60, 0.25)
  assert.equal(shadow.getPitch(), -15)
  core.setParameterValueById('ParamAngleY', 100, 0)
  assert.equal(shadow.getPitch(), -15)
  core.setParameterValueById('ParamAngleY', 100)
  assert.equal(shadow.getPitch(), 30)
})

test('shadow additive writes use the clamped setter and apply their weight to the delta', () => {
  const shadow = createPitchShadow()
  shadow.setBaseline(30)
  shadow.coreModel.addParameterValueById('ParamAngleY', 1.8)
  assert.equal(shadow.getPitch(), 30, 'an Idle limit plus thinking must not exceed the real core range')
  shadow.setBaseline(-30)
  shadow.coreModel.addParameterValueById('ParamAngleY', -2.4)
  assert.equal(shadow.getPitch(), -30)
  shadow.setBaseline(-29)
  shadow.coreModel.addParameterValueById('ParamAngleY', 100, 0.5)
  assert.equal(shadow.getPitch(), 21, 'the add weight is not a weighted set of a pre-clamped delta')
})

test('diagnostic shadow honours actual supplied model bounds and ignores unrelated parameters', () => {
  const shadow = createPitchShadow(-12, 18)
  shadow.setBaseline(15)
  shadow.coreModel.addParameterValueById('ParamAngleY', 10)
  assert.equal(shadow.getPitch(), 18)
  shadow.coreModel.setParameterValueById('ParamMouthOpenY', 1)
  assert.equal(shadow.getPitch(), 18)
  assert.equal(shadow.coreModel.getParameterValueById('ParamMouthOpenY'), 0)
  shadow.setBaseline(-100)
  assert.equal(shadow.getPitch(), -12)
  assert.throws(() => createPitchShadow(30, -30), /pitch bounds/)
  assert.throws(() => createPitchShadow(NaN, 30), /pitch bounds/)
  assert.throws(() => shadow.setBaseline(NaN), /pitch baseline/)
})

test('zero-audio shadow isolates thinking/attention fade even at both real pitch extremes', () => {
  for (const baseline of [-30, -29.9, 0, 29.9, 30]) {
    for (const warmActivity of ['thinking', 'attentive']) {
      let time = 0
      const reference = cubismPitchReference()
      const shadow = createPitchShadow()
      const actual = actorFor(reference, () => time)
      const diagnostic = actorFor(shadow, () => time)
      const frame = milliseconds => {
        time += milliseconds
        reference.setBaseline(baseline)
        shadow.setBaseline(baseline)
        actual.render()
        diagnostic.render()
        assert.ok(reference.getPitch() >= -30 && reference.getPitch() <= 30)
        assert.equal(shadow.getPitch(), reference.getPitch(), `${warmActivity}, baseline ${baseline}, time ${time}`)
      }
      try {
        actual.actor.setActivity(warmActivity)
        diagnostic.actor.setActivity(warmActivity)
        for (let index = 0; index < 20; index++) frame(50)
        if (baseline === 30) assert.equal(shadow.getPitch(), 30, 'positive state offsets must clip, not become false speech emphasis')
        actual.actor.setActivity('speaking')
        diagnostic.actor.setActivity('speaking')
        actual.actor.setMouth(0, 0)
        diagnostic.actor.setMouth(0, 0)
        for (let index = 0; index < 80; index++) frame(16)
      }
      finally { actual.actor.destroy(); diagnostic.actor.destroy() }
    }
  }
})

test('the preview uses real model bounds, labels low opening honestly and starts controls disabled', () => {
  const html = readFileSync(new URL('./avatar-preview.html', import.meta.url), 'utf8')
  assert.match(html, /createPitchShadow/)
  assert.match(html, /getParameterMinimumValue\(pitchIndex\)/)
  assert.match(html, /getParameterMaximumValue\(pitchIndex\)/)
  assert.match(html, /<fieldset[^>]*id="controls"[^>]*disabled/)
  assert.match(html, /controls\.disabled = false/)
  assert.match(html, /audio\.controls = true/)
  assert.match(html, /低开口帧（<0\.06）/)
  assert.doesNotMatch(html, /静音帧|静音点头错误/)
  assert.equal(LOW_MOUTH_OPEN_THRESHOLD, 0.06)
})
