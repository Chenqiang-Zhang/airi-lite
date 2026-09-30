<script setup lang="ts">
import type { PersonaConfig } from './persona'

import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'

import { INVALID_ACCESS_CODE_MESSAGE, isValidAccessCode } from './access-code'
import { ChatApiError, fetchProviderStatus, streamChat } from './api'
import { clearConversation, loadConversation, saveConversation } from './conversation'
import type { ConversationMessage } from './conversation'
import { chooseDelivery } from './delivery'
import type { Delivery } from './delivery'
import { mountHiyori } from './live2d'
import { clearUserMemory, loadUserMemory, proposeUserMemory, saveUserMemory, USER_MEMORY_LIMIT } from './memory'
import { DEFAULT_PERSONA, loadPersona, savePersona } from './persona'
import { createSpeechController } from './speech'
import type { VoiceState } from './speech'
import { loadVoice, saveVoice, VOICE_OPTIONS } from './voice'
import type { VoiceId } from './voice'

interface Message extends ConversationMessage {
  id: number
}

type ProviderMode = 'checking' | 'deepseek' | 'fallback'

const persona = ref(loadPersona())
const draftPersona = ref<PersonaConfig>({ ...persona.value })
const characterName = computed(() => persona.value.name || 'Hiyori')
const input = ref('')
const isSpeaking = ref(false)
const activeDelivery = ref<Delivery>('neutral')
const voiceState = ref<VoiceState>('idle')
const voiceProblem = ref('')
const audioAvailable = ref(false)
const speechPlayer = ref<HTMLAudioElement | null>(null)
const isGenerating = ref(false)
const personaOpen = ref(false)
const memoryOpen = ref(false)
const voiceOpen = ref(false)
const selectedVoice = ref<VoiceId>(loadVoice())
const draftVoice = ref<VoiceId>(selectedVoice.value)
const activeVoice = ref<VoiceId>(selectedVoice.value)
const userMemory = ref(loadUserMemory())
const draftUserMemory = ref(userMemory.value)
const memoryDraftWarning = ref('')
const providerMode = ref<ProviderMode>('checking')
const providerModel = ref('DeepSeek')
const lastError = ref('')
const interactionNotice = ref('')
const modelStage = ref<HTMLElement | null>(null)
const modelStatus = ref('正在载入 Live2D 角色…')
const accessProtected = ref(false)
const savedAccessCode = sessionStorage.getItem('airi-demo-access-code') ?? ''
const accessCode = ref(isValidAccessCode(savedAccessCode) ? savedAccessCode : '')
const accessDraft = ref(savedAccessCode)
if (savedAccessCode && !accessCode.value) {
  sessionStorage.removeItem('airi-demo-access-code')
  lastError.value = INVALID_ACCESS_CODE_MESSAGE
}
const activeController = ref<AbortController | null>(null)
const activeAssistantId = ref<number | null>(null)
let live2d: Awaited<ReturnType<typeof mountHiyori>> | null = null
let speech: ReturnType<typeof createSpeechController> | null = null
const restoredMessages = loadConversation()
const messages = ref<Message[]>(restoredMessages.length
  ? restoredMessages.map((message, index) => ({ ...message, id: index + 1 }))
  : [{ id: 1, role: 'assistant', text: persona.value.greeting }])

const providerLabel = computed(() => ({
  checking: '检查大脑连接…',
  deepseek: `DeepSeek · ${providerModel.value}`,
  fallback: '本地降级模式',
})[providerMode.value])

const selectedVoiceLabel = computed(() => VOICE_OPTIONS.find(option => option.id === selectedVoice.value)?.label ?? '声线 A')
const activeVoiceLabel = computed(() => VOICE_OPTIONS.find(option => option.id === activeVoice.value)?.label ?? selectedVoiceLabel.value)

const voiceLabel = computed(() => ({
  idle: '免费本地声线 · 首次需下载约 330 MB',
  loading: '正在载入免费本地声线，首次需下载约 330 MB…',
  ready: `Kokoro ${isSpeaking.value ? activeVoiceLabel.value : selectedVoiceLabel.value} · 音频驱动口型`,
  fallback: '当前设备使用浏览器朗读 · 音频驱动口型暂不可用',
})[voiceState.value])

const fallbackReplies = [
  'DeepSeek 还没有连接好，所以这次是我的本地演示回复。配置 API Key 后，我就能根据完整人格与你交流了。',
  '我现在处于本地降级模式。你仍然可以测试文字与朗读流程，但真正的内容生成需要 DeepSeek。',
  '这句话暂时没有经过大模型思考。等 DeepSeek 连接完成后，我会用自己的性格认真回答你。',
]

onMounted(async () => {
  if (!speechPlayer.value)
    return
  speech = createSpeechController(speechPlayer.value, {
    onState: state => (voiceState.value = state),
    onPlaying: playing => (isSpeaking.value = playing),
    onMouth: (opening, form) => live2d?.setMouth(opening, form),
    onAudioReady: ready => (audioAvailable.value = ready),
    onProblem: message => (voiceProblem.value = message),
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
watch(isSpeaking, (value) => {
  live2d?.setSpeaking(value)
  live2d?.setDelivery(value ? activeDelivery.value : 'neutral')
})

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

function speak(text: string, delivery: Delivery = 'neutral') {
  activeDelivery.value = delivery
  activeVoice.value = selectedVoice.value
  void speech?.speak(text, delivery, selectedVoice.value)
}

function replayLastResponse() {
  const message = messages.value.filter(item => item.role === 'assistant').at(-1)
  if (message?.text) {
    const previousUser = messages.value.filter(item => item.role === 'user').at(-1)
    speak(message.text, message.delivery ?? chooseDelivery(previousUser?.text ?? '', message.text))
  }
}

async function sendMessage() {
  const text = input.value.trim()
  if (!text || isGenerating.value)
    return
  if (accessProtected.value && !accessCode.value) {
    lastError.value = '请先输入体验码。'
    return
  }
  if (accessCode.value && !isValidAccessCode(accessCode.value)) {
    accessDraft.value = accessCode.value
    accessCode.value = ''
    sessionStorage.removeItem('airi-demo-access-code')
    lastError.value = INVALID_ACCESS_CODE_MESSAGE
    return
  }

  speech?.cancel()
  void speech?.prepare().catch(() => {})

  lastError.value = ''
  interactionNotice.value = ''
  const userMessage: Message = { id: Date.now(), role: 'user', text }
  messages.value.push(userMessage)
  input.value = ''
  await nextTick()

  const requestMessages = messages.value.filter(message => message.source !== 'fallback').map(message => ({
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
  activeAssistantId.value = assistantMessage.id
  const speechStream: { current: ReturnType<ReturnType<typeof createSpeechController>['beginStream']> | null } = { current: null }
  let chatSucceeded = false

  try {
    await streamChat({
      messages: requestMessages,
      persona: persona.value,
      userMemory: userMemory.value,
      accessCode: accessCode.value,
      signal: controller.signal,
      onDelivery: (delivery) => {
        if (controller.signal.aborted || activeController.value !== controller)
          return
        assistantMessage.delivery = delivery
        activeDelivery.value = delivery
        if (isSpeaking.value)
          live2d?.setDelivery(delivery)
      },
      onDelta: (chunk) => {
        if (controller.signal.aborted || activeController.value !== controller)
          return
        assistantMessage.text += chunk
        assistantMessage.source = 'deepseek'
        if (!speechStream.current && speech) {
          activeVoice.value = selectedVoice.value
          speechStream.current = speech.beginStream(text, (delivery) => {
            assistantMessage.delivery = delivery
            activeDelivery.value = delivery
            if (isSpeaking.value)
              live2d?.setDelivery(delivery)
          }, assistantMessage.delivery, selectedVoice.value)
        }
        speechStream.current?.push(chunk)
      },
    })
    chatSucceeded = true
    speechStream.current?.finish()
    assistantMessage.delivery ??= chooseDelivery(text, assistantMessage.text)
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
        assistantMessage.source = 'fallback'
        messages.value.push(assistantMessage)
      }
    }
  }
  finally {
    if (!chatSucceeded)
      speechStream.current?.cancel()
    const aborted = controller.signal.aborted
    if (activeController.value === controller) {
      isGenerating.value = false
      activeController.value = null
      activeAssistantId.value = null
    }
    if (!aborted && assistantMessage.text)
      assistantMessage.delivery ??= chooseDelivery(text, assistantMessage.text)
    if (!aborted)
      saveConversation(messages.value)
    if (!aborted && assistantMessage.text && !speechStream.current) {
      speak(assistantMessage.text, assistantMessage.delivery)
    }
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
  if (messages.value.length === 1 && messages.value[0].role === 'assistant') {
    messages.value = [{ id: Date.now(), role: 'assistant', text: persona.value.greeting }]
    clearConversation()
  }
  personaOpen.value = false
}

function resetPersona() {
  draftPersona.value = { ...DEFAULT_PERSONA }
}

function openMemoryEditor() {
  draftUserMemory.value = userMemory.value
  memoryDraftWarning.value = ''
  memoryOpen.value = true
}

function rememberMessage(message: Message) {
  draftUserMemory.value = proposeUserMemory(userMemory.value, message.text)
  memoryDraftWarning.value = draftUserMemory.value === userMemory.value
    && !userMemory.value.split('\n').some(line => line.trim() === message.text.trim())
    ? '这句太长或记忆空间不足，请先精简草稿。'
    : ''
  memoryOpen.value = true
}

function applyUserMemory() {
  try {
    userMemory.value = saveUserMemory(draftUserMemory.value)
    memoryDraftWarning.value = ''
    lastError.value = ''
    memoryOpen.value = false
  }
  catch {
    lastError.value = '无法保存记忆，请检查浏览器是否允许本地存储。'
  }
}

function removeUserMemory() {
  if (!window.confirm('清除当前浏览器保存的全部个人记忆？此操作不会清空聊天记录。'))
    return
  try {
    clearUserMemory()
    userMemory.value = ''
    draftUserMemory.value = ''
    lastError.value = ''
    memoryOpen.value = false
  }
  catch {
    lastError.value = '无法清除记忆，请检查浏览器本地存储。'
  }
}

function openVoiceEditor() {
  draftVoice.value = selectedVoice.value
  voiceOpen.value = true
}

function previewVoice(voice: VoiceId) {
  activeDelivery.value = 'neutral'
  activeVoice.value = voice
  void speech?.speak('嗨，我是日和。今天想听你说一件小事，也可以让我先讲个奇怪的想法。', 'neutral', voice)
}

function applyVoice() {
  try {
    selectedVoice.value = saveVoice(draftVoice.value)
    lastError.value = ''
    voiceOpen.value = false
  }
  catch {
    lastError.value = '无法保存声线，请检查浏览器是否允许本地存储。'
  }
}

function stopCurrentTurn() {
  const controller = activeController.value
  if (controller) {
    controller.abort()
    activeController.value = null
    isGenerating.value = false
    if (activeAssistantId.value !== null)
      messages.value = messages.value.filter(message => message.id !== activeAssistantId.value)
    activeAssistantId.value = null
    saveConversation(messages.value)
  }
  speech?.cancel()
  voiceProblem.value = ''
  lastError.value = ''
  interactionNotice.value = '好，我先停下。你接着说。'
}

function resetConversation() {
  activeController.value?.abort()
  activeController.value = null
  activeAssistantId.value = null
  speech?.cancel()
  voiceProblem.value = ''
  isGenerating.value = false
  isSpeaking.value = false
  lastError.value = ''
  interactionNotice.value = ''
  messages.value = [{
    id: Date.now(),
    role: 'assistant',
    text: persona.value.greeting,
  }]
  clearConversation()
}

function saveAccessCode() {
  const code = accessDraft.value.trim()
  if (!isValidAccessCode(code)) {
    lastError.value = INVALID_ACCESS_CODE_MESSAGE
    return
  }
  accessCode.value = code
  sessionStorage.setItem('airi-demo-access-code', code)
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
          <button class="voice-button" type="button" @click="openMemoryEditor">
            记忆{{ userMemory ? ' · 已保存' : '' }}
          </button>
          <button class="voice-button" type="button" :disabled="isGenerating" @click="openVoiceEditor">
            声线
          </button>
          <button v-if="isGenerating || isSpeaking || voiceProblem === '正在生成语音…'" class="voice-button stop-button" type="button" @click="stopCurrentTurn">
            停下
          </button>
          <button class="voice-button" type="button" title="朗读最后一条回复" :disabled="isGenerating" @click="replayLastResponse">
            朗读
          </button>
        </div>
      </header>

      <div class="messages" aria-live="polite">
        <article v-for="message in messages" :key="message.id" class="message" :class="[message.role, { generating: isGenerating && message.role === 'assistant' && !message.text }]">
          <span>{{ message.role === 'assistant' ? characterName : 'You' }}{{ message.source === 'fallback' ? ' · 本地演示' : '' }}</span>
          <p v-if="message.text">{{ message.text }}</p>
          <p v-else class="typing"><i /><i /><i /></p>
          <button v-if="message.role === 'user' && message.text" class="remember-button" type="button" aria-label="把这条消息加入记忆草稿" @click="rememberMessage(message)">记住这句…</button>
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
        <input v-model="input" :disabled="accessProtected && !accessCode" :aria-label="`发送给 ${characterName} 的消息`" autocomplete="off" :placeholder="isGenerating ? '可以先写下一句，停下后发送……' : '输入一段文字……'">
        <button type="submit" :disabled="isGenerating || !input.trim() || (accessProtected && !accessCode)">
          {{ isGenerating ? '生成中' : '发送' }}
        </button>
      </form>

      <p class="notice" :class="{ error: lastError }">
        {{ lastError || interactionNotice || (providerMode === 'deepseek' ? '回复由 DeepSeek 生成，完整句子会逐步朗读；可点击角色互动。' : '尚未配置 DeepSeek Key，当前会使用明确标注的本地回复。') }}
      </p>
      <p class="memory-notice">对话只在当前标签页保留；「清空」只删对话，不删你主动保存的记忆。</p>
      <p class="voice-notice" role="status">{{ voiceProblem || voiceLabel }} · <a href="https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh" target="_blank" rel="noopener noreferrer">开源模型</a></p>
      <audio ref="speechPlayer" class="speech-player" :class="{ visible: audioAvailable }" controls preload="none" aria-label="日和语音播放器" />
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
            <span>示例对话</span>
            <textarea v-model="draftPersona.dialogueExamples" rows="8" maxlength="2000" />
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

    <div v-if="memoryOpen" class="persona-backdrop" @click.self="memoryOpen = false">
      <aside class="persona-panel memory-panel" aria-label="个人记忆设置">
        <div class="persona-heading">
          <div>
            <p class="eyebrow">ABOUT YOU</p>
            <h2>让日和记住你</h2>
          </div>
          <button class="close-button" type="button" aria-label="关闭" @click="memoryOpen = false">×</button>
        </div>

        <p class="persona-intro">只记录你主动写下或选择的称呼、偏好或约定。请先检查草稿，点击「保存记忆」后才会存入当前浏览器，并随之后的聊天发送给 DeepSeek。请不要填写密码或其他敏感信息。</p>
        <p v-if="memoryDraftWarning" class="memory-warning" role="status">{{ memoryDraftWarning }}</p>
        <form class="persona-form" @submit.prevent="applyUserMemory">
          <label>
            <span>希望日和记住什么？</span>
            <textarea v-model="draftUserMemory" rows="8" :maxlength="USER_MEMORY_LIMIT" placeholder="例如：你可以叫我小陈。我喜欢简短一点的回复，最近在学日语。" @input="memoryDraftWarning = ''" />
          </label>
          <p class="memory-hint">只在相关时参考，日和不会每轮主动提起。{{ draftUserMemory.length }}/{{ USER_MEMORY_LIMIT }}</p>
          <div class="persona-actions memory-actions">
            <button class="secondary-button" type="button" :disabled="!userMemory" @click="removeUserMemory">清除记忆</button>
            <button class="primary-button" type="submit">保存记忆</button>
          </div>
        </form>
      </aside>
    </div>

    <div v-if="voiceOpen" class="persona-backdrop" @click.self="voiceOpen = false">
      <aside class="persona-panel voice-panel" aria-label="声线设置">
        <div class="persona-heading">
          <div>
            <p class="eyebrow">VOICE</p>
            <h2>选择日和的声线</h2>
          </div>
          <button class="close-button" type="button" aria-label="关闭" @click="voiceOpen = false">×</button>
        </div>

        <p class="persona-intro">三种免费 Kokoro 中文女声使用同一个模型。用同一句话试听，再固定你喜欢的声线；这不是训练或克隆出的专属声音。试听只在当前浏览器播放，不会发送给 DeepSeek。</p>
        <form class="persona-form" @submit.prevent="applyVoice">
          <div v-for="option in VOICE_OPTIONS" :key="option.id" class="voice-choice">
            <label>
              <input v-model="draftVoice" type="radio" name="hiyori-voice" :value="option.id">
              <span><strong>{{ option.label }}</strong><small>{{ option.description }}</small></span>
            </label>
            <button class="secondary-button" type="button" :aria-label="`试听${option.label}`" @click="previewVoice(option.id)">试听</button>
          </div>
          <p class="memory-hint" role="status">{{ voiceProblem || voiceLabel }}</p>
          <div class="persona-actions">
            <button class="primary-button" type="submit">设为日和声线</button>
          </div>
        </form>
      </aside>
    </div>
  </main>
</template>
