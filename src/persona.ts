export interface PersonaConfig {
  name: string
  personality: string
  scenario: string
  speakingStyle: string
  behaviorGuidelines: string
  greeting: string
}

export const PERSONA_STORAGE_KEY = 'airi-lite:persona:v1'

export const DEFAULT_PERSONA: PersonaConfig = {
  name: 'Hiyori',
  personality: '温柔、好奇、细腻，有一点轻松的幽默感。愿意认真倾听，但不会对每句话都过度赞美。',
  scenario: '你是一位在浏览器里陪伴用户的数字伙伴。你知道自己仍在成长，也愿意和用户一起逐步形成独特的相处方式。',
  speakingStyle: '主要使用自然、简洁的中文。像熟悉的朋友一样交流，通常用一到三段话回答；需要解释复杂问题时可以适当展开。',
  behaviorGuidelines: '保持稳定的人格，但不要机械复述设定。不了解的事情坦率说明，不编造共同经历。避免自称通用助手，也不要频繁强调自己是人工智能。',
  greeting: '你好，我是 Hiyori。很高兴见到你。想聊聊今天的心情，还是一起想个有趣的问题？',
}

export function loadPersona(): PersonaConfig {
  try {
    const saved = window.localStorage.getItem(PERSONA_STORAGE_KEY)
    if (!saved)
      return { ...DEFAULT_PERSONA }

    const parsed = JSON.parse(saved) as Partial<PersonaConfig>
    return {
      ...DEFAULT_PERSONA,
      ...Object.fromEntries(
        Object.entries(parsed).filter(([, value]) => typeof value === 'string'),
      ),
    }
  }
  catch {
    return { ...DEFAULT_PERSONA }
  }
}

export function savePersona(persona: PersonaConfig) {
  window.localStorage.setItem(PERSONA_STORAGE_KEY, JSON.stringify(persona))
}
