import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { compileScript, parse } from 'vue/compiler-sfc'
import ts from 'typescript'
import * as vue from 'vue'
import * as chatTurn from './chat-turn.ts'
import * as accessCode from './access-code.ts'
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

function createAppProbe() {
  let clock = 1000
  const requests = []
  let release
  const gate = new Promise(resolve => { release = resolve })
  const noEffect = () => {}
  const persona = {
    name: 'Test', personality: '', preferences: '', scenario: '', speakingStyle: '',
    behaviorGuidelines: '', dialogueExamples: '', greeting: '固定测试问候。',
  }
  const sessionStorage = { getItem: () => null, setItem: noEffect, removeItem: noEffect }
  const modules = {
    vue: { ...vue, onMounted: noEffect, onUnmounted: noEffect },
    '../shared/chat-request.mjs': chatRequest,
    './access-code': accessCode,
    './chat-turn': chatTurn,
    './delivery': delivery,
    './cloud-provider': cloudProvider,
    './api': {
      ChatApiError: class ChatApiError extends Error {},
      fetchProviderStatus: () => { throw new Error('Unexpected network boundary') },
      streamChat: async (options) => {
        requests.push(options)
        await gate
        options.onDelivery('bright')
        options.onDelta('不应写入的迟到内容。')
        return '不应写入的迟到内容。'
      },
    },
    './cloud-speech': { fetchCloudSpeech: () => { throw new Error('Unexpected TTS boundary') } },
    './conversation': { loadConversation: () => [], saveConversation: noEffect, clearConversation: noEffect },
    './chat-scroll': { createChatScrollController: () => { throw new Error('Unexpected DOM mount') } },
    './avatar-context': { createAvatarContext: () => ({ current: 'neutral', sync: noEffect, beginTurn: noEffect, clear: noEffect, destroy: noEffect }) },
    './avatar-startup': { loadAvatarModule: () => { throw new Error('Unexpected avatar mount') } },
    './avatar-render-settings': { loadAvatarRenderProfile: () => 'auto', saveAvatarRenderProfile: noEffect },
    './memory': { loadUserMemory: () => '', saveUserMemory: noEffect, clearUserMemory: noEffect, proposeUserMemory: noEffect, USER_MEMORY_LIMIT: 1200 },
    './persona': { DEFAULT_PERSONA: persona, loadPersona: () => ({ ...persona }), savePersona: noEffect },
    './speech': { createSpeechController: () => { throw new Error('Unexpected audio mount') } },
    './speech-mode': { ...speechMode, loadSpeechMode: () => 'browser', readDeviceHints: () => ({}) },
    './voice': { loadVoice: () => 'zf_001', saveVoice: noEffect, VOICE_OPTIONS: [{ id: 'zf_001', label: 'test' }] },
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', 'sessionStorage', 'Date', commonjs)(
    (name) => {
      assert.ok(Object.hasOwn(modules, name), `Unexpected import: ${name}`)
      return modules[name]
    }, module, module.exports, sessionStorage, { now: () => clock },
  )
  const scope = vue.effectScope()
  const app = scope.run(() => module.exports.default.setup({}, { expose: noEffect }))
  return { app, requests, release, setClock: value => (clock = value), dispose: () => scope.stop() }
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
