export type Emotion = 'neutral' | 'happy' | 'soft' | 'curious' | 'surprised' | 'sad' | 'pout' | 'shy'
export type Act = 'laugh' | 'sigh' | 'pause'
export type Viseme = 'a' | 'i' | 'u' | 'e' | 'o' | 'n' | 'm'

export interface ActCue {
  start: number // UTF-16 character offset in the visible reply.
  act: Act
}

export const EMOTIONS: readonly Emotion[]
export const EMOTION_ALIASES: Readonly<Record<string, Emotion>>
export function isEmotion(value: unknown): value is Emotion
export function normaliseEmotion(value: unknown): Emotion | null

export const STAGE_PROTOCOL: number

export const ACTS: readonly Act[]
export const MAX_ACTS_PER_REPLY: number
export const ACT_PAUSE_SECONDS: number
export function isAct(value: unknown): value is Act
export const VISEMES: readonly Viseme[]
export function isViseme(value: unknown): value is Viseme
export function normaliseActCues(value: unknown, textLength: number): ActCue[]
