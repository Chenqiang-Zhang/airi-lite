// Delivery is a small performance cue, not a claim that the model has emotions.
export type Delivery = 'neutral' | 'soft' | 'bright' | 'curious'

const SPEED: Record<Delivery, number> = {
  neutral: 0.98,
  soft: 0.93,
  bright: 1.04,
  curious: 0.99,
}

export function deliverySpeed(delivery: Delivery): number {
  return SPEED[delivery]
}

export function chooseDelivery(userText: string, replyText: string): Delivery {
  const withoutNegations = userText.replace(/不(?:难过|伤心|焦虑|害怕|累|舒服)/g, '')
  if (/(?:难过|伤心|焦虑|害怕|失眠|哭了|哭泣|崩溃|痛苦|生病|去世|分手|压力很大|好累|很累|不舒服)/.test(withoutNegations))
    return 'soft'

  const reply = replyText.trim()
  if (reply.length > 180)
    return 'neutral'
  if (/[!！]|哈哈|好耶|太好啦/.test(reply))
    return 'bright'
  if (/[?？]$/.test(reply))
    return 'curious'
  return 'neutral'
}
