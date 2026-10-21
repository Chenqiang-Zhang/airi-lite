import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { compileScript, parse } from 'vue/compiler-sfc'
import ts from 'typescript'
import * as vue from 'vue'
import * as chatTurn from './chat-turn.ts'
import * as accessCode from './access-code.ts'
import * as api from './api.ts'
import * as conversation from './conversation.ts'
import * as memory from './memory.ts'
import * as personaModule from './persona.ts'
import * as voice from './voice.ts'
import * as cloudProvider from './cloud-provider.ts'
import * as speechMode from './speech-mode.ts'
import * as delivery from './delivery.ts'
import * as chatRequest from '../shared/chat-request.mjs'

// Execute the actual SFC's compiled setup and handlers. Only browser lifecycle,
// persistence, avatar/audio and the transport boundary are replaced; the turn
// coordinator, validation, reactive messages and App handlers are production.
const source = await readFile(new URL('./App.vue', import.meta.url), 'utf8')
const { descriptor } = parse(source)
const compiled = compileScript(descriptor, { id: 'chat-turn-app-regression' })
const commonjs = ts.transpileModule(compiled.content, {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText

function createAppProbe({ streamChat, modules: overrides = {} } = {}) {
  let clock = 1000
  const requests = []
  let release
  const gate = new Promise(resolve => { release = resolve })
  const noEffect = () => {}
  const persona = {
    name: 'Test', personality: '', preferences: '', scenario: '', speakingStyle: '',
    behaviorGuidelines: '', dialogueExamples: '', greeting: '固定测试问候。',
  }
  const saved = []
  const modules = {
    vue: { ...vue, onMounted: noEffect, onUnmounted: noEffect },
    '../shared/chat-request.mjs': chatRequest,
    './access-code': accessCode,
    './chat-turn': chatTurn,
    './delivery': delivery,
    './cloud-provider': cloudProvider,
    './api': {
      ChatApiError: api.ChatApiError,
      fetchProviderStatus: () => { throw new Error('Unexpected network boundary') },
      streamChat: streamChat ?? (async (options) => {
        requests.push(options)
        await gate
        options.onDelivery('happy')
        options.onDelta('不应写入的迟到内容。')
        return { text: '不应写入的迟到内容。', truncated: false }
      }),
    },
    './cloud-speech': { fetchCloudSpeech: () => { throw new Error('Unexpected TTS boundary') } },
    './conversation': { loadConversation: () => [], saveConversation: messages => saved.push(JSON.parse(JSON.stringify(messages))), clearConversation: noEffect },
    './chat-scroll': { createChatScrollController: () => { throw new Error('Unexpected DOM mount') } },
    './avatar-context': { createAvatarContext: () => ({ current: 'neutral', sync: noEffect, beginTurn: noEffect, clear: noEffect, destroy: noEffect }) },
    './avatar-startup': { loadAvatarModule: () => { throw new Error('Unexpected avatar mount') } },
    './avatar-render-settings': { loadAvatarRenderProfile: () => 'auto', saveAvatarRenderProfile: noEffect },
    './memory': { loadUserMemory: () => '', saveUserMemory: noEffect, clearUserMemory: noEffect, proposeUserMemory: noEffect, USER_MEMORY_LIMIT: 1200 },
    './persona': { DEFAULT_PERSONA: persona, loadPersona: () => ({ ...persona }), savePersona: noEffect },
    './speech': { createSpeechController: () => { throw new Error('Unexpected audio mount') } },
    './speech-mode': { ...speechMode, loadSpeechMode: () => 'browser', readDeviceHints: () => ({}) },
    './voice': { loadVoice: () => 'zf_001', saveVoice: noEffect, VOICE_OPTIONS: [{ id: 'zf_001', label: 'test' }] },
    ...overrides,
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', 'Date', commonjs)(
    (name) => {
      assert.ok(Object.hasOwn(modules, name), `Unexpected import: ${name}`)
      return modules[name]
    }, module, module.exports, { now: () => clock },
  )
  const scope = vue.effectScope()
  const app = scope.run(() => module.exports.default.setup({}, { expose: noEffect }))
  return { app, requests, saved, release, setClock: value => (clock = value), dispose: () => scope.stop() }
}

for (const greetingAction of ['resetConversation', 'applyPersona']) {
  for (const laterClock of [1002, 10_000]) {
    test(`actual App ${greetingAction} at clock ${laterClock} keeps unique monotonic IDs and stop removes the right placeholder`, async () => {
      const probe = createAppProbe()
      try {
        const { app } = probe
        probe.setClock(laterClock)
        if (greetingAction === 'applyPersona') app.draftPersona.value.greeting = '重设测试问候。'
        app[greetingAction]()
        const greeting = app.messages.value[0]
        app.input.value = '开始回归测试。'
        const pending = app.sendMessage()

        // Check the real handler before its first async boundary.
        const ids = app.messages.value.map(message => message.id)
        assert.equal(ids.length, 3)
        assert.equal(new Set(ids).size, 3)
        assert.ok(ids.every((id, index) => index === 0 || id > ids[index - 1]))
        assert.equal(app.messages.value.at(-1).text, '')
        assert.equal(app.isGenerating.value, true)
        await vue.nextTick()
        assert.equal(probe.requests.length, 1)

        app.stopCurrentTurn()
        assert.equal(probe.requests[0].signal.aborted, true)
        assert.equal(app.isGenerating.value, false)
        assert.equal(app.interactionNotice.value, '好，我先停下。你接着说。')
        assert.equal(app.messages.value.length, 2)
        assert.equal(app.messages.value[0], greeting)
        assert.equal(greeting.interrupted, undefined)
        assert.equal(app.messages.value.filter(message => message.role === 'assistant').length, 1)

        probe.release()
        await pending
        assert.equal(app.messages.value[0], greeting)
        assert.equal(greeting.interrupted, undefined)
        assert.equal(app.messages.value.length, 2)
        assert.equal(app.isGenerating.value, false)
        assert.equal(app.messages.value.some(message => message.text.includes('迟到内容')), false)
      }
      finally { probe.release(); probe.dispose() }
    })
  }
}

test('actual App keeps a reply that errors mid-stream but marks and saves it as interrupted', async () => {
  const probe = createAppProbe({
    streamChat: async (options) => {
      options.onDelta('故事讲到一半')
      throw new api.ChatApiError('DeepSeek 流式响应中断')
    },
  })
  try {
    const { app } = probe
    app.input.value = '讲个长故事。'
    await app.sendMessage()
    const reply = app.messages.value.at(-1)
    assert.equal(reply.role, 'assistant')
    assert.equal(reply.text, '故事讲到一半')
    assert.equal(reply.interrupted, true)
    assert.equal(app.lastError.value, 'DeepSeek 流式响应中断')
    assert.equal(app.isGenerating.value, false)
    assert.equal(probe.saved.at(-1).at(-1).interrupted, true)
  }
  finally { probe.dispose() }
})

for (const providerMode of ['checking', 'fallback', 'deepseek']) {
  test(`actual App never presents a busy server as a local demo reply (provider ${providerMode})`, async () => {
    const probe = createAppProbe({
      streamChat: async () => { throw new api.ChatApiError('当前体验人数较多，请稍后再试。', 503, 'CHAT_BUSY') },
    })
    try {
      const { app } = probe
      app.providerMode.value = providerMode
      app.input.value = '在吗？'
      await app.sendMessage()
      assert.deepEqual(app.messages.value.map(message => message.role), ['assistant', 'user'])
      assert.equal(app.messages.value.some(message => message.source === 'fallback'), false)
      assert.equal(app.lastError.value, '当前体验人数较多，请稍后再试。')
      assert.equal(app.providerMode.value, providerMode)
    }
    finally { probe.dispose() }
  })
}

test('actual App uses a labelled demo reply only when the server reports DeepSeek is unconfigured', async () => {
  const probe = createAppProbe({
    streamChat: async () => {
      throw new api.ChatApiError('DeepSeek API Key 尚未配置，当前使用本地演示回复。', 503, 'DEEPSEEK_NOT_CONFIGURED')
    },
  })
  try {
    const { app } = probe
    assert.equal(app.providerMode.value, 'checking')
    app.input.value = '在吗？'
    await app.sendMessage()
    const reply = app.messages.value.at(-1)
    assert.equal(reply.role, 'assistant')
    assert.equal(reply.source, 'fallback')
    assert.ok(reply.text)
    assert.equal(app.providerMode.value, 'fallback')
  }
  finally { probe.dispose() }
})

for (const truncated of [true, false]) {
  test(`actual App ${truncated ? 'notes a length-capped reply' : 'adds no note to a complete reply'} without marking it interrupted`, async () => {
    const probe = createAppProbe({
      streamChat: async (options) => {
        options.onDelta('这段回复写到')
        return { text: '这段回复写到', truncated }
      },
    })
    try {
      const { app } = probe
      app.input.value = '多讲一点。'
      await app.sendMessage()
      const reply = app.messages.value.at(-1)
      assert.equal(reply.text, '这段回复写到')
      assert.equal(reply.interrupted, undefined)
      assert.equal(app.lastError.value, '')
      assert.equal(app.interactionNotice.value, truncated ? '这条回复达到长度上限，结尾被截断了。' : '')
    }
    finally { probe.dispose() }
  })
}

test('actual App setup, unlock and persona edits survive browser storage whose getters throw', () => {
  const previousWindow = globalThis.window
  const blocked = () => { throw new DOMException('The operation is insecure.', 'SecurityError') }
  globalThis.window = Object.defineProperties({}, {
    localStorage: { get: blocked, configurable: true },
    sessionStorage: { get: blocked, configurable: true },
  })
  let probe
  try {
    probe = createAppProbe({
      modules: { './conversation': conversation, './memory': memory, './persona': personaModule, './voice': voice },
    })
    const { app } = probe
    assert.deepEqual(app.messages.value.map(message => message.text), [personaModule.DEFAULT_PERSONA.greeting])
    assert.equal(app.userMemory.value, '')
    assert.equal(app.selectedVoice.value, voice.DEFAULT_VOICE)
    assert.equal(app.accessCode.value, '')

    app.accessDraft.value = 'demo-code-123'
    app.saveAccessCode()
    assert.equal(app.accessCode.value, 'demo-code-123')
    assert.equal(app.lastError.value, '')

    app.draftPersona.value.name = '临时名字'
    app.applyPersona()
    assert.equal(app.persona.value.name, '临时名字')
    assert.equal(app.personaOpen.value, false)
    assert.match(app.lastError.value, /未能保存/)
  }
  finally {
    probe?.dispose()
    globalThis.window = previousWindow
  }
})

for (const actFirst of [true, false]) {
  test(`actual App ${actFirst ? 'holds an act sent before any text until the speech stream exists' : 'passes an act straight to a running speech stream'}, keeps only the first and replays it`, async () => {
    const mounted = []
    const streamCalls = []
    const spoken = []
    const cloudRequests = []
    let dependencies
    const controller = {
      beginStream(...args) {
        streamCalls.push(['begin', args[1]])
        return {
          push: text => streamCalls.push(['push', text]),
          setDelivery: delivery => streamCalls.push(['delivery', delivery]),
          setAct: act => streamCalls.push(['act', act]),
          finish: () => streamCalls.push(['finish']),
          cancel: () => streamCalls.push(['cancel']),
        }
      },
      speak: (...args) => spoken.push(args),
      cancel() {},
      dispose() {},
    }
    const probe = createAppProbe({
      streamChat: async (options) => {
        options.onDelivery('soft')
        if (actFirst) options.onAct('sigh')
        options.onDelta('好吧。')
        if (!actFirst) options.onAct('sigh')
        options.onAct('laugh')
        options.onDelta('下次再说。')
        return { text: '好吧。下次再说。', truncated: false }
      },
      modules: {
        vue: { ...vue, onMounted: callback => mounted.push(callback), onUnmounted: () => {} },
        './speech': { createSpeechController: (_audio, _callbacks, deps) => { dependencies = deps; return controller } },
        './cloud-speech': { fetchCloudSpeech: async (options) => { cloudRequests.push(options); return { samples: new Float32Array(1), sampleRate: 24000, words: [] } } },
      },
    })
    try {
      const { app } = probe
      app.speechPlayer.value = {}
      await mounted[0]()
      app.input.value = '今天累吗？'
      await app.sendMessage()
      const start = actFirst ? 0 : 3
      assert.deepEqual(streamCalls, [
        ['begin', 'soft'],
        ...(actFirst ? [['act', 'sigh'], ['push', '好吧。']] : [['push', '好吧。'], ['act', 'sigh']]),
        ['push', '下次再说。'],
        ['finish'],
      ], 'the act is applied before the text that follows it, and a second act is ignored')
      const reply = app.messages.value.at(-1)
      assert.deepEqual(reply.acts, [{ start, act: 'sigh' }])
      assert.deepEqual(probe.saved.at(-1).at(-1).acts, [{ start, act: 'sigh' }])

      app.replayLastResponse()
      assert.equal(spoken.length, 1)
      assert.deepEqual(spoken[0][5], { acts: [{ start, act: 'sigh' }] })

      // The cloud request names the act only for the sentence carrying it.
      const signal = new AbortController().signal
      await dependencies.synthesizeCloud({ text: '好吧。', delivery: 'soft', act: 'sigh' }, signal)
      await dependencies.synthesizeCloud({ text: '下次再说。', delivery: 'soft' }, signal)
      assert.equal(cloudRequests[0].act, 'sigh')
      assert.equal(Object.hasOwn(cloudRequests[1], 'act'), false)
    }
    finally { probe.dispose() }
  })
}
