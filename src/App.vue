<script setup lang="ts">
import type { PersonaConfig } from './persona'

import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'

import { ChatApiError, fetchProviderStatus, streamChat } from './api'
import { mountHiyori } from './live2d'
import { DEFAULT_PERSONA, loadPersona, savePersona } from './persona'
import { createSpeechController } from './speech'
import type { VoiceState } from './speech'

interface Message {
  id: number
  role: 'assistant' | 'user'
  text: string
}

type ProviderMode = 'checking' | 'deepseek' | 'fallback'

const persona = ref(loadPersona())
const draftPersona = ref<PersonaConfig>({ ...persona.value })
const characterName = computed(() => persona.value.name || 'Hiyori')
const input = ref('')
const isSpeaking = ref(false)
const voiceState = ref<VoiceState>('idle')
const isGenerating = ref(false)
const personaOpen = ref(false)
const providerMode = ref<ProviderMode>('checking')
const providerModel = ref('DeepSeek')
const lastError = ref('')
const modelStage = ref<HTMLElement | null>(null)
const modelStatus = ref('正在载入 Live2D 角色…')
const accessProtected = ref(false)
const accessCode = ref(sessionStorage.getItem('airi-demo-access-code') ?? '')
const accessDraft = ref(accessCode.value)
const activeController = ref<AbortController | null>(null)
let live2d: Awaited<ReturnType<typeof mountHiyori>> | null = null
let speech: ReturnType<typeof createSpeechController> | null = null
const messages = ref<Message[]>([
  {
    id: 1,
    role: 'assistant',
    text: persona.value.greeting,
  },
])

const providerLabel = computed(() => ({
  checking: '检查大脑连接…',
  deepseek: `DeepSeek · ${providerModel.value}`,
  fallback: '本地降级模式',
})[providerMode.value])

const voiceLabel = computed(() => ({
  idle: '免费本地声线 · 首次需下载约 120–160 MB',
  loading: '正在载入免费本地声线，首次可能需要一些时间…',
  ready: 'Kokoro 固定中文声线 · 音频驱动口型',
  fallback: '当前设备使用浏览器朗读 · 音频驱动口型暂不可用',
})[voiceState.value])

const fallbackReplies = [
  'DeepSeek 还没有连接好，所以这次是我的本地演示回复。配置 API Key 后，我就能根据完整人格与你交流了。',
  '我现在处于本地降级模式。你仍然可以测试文字与朗读流程，但真正的内容生成需要 DeepSeek。',
  '这句话暂时没有经过大模型思考。等 DeepSeek 连接完成后，我会用自己的性格认真回答你。',
]

onMounted(async () => {
  speech = createSpeechController({
    onState: state => (voiceState.value = state),
    onPlaying: playing => (isSpeaking.value = playing),
    onMouth: opening => live2d?.setMouthOpen(opening),
  })
  refreshProviderStatus()
  if (!modelStage.value)
    return
  try {
    live2d = await mountHiyori(modelStage.value)
    modelStatus.value = ''
  }
  catch (error) {
    console.error('Live2D load failed', error)
    modelStatus.value = 'Live2D 加载失败，请刷新页面重试。'
  }
})
onUnmounted(() => {
  activeController.value?.abort()
  speech?.dispose()
  live2d?.destroy()
})
watch(isSpeaking, value => live2d?.setSpeaking(value))

async function refreshProviderStatus() {
  try {
    const status = await fetchProviderStatus()
    providerModel.value = status.model
    providerMode.value = status.configured ? 'deepseek' : 'fallback'
    accessProtected.value = status.accessProtected
  }
  catch {
    providerMode.value = 'fallback'
  }
}

function speak(text: string) {
  void speech?.speak(text)
}

async function sendMessage() {
  const text = input.value.trim()
  if (!text || isGenerating.value)
    return
  if (accessProtected.value && !accessCode.value) {
    lastError.value = '请先输入体验码。'
    return
  }

  speech?.unlock()
  void speech?.prepare().catch(() => {})

  lastError.value = ''
  const userMessage: Message = { id: Date.now(), role: 'user', text }
  messages.value.push(userMessage)
  input.value = ''
  await nextTick()

  const requestMessages = messages.value.map(message => ({
    role: message.role,
    content: message.text,
  }))
  const assistantMessage: Message = {
    id: Date.now() + 1,
    role: 'assistant',
    text: '',
  }
  messages.value.push(assistantMessage)

  isGenerating.value = true
  const controller = new AbortController()
  activeController.value = controller

  try {
    await streamChat({
      messages: requestMessages,
      persona: persona.value,
      accessCode: accessCode.value,
      signal: controller.signal,
      onDelta: (chunk) => {
        assistantMessage.text += chunk
      },
    })
    providerMode.value = 'deepseek'
  }
  catch (error) {
    if (controller.signal.aborted)
      return

    lastError.value = error instanceof Error ? error.message : '生成回复失败'
    if (!assistantMessage.text) {
      messages.value = messages.value.filter(message => message.id !== assistantMessage.id)
      if (error instanceof ChatApiError && error.status === 401) {
        accessCode.value = ''
        sessionStorage.removeItem('airi-demo-access-code')
        messages.value = messages.value.filter(message => message.id !== userMessage.id)
        input.value = text
      }
      else if (error instanceof ChatApiError && error.status === 503 && providerMode.value === 'fallback') {
        assistantMessage.text = fallbackReplies[messages.value.length % fallbackReplies.length]
        messages.value.push(assistantMessage)
      }
    }
  }
  finally {
    const aborted = controller.signal.aborted
    isGenerating.value = false
    activeController.value = null
    if (!aborted && assistantMessage.text)
      speak(assistantMessage.text)
  }
}

function openPersonaEditor() {
  draftPersona.value = { ...persona.value }
  personaOpen.value = true
}

function applyPersona() {
  persona.value = {
    ...draftPersona.value,
    name: draftPersona.value.name.trim() || 'Hiyori',
  }
  savePersona(persona.value)
  personaOpen.value = false
}

function resetPersona() {
  draftPersona.value = { ...DEFAULT_PERSONA }
}

function resetConversation() {
  activeController.value?.abort()
  speech?.cancel()
  isGenerating.value = false
  isSpeaking.value = false
  lastError.value = ''
  messages.value = [{
    id: Date.now(),
    role: 'assistant',
    text: persona.value.greeting,
  }]
}

function saveAccessCode() {
  accessCode.value = accessDraft.value.trim()
  sessionStorage.setItem('airi-demo-access-code', accessCode.value)
  lastError.value = ''
}
</script>

<template>
  <main class="shell">
    <section class="stage" aria-label="Live2D character stage">
      <div class="brand">
        <span class="brand-mark">A</span>
        <div>
          <p>AIRI Lite</p>
          <span>your little digital companion</span>
        </div>
      </div>

      <div ref="modelStage" class="model-stage" />
      <p v-if="modelStatus" class="model-status">{{ modelStatus }}</p>
      <a class="model-credit" href="https://www.live2d.com/en/learn/sample/momose-hiyori/" target="_blank" rel="noopener noreferrer">桃濑日和 © Live2D Inc. · 插画 Kani Biimu</a>

      <div class="status-pill" :class="providerMode">
        <span class="status-dot" />
        {{ isSpeaking ? '正在朗读' : isGenerating ? '正在思考' : providerLabel }}
      </div>
    </section>

    <section class="conversation">
      <header>
        <div>
          <p class="eyebrow">CONVERSATION</p>
          <h1>和 {{ characterName }} 聊聊</h1>
          <span class="provider-badge" :class="providerMode">{{ providerLabel }}</span>
        </div>
        <div class="header-actions">
          <button class="voice-button" type="button" @click="resetConversation">
            清空
          </button>
          <button class="voice-button" type="button" @click="openPersonaEditor">
            人格
          </button>
          <button class="voice-button" type="button" title="朗读最后一条回复" @click="speak(messages.filter(message => message.role === 'assistant').at(-1)?.text ?? '')">
            朗读
          </button>
        </div>
      </header>

      <div class="messages" aria-live="polite">
        <article v-for="message in messages" :key="message.id" class="message" :class="[message.role, { generating: isGenerating && message.role === 'assistant' && !message.text }]">
          <span>{{ message.role === 'assistant' ? characterName : 'You' }}</span>
          <p v-if="message.text">{{ message.text }}</p>
          <p v-else class="typing"><i /><i /><i /></p>
        </article>
      </div>

      <form v-if="accessProtected && !accessCode" class="access-form" @submit.prevent="saveAccessCode">
        <label for="access-code">输入体验码后开始聊天</label>
        <div>
          <input id="access-code" v-model="accessDraft" type="password" autocomplete="off" placeholder="体验码">
          <button type="submit" :disabled="!accessDraft.trim()">解锁</button>
        </div>
      </form>

      <form class="composer" @submit.prevent="sendMessage">
        <input v-model="input" :disabled="isGenerating || (accessProtected && !accessCode)" :aria-label="`发送给 ${characterName} 的消息`" autocomplete="off" placeholder="输入一段文字……">
        <button type="submit" :disabled="isGenerating || !input.trim() || (accessProtected && !accessCode)">
          {{ isGenerating ? '生成中' : '发送' }}
        </button>
      </form>

      <p class="notice" :class="{ error: lastError }">
        {{ lastError || (providerMode === 'deepseek' ? '回复由 DeepSeek 生成，完成后会自动朗读；可点击角色互动。' : '尚未配置 DeepSeek Key，当前会使用明确标注的本地回复。') }}
      </p>
      <p class="voice-notice" role="status">{{ voiceLabel }} · <a href="https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh" target="_blank" rel="noopener noreferrer">开源模型</a></p>
    </section>

    <div v-if="personaOpen" class="persona-backdrop" @click.self="personaOpen = false">
      <aside class="persona-panel" aria-label="人格设置">
        <div class="persona-heading">
          <div>
            <p class="eyebrow">CHARACTER CARD</p>
            <h2>角色人格</h2>
          </div>
          <button class="close-button" type="button" aria-label="关闭" @click="personaOpen = false">×</button>
        </div>

        <p class="persona-intro">参考 AIRI Character Card 的分层方式。这里保存的是人格倾向，不是要求模型机械执行的固定台词。</p>

        <form class="persona-form" @submit.prevent="applyPersona">
          <label>
            <span>名字</span>
            <input v-model="draftPersona.name" maxlength="60">
          </label>
          <label>
            <span>人格倾向</span>
            <textarea v-model="draftPersona.personality" rows="4" maxlength="2000" />
          </label>
          <label>
            <span>背景情境</span>
            <textarea v-model="draftPersona.scenario" rows="3" maxlength="2000" />
          </label>
          <label>
            <span>表达风格</span>
            <textarea v-model="draftPersona.speakingStyle" rows="3" maxlength="2000" />
          </label>
          <label>
            <span>行为边界</span>
            <textarea v-model="draftPersona.behaviorGuidelines" rows="4" maxlength="2000" />
          </label>
          <label>
            <span>开场白</span>
            <textarea v-model="draftPersona.greeting" rows="3" maxlength="1000" />
          </label>

          <div class="persona-actions">
            <button class="secondary-button" type="button" @click="resetPersona">恢复默认</button>
            <button class="primary-button" type="submit">保存人格</button>
          </div>
        </form>
      </aside>
    </div>
  </main>
</template>
