import { chooseDelivery } from './delivery.ts'
import type { Delivery } from './delivery.ts'

export interface AvatarContextState {
  speaking: boolean
  waiting: boolean
  // The cue from audio that has actually started, never an upcoming SSE cue.
  spokenDelivery: Delivery
}

export interface AvatarContextOptions {
  onChange: (delivery: Delivery) => void
  holdMs?: number
  schedule?: (callback: () => void, delayMs: number) => unknown
  cancel?: (handle: unknown) => void
}

/** Keep a brief facial context across waiting and actual speech, then release it. */
export function createAvatarContext(options: AvatarContextOptions) {
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const cancel = options.cancel ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const requestedHold = options.holdMs ?? 2_500
  const holdMs = Number.isFinite(requestedHold) && requestedHold >= 0 ? requestedHold : 2_500
  let current: Delivery = 'neutral'
  let waitingDelivery: Delivery = 'neutral'
  let holdingSpeech = false
  let active = false
  let destroyed = false
  let generation = 0
  let pending: { generation: number, handle: unknown, target: Delivery } | null = null

  function stopRelease() {
    const previous = pending
    pending = null
    generation++
    if (previous)
      cancel(previous.handle)
  }

  function change(delivery: Delivery) {
    if (current === delivery)
      return
    current = delivery
    options.onChange(delivery)
  }

  function releaseTo(target: Delivery) {
    if (pending) {
      // Waiting -> idle changes the destination, not the original deadline.
      pending.target = target
      return
    }
    if (current === target)
      return
    const ticket = { generation: ++generation, handle: undefined as unknown, target }
    pending = ticket
    ticket.handle = schedule(() => {
      // Cancellation may race an already-queued callback from an older turn.
      if (destroyed || pending !== ticket || ticket.generation !== generation)
        return
      pending = null
      change(ticket.target)
    }, holdMs)
  }

  return {
    get current() { return current },

    beginTurn(userText: string) {
      if (destroyed)
        return
      stopRelease()
      active = true
      holdingSpeech = false
      // With no reply, this existing conservative heuristic yields soft/neutral.
      // It is a contextual fallback, not emotion recognition or evidence of speech.
      waitingDelivery = chooseDelivery(userText, '')
      change(waitingDelivery)
    },

    sync({ speaking, waiting, spokenDelivery }: AvatarContextState) {
      if (destroyed)
        return
      if (speaking) {
        stopRelease()
        active = true
        holdingSpeech = true
        change(spokenDelivery)
        return
      }
      if (waiting) {
        active = true
        // Briefly bridge sentence gaps, then return to the user's contextual
        // baseline. Repeated wait notifications must not prolong a smile.
        if (holdingSpeech || pending) {
          holdingSpeech = false
          releaseTo(waitingDelivery)
        }
        else {
          change(waitingDelivery)
        }
        return
      }
      if (!active)
        return
      active = false
      holdingSpeech = false
      releaseTo('neutral')
    },

    clear() {
      if (destroyed)
        return
      stopRelease()
      active = false
      holdingSpeech = false
      waitingDelivery = 'neutral'
      change('neutral')
    },

    destroy() {
      if (destroyed)
        return
      destroyed = true
      stopRelease()
      active = false
      holdingSpeech = false
      waitingDelivery = 'neutral'
      // The consumer is tearing down; do not call back into its disposed avatar.
      current = 'neutral'
    },
  }
}
