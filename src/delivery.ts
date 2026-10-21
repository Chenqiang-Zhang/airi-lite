import { normaliseEmotion } from '../shared/performance-cues.mjs'
import type { Emotion } from '../shared/performance-cues.mjs'

// Delivery is a small performance cue, not a claim that the model has emotions.
// The vocabulary lives in shared/performance-cues.mjs; 'bright' is read as
// happy where old data comes in.
export type Delivery = Emotion

// Local and browser speech only; cloud voices get their own tables server-side.
const SPEED: Record<Delivery, number> = {
  neutral: 0.98,
  happy: 1.04,
  soft: 0.93,
  curious: 0.99,
  surprised: 1.02,
  sad: 0.92,
  pout: 1,
  shy: 0.95,
}

// Untyped callers (preview pages, old stored data) may still pass 'bright'.
export function deliverySpeed(delivery: Delivery): number {
  return SPEED[normaliseEmotion(delivery) ?? 'neutral']
}

export function chooseDelivery(userText: string, replyText: string): Delivery {
  const withoutNegations = userText.replace(/不(?:难过|伤心|焦虑|害怕|累)/g, '')
  if (/(?:难过|伤心|焦虑|害怕|失眠|哭了|哭泣|崩溃|痛苦|生病|去世|分手|压力很大|好累|很累|不舒服|不开心|沮丧|低落|委屈|孤独)/.test(withoutNegations))
    return 'soft'

  const reply = replyText.trim()
  if (reply.length > 180)
    return 'neutral'
  if (/[!！]|哈哈|好耶|太好啦/.test(reply))
    return 'happy'
  if (/[?？]$/.test(reply))
    return 'curious'
  return 'neutral'
}
