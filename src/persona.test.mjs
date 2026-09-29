import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_PERSONA, loadPersona, PERSONA_STORAGE_KEY, savePersona } from './persona.ts'

const oldDefault = {
  name: 'Hiyori',
  personality: '温柔、好奇、细腻，有一点轻松的幽默感。愿意认真倾听，但不会对每句话都过度赞美。',
  scenario: '你是一位在浏览器里陪伴用户的数字伙伴。你知道自己仍在成长，也愿意和用户一起逐步形成独特的相处方式。',
  speakingStyle: '主要使用自然、简洁的中文。像熟悉的朋友一样交流，通常用一到三段话回答；需要解释复杂问题时可以适当展开。',
  behaviorGuidelines: '保持稳定的人格，但不要机械复述设定。不了解的事情坦率说明，不编造共同经历。避免自称通用助手，也不要频繁强调自己是人工智能。',
  greeting: '你好，我是 Hiyori。很高兴见到你。想聊聊今天的心情，还是一起想个有趣的问题？',
}

function withStoredPersona(saved, check) {
  const previousWindow = globalThis.window
  let value = saved
  globalThis.window = {
    localStorage: {
      getItem: key => key === PERSONA_STORAGE_KEY ? value : null,
      setItem: (key, next) => {
        assert.equal(key, PERSONA_STORAGE_KEY)
        value = next
      },
    },
  }

  try {
    check(() => value)
  }
  finally {
    globalThis.window = previousWindow
  }
}

test('new visitors receive the lively default persona', () => {
  withStoredPersona(null, () => {
    assert.deepEqual(loadPersona(), DEFAULT_PERSONA)
    assert.match(loadPersona().dialogueExamples, /日和：/)
  })
})

test('the unchanged previous default upgrades to the new default', () => {
  withStoredPersona(JSON.stringify(oldDefault), () => {
    assert.deepEqual(loadPersona(), DEFAULT_PERSONA)
  })
})

test('customised previous personas keep their settings and do not inherit example lines', () => {
  const customised = { ...oldDefault, speakingStyle: '我自己写的语气' }
  withStoredPersona(JSON.stringify(customised), getStored => {
    const loaded = loadPersona()
    assert.equal(loaded.speakingStyle, customised.speakingStyle)
    assert.equal(loaded.personality, customised.personality)
    assert.equal(loaded.dialogueExamples, '')
    savePersona(loaded)
    assert.equal(JSON.parse(getStored()).speakingStyle, customised.speakingStyle)
  })
})
