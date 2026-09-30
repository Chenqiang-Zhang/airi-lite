import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { attachAvatarPerformance } from './avatar-performance.ts'

function fixture(reducedMotion = false) {
  let time = 0
  const values = new Map()
  const model = new EventEmitter()
  model.coreModel = {
    setParameterValueById: (id, value, weight = 1) => values.set(id, (values.get(id) ?? 0) * (1 - weight) + value * weight),
    addParameterValueById: (id, value) => values.set(id, (values.get(id) ?? 0) + value),
  }
  const actor = attachAvatarPerformance(model, { now: () => time, reducedMotion: () => reducedMotion })
  const frame = (milliseconds = 16, idleMouth = 1, idleSmile = 0) => {
    time += milliseconds
    // Cubism restores the motion baseline before each pre-render event.
    values.clear()
    values.set('ParamMouthOpenY', idleMouth)
    values.set('ParamMouthForm', -1)
    for (const id of ['ParamCheek', 'ParamEyeLSmile', 'ParamEyeRSmile'])
      values.set(id, idleSmile)
    model.emit('beforeModelUpdate')
    return Object.fromEntries(values)
  }
  return { actor, frame, model }
}

test('rendered mouth survives alternating Idle motions and closes on interruption', () => {
  const { actor, frame, model } = fixture()
  assert.equal(frame().ParamMouthOpenY, 0)
  actor.setActivity('speaking')
  actor.setMouth(0.7, 0.2)
  for (const idleMouth of [0, 1, 0, 1]) {
    const pose = frame(16, idleMouth)
    assert.equal(pose.ParamMouthOpenY, 0.7)
    assert.equal(pose.ParamMouthForm, 0.2)
  }
  actor.setActivity('idle')
  assert.equal(frame().ParamMouthOpenY, 0)
  actor.destroy()
  assert.equal(model.listenerCount('beforeModelUpdate'), 0)
})

test('facial expression fades across speech gaps instead of switching at sentence boundaries', () => {
  const { actor, frame } = fixture()
  actor.setActivity('speaking')
  actor.setDelivery('bright')
  for (let i = 0; i < 12; i++) frame(50)
  const speaking = frame().ParamCheek
  actor.setActivity('thinking')
  actor.setDelivery('neutral')
  const gap = frame(25)
  assert.equal(gap.ParamMouthOpenY, 0)
  assert.ok(gap.ParamCheek > speaking * 0.8)
  for (let i = 0; i < 30; i++) frame(50)
  assert.ok(frame().ParamCheek < 0.002)
})

test('attention responds to state while reduced-motion mode keeps audio mouth control', () => {
  const normal = fixture()
  normal.actor.setActivity('attentive')
  for (let i = 0; i < 10; i++) normal.frame(50)
  assert.ok(normal.frame().ParamAngleY > 1)
  const reduced = fixture(true)
  reduced.actor.setActivity('speaking')
  reduced.actor.setMouth(0.6, 0)
  const pose = reduced.frame(50)
  assert.equal(pose.ParamMouthOpenY, 0.6)
  assert.equal(pose.ParamAngleY, undefined)
})

test('soft delivery calms a smiling Idle baseline and neutral restores it', () => {
  const { actor, frame } = fixture()
  actor.setDelivery('soft')
  for (let i = 0; i < 30; i++) frame(50, 0, 1)
  const soft = frame(16, 0, 1)
  assert.ok(soft.ParamCheek < 0.12)
  assert.ok(soft.ParamEyeLSmile < 0.12)
  assert.ok(soft.ParamEyeRSmile < 0.12)
  actor.setDelivery('neutral')
  for (let i = 0; i < 30; i++) frame(50, 0, 1)
  assert.ok(frame(16, 0, 1).ParamCheek > 0.98)
})

test('browser voice fallback animates over elapsed time and closes immediately', () => {
  const { actor, frame } = fixture()
  actor.setMouth(null, 0)
  actor.setActivity('speaking')
  const first = frame(16).ParamMouthOpenY
  const second = frame(50).ParamMouthOpenY
  assert.ok(first >= 0.2 && first <= 0.7)
  assert.notEqual(first, second)
  actor.setActivity('idle')
  assert.equal(frame().ParamMouthOpenY, 0)
})
