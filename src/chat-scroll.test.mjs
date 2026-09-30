import assert from 'node:assert/strict'
import test from 'node:test'

import { createChatScrollController } from './chat-scroll.ts'

function createViewport() {
  const listeners = new Map()
  let position = 800
  return {
    scrollHeight: 1_000,
    clientHeight: 200,
    get scrollTop() { return position },
    set scrollTop(value) {
      position = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight))
    },
    addEventListener(type, listener) {
      if (!listeners.has(type))
        listeners.set(type, new Set())
      listeners.get(type).add(listener)
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener)
    },
    emitScroll() {
      for (const listener of listeners.get('scroll') ?? [])
        listener({ target: this })
    },
    listenerCount() {
      return [...listeners.values()].reduce((sum, group) => sum + group.size, 0)
    },
  }
}

function harness() {
  const viewport = createViewport()
  const frames = new Map()
  const cancelled = []
  const unread = []
  // Frame zero is valid; cancellation must not depend on truthiness.
  let nextFrame = 0
  const controller = createChatScrollController(viewport, {
    requestFrame: callback => {
      const id = nextFrame++
      frames.set(id, callback)
      return id
    },
    cancelFrame: id => {
      cancelled.push(id)
      frames.delete(id)
    },
    onUnread: value => unread.push(value),
  })
  return {
    viewport, controller, frames, cancelled, unread,
    flush() {
      const ready = [...frames.values()]
      frames.clear()
      for (const callback of ready)
        callback(16)
    },
    scrollTo(position) {
      viewport.scrollTop = position
      viewport.emitScroll()
    },
  }
}

test('streaming growth follows the latest content and coalesces frame work', () => {
  const h = harness()
  h.viewport.scrollHeight = 1_100
  h.controller.notifyContentChanged()
  h.viewport.scrollHeight = 1_300
  h.controller.notifyContentChanged()
  h.controller.notifyContentChanged()
  assert.equal(h.frames.size, 1)
  h.flush()
  assert.equal(h.viewport.scrollTop, 1_100)
  assert.ok(h.unread.every(value => value === false))
  h.controller.destroy()
})

test('scrolling up cancels queued follow work and later content does not steal position', () => {
  const h = harness()
  h.viewport.scrollHeight = 1_200
  h.controller.notifyContentChanged()
  h.scrollTo(300)
  assert.ok(h.cancelled.includes(0))
  assert.equal(h.frames.size, 0)
  h.flush()
  assert.equal(h.viewport.scrollTop, 300)

  h.viewport.scrollHeight = 1_500
  h.controller.notifyContentChanged()
  h.flush()
  assert.equal(h.viewport.scrollTop, 300)
  assert.equal(h.unread.at(-1), true)
  h.controller.destroy()
})

test('a delayed automatic scroll event does not mistake a large new delta for user scrolling', () => {
  const h = harness()
  h.viewport.scrollHeight = 1_100
  h.controller.notifyContentChanged()
  h.flush()
  assert.equal(h.viewport.scrollTop, 900)
  h.viewport.scrollHeight = 1_400
  h.controller.notifyContentChanged()
  h.viewport.emitScroll() // Event from the earlier automatic write arrives late.
  h.flush()
  assert.equal(h.viewport.scrollTop, 1_200)
  assert.ok(h.unread.every(value => value === false))

  h.viewport.scrollHeight = 1_600
  h.controller.notifyContentChanged()
  h.scrollTo(700) // A real move away must still cancel the queued follow.
  h.flush()
  assert.equal(h.viewport.scrollTop, 700)
  h.controller.notifyContentChanged()
  assert.equal(h.unread.at(-1), true)
  h.controller.destroy()
})

test('jumping to latest clears unread content and resumes streaming follow', () => {
  const h = harness()
  h.scrollTo(200)
  h.viewport.scrollHeight = 1_300
  h.controller.notifyContentChanged()
  assert.equal(h.unread.at(-1), true)
  h.controller.jumpToLatest()
  h.flush()
  assert.equal(h.viewport.scrollTop, 1_100)
  assert.equal(h.unread.at(-1), false)

  h.viewport.scrollHeight = 1_600
  h.controller.notifyContentChanged()
  h.flush()
  assert.equal(h.viewport.scrollTop, 1_400)
  h.controller.destroy()
})

test('manually returning to the bottom restores follow without a jump button', () => {
  const h = harness()
  h.scrollTo(100)
  h.viewport.scrollHeight = 1_500
  h.controller.notifyContentChanged()
  h.scrollTo(1_300)
  assert.equal(h.unread.at(-1), false)
  h.viewport.scrollHeight = 1_700
  h.controller.notifyContentChanged()
  h.flush()
  assert.equal(h.viewport.scrollTop, 1_500)
  h.controller.destroy()
})

test('destroy cancels pending work, removes listeners and ignores later notifications', () => {
  const h = harness()
  h.viewport.scrollHeight = 1_300
  h.controller.notifyContentChanged()
  h.controller.destroy()
  assert.equal(h.viewport.listenerCount(), 0)
  assert.equal(h.frames.size, 0)
  assert.ok(h.cancelled.includes(0))
  h.controller.notifyContentChanged()
  h.controller.jumpToLatest()
  h.flush()
  assert.equal(h.frames.size, 0)
  assert.equal(h.viewport.scrollTop, 800)
})

test('resizing follows only when attached and does not invent unread content', () => {
  const previous = globalThis.ResizeObserver
  const observers = []
  globalThis.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback
      this.disconnected = false
      observers.push(this)
    }
    observe() {}
    disconnect() { this.disconnected = true }
    fire() { this.callback([], this) }
  }
  let h
  try {
    h = harness()
    assert.ok(observers.length > 0)
    h.viewport.clientHeight = 150
    for (const observer of observers)
      observer.fire()
    h.flush()
    assert.equal(h.viewport.scrollTop, 850)

    h.scrollTo(200)
    h.viewport.clientHeight = 100
    for (const observer of observers)
      observer.fire()
    h.flush()
    assert.equal(h.viewport.scrollTop, 200)
    assert.ok(h.unread.every(value => value === false))
    h.controller.destroy()
    assert.ok(observers.every(observer => observer.disconnected))
  }
  finally {
    h?.controller.destroy()
    if (previous === undefined)
      delete globalThis.ResizeObserver
    else
      globalThis.ResizeObserver = previous
  }
})
