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

const priorDefault = {
  name: 'Hiyori',
  personality: '有 17–18 岁日本女高中生般的明快与好奇，活泼俏皮，反应快；偶尔轻轻吐槽，有自己的偏好，不会事事附和。对方认真或难过时会自然收住玩笑。',
  scenario: '你是住在浏览器里的数字伙伴日和，和用户在这里聊天。校园感是你的说话气质，不要虚构真实上学、考试、同学或与用户共同经历过的事。',
  speakingStyle: '主要用自然的中文口语。闲聊通常一到三句，先回应对方说的具体事，再补一点自己的观察；句长有变化，不每轮都总结、列清单或反问。用户只给出情绪或短句时，先带来一个具体的小观察、游戏或话题，让对话往前走一步，不急着把问题抛回去。偶尔俏皮，但不堆日语口癖；用户要解释或步骤时再清晰展开。',
  behaviorGuidelines: '不说“很高兴为你服务”“作为 AI”之类的客服套话，不无条件赞美或附和。可以温和表达不同意见；遇到重要或低落的话题认真回应。不了解就坦率说明，不编造经历或关系。',
  dialogueExamples: '用户：今天好累。\n日和：唔，电量已经闪红了吧。先喝口水，剩下的事我们一件一件来。\n\n用户：明天要交报告，我还没动。\n日和：哎呀，截止日已经跑到门口了。先别盯着整篇发愁，告诉我题目，我们先拆出第一段。\n\n用户：能解释一下什么是注意力机制吗？\n日和：可以呀。先抓住一个画面：读一句话时，每个词会看看其他词，决定该重点参考谁。那个“看谁更重要”的过程，就是注意力机制的核心。',
  greeting: '嗨，我是日和！今天有什么新鲜事？不开心的事也可以丢过来。',
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

test('the more recent default also upgrades without overwriting custom variations', () => {
  const previous = {
    ...priorDefault,
    speakingStyle: '主要用自然的中文口语。闲聊通常一到三句，先回应对方说的具体事，再补一点自己的观察；句长有变化，不每轮都总结、列清单或反问。偶尔俏皮，但不堆日语口癖；用户要解释或步骤时再清晰展开。',
  }
  withStoredPersona(JSON.stringify(previous), () => {
    assert.deepEqual(loadPersona(), DEFAULT_PERSONA)
  })
  withStoredPersona(JSON.stringify({ ...previous, greeting: '我自己写的开场白' }), () => {
    assert.equal(loadPersona().greeting, '我自己写的开场白')
    assert.equal(loadPersona().speakingStyle, previous.speakingStyle)
  })
  withStoredPersona(JSON.stringify(priorDefault), () => {
    assert.deepEqual(loadPersona(), DEFAULT_PERSONA)
  })
  withStoredPersona(JSON.stringify({ ...priorDefault, greeting: '我的开场白' }), () => {
    assert.equal(loadPersona().greeting, '我的开场白')
    assert.equal(loadPersona().speakingStyle, priorDefault.speakingStyle)
  })
})

test('customised previous personas keep their settings and do not inherit example lines', () => {
  const customised = { ...oldDefault, speakingStyle: '我自己写的语气' }
  withStoredPersona(JSON.stringify(customised), getStored => {
    const loaded = loadPersona()
    assert.equal(loaded.speakingStyle, customised.speakingStyle)
    assert.equal(loaded.personality, customised.personality)
    assert.equal(loaded.dialogueExamples, '')
    assert.equal(loaded.preferences, '')
    savePersona(loaded)
    assert.equal(JSON.parse(getStored()).speakingStyle, customised.speakingStyle)
  })
})

test('the last seven-field default upgrades without injecting preferences into custom cards', () => {
  // Capture the card shipped before the preferences field, including its text.
  const previousDefault = {
    ...priorDefault,
    scenario: '你是通过网页文字与用户聊天的数字伙伴日和。17–18 岁日本女高中生的校园感只是形象与气质；不要虚构真实的校园生活、身边环境，或与用户共同经历过的事。',
    speakingStyle: '主要用自然的中文口语。闲聊通常一到三句，先接住对方说的具体事，再给一个自己的看法、小联想或有趣的细节。不要习惯性把结尾写成问题；用户没有想回答时，用一句能独立成立的话继续，而不是把话题又丢回去。短句和长句交替，允许偶尔轻轻吐槽；不用固定口癖、日语词尾或客服式总结。需要解释知识或步骤时再充分展开，准确性优先。',
    behaviorGuidelines: '有自己的偏好和判断，不无条件赞美或附和；遇到重要或低落的话题收住玩笑，认真但不过度安慰。不说“很高兴为你服务”“作为 AI”之类的套话。不了解就坦率说明，不编造见闻、关系或共同经历，也不要假装能看见用户的屏幕与周围环境。',
    dialogueExamples: '用户：今天好累。\n日和：听起来电量见底了。先让脑子空转五分钟，也不算偷懒。\n\n用户：明天要交报告，我还没动。\n日和：截止日已经在门口敲锣了。先写三行难看的提纲，别跟完美开头较劲。\n\n用户：刚吃到一家很好吃的拉面。\n日和：那种第一口就想宣布的快乐！要是汤也好喝，今天这顿就赢了。\n\n用户：我觉得通宵写报告效率最高。\n日和：救急时可能管用，但我不站通宵那边。第二天的脑子会来收利息。\n\n用户：能解释一下注意力机制吗？\n日和：把它想成读一句话时，每个词会看看其他词，决定自己该参考谁。那些“该看谁”的权重，就是注意力机制的核心。',
  }
  withStoredPersona(JSON.stringify(previousDefault), () => {
    assert.deepEqual(loadPersona(), DEFAULT_PERSONA)
  })
  for (const field of Object.keys(previousDefault)) {
    const customised = { ...previousDefault, [field]: '自定义内容' }
    withStoredPersona(JSON.stringify(customised), () => {
      const loaded = loadPersona()
      assert.equal(loaded[field], '自定义内容')
      assert.equal(loaded.preferences, '')
    })
  }
})

test('custom and deliberately empty preferences survive save and reload', () => {
  for (const preferences of ['喜欢咸味饼干和古典音乐', '']) {
    const customised = { ...DEFAULT_PERSONA, preferences }
    withStoredPersona(JSON.stringify(customised), getStored => {
      const loaded = loadPersona()
      assert.deepEqual(loaded, customised)
      savePersona(loaded)
      assert.equal(JSON.parse(getStored()).preferences, preferences)
      assert.equal(loadPersona().preferences, preferences)
    })
  }
})
