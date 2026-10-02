<script setup lang="ts">
import type { PersonaConfig } from './persona'
import { MAX_MESSAGE_CHARS, normaliseChatRequest } from '../shared/chat-request.mjs'

import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'

import { INVALID_ACCESS_CODE_MESSAGE, isValidAccessCode } from './access-code'
import { ChatApiError, fetchProviderStatus, streamChat } from './api'
import { fetchCloudSpeech } from './cloud-speech'
import { clearConversation, loadConversation, saveConversation } from './conversation'
import type { ConversationMessage } from './conversation'
import { createChatScrollController } from './chat-scroll'
import { createAssistantMessage, interruptAssistantMessage } from './chat-turn'
import type { AvatarActivity } from './avatar-performance'
import { createAvatarContext } from './avatar-context'
import { chooseDelivery } from './delivery'
import type { Delivery } from './delivery'
import { mountHiyori } from './live2d'
import { clearUserMemory, loadUserMemory, proposeUserMemory, saveUserMemory, USER_MEMORY_LIMIT } from './memory'
import { DEFAULT_PERSONA, loadPersona, savePersona } from './persona'
import { createSpeechController } from './speech'
import type { VoiceState } from './speech'
import { loadSpeechMode, readDeviceHints, resolveSpeechMode, saveSpeechMode } from './speech-mode'
import type { SpeechEngine, SpeechMode } from './speech-mode'
import type { DeliveryCue } from './speech-sentences'
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
const composerFocused = ref(false)
const composerInput = ref<HTMLInputElement | null>(null)
const messagesViewport = ref<HTMLElement | null>(null)
const chatSettings = ref<HTMLDetailsElement | null>(null)
const hasUnreadReply = ref(false)
const isSpeaking = ref(false)
const isPreparingSpeech = ref(false)
const activeDelivery = ref<Delivery>('neutral')
const voiceState = ref<VoiceState>('idle')
const voiceProblem = ref('')
const audioAvailable = ref(false)
const speechPlayer = ref<HTMLAudioElement | null>(null)
const isGenerating = ref(false)
const avatarActivity = computed<AvatarActivity>(() => isSpeaking.value ? 'speaking' : (isGenerating.value || isPreparingSpeech.value) ? 'thinking' : composerFocused.value ? 'attentive' : 'idle')
const personaOpen = ref(false)
const memoryOpen = ref(false)
const voiceOpen = ref(false)
const voiceSettingsError = ref('')
const selectedVoice = ref<VoiceId>(loadVoice())
const draftVoice = ref<VoiceId>(selectedVoice.value)
const activeVoice = ref<VoiceId>(selectedVoice.value)
const deviceHints = readDeviceHints()
const selectedSpeechMode = ref<SpeechMode>(loadSpeechMode())
const draftSpeechMode = ref<SpeechMode>(selectedSpeechMode.value)
const cloudAvailable = ref(false)
const cloudModel = ref('speech-2.8-turbo')
const speechPolicy = computed(() => resolveSpeechMode(selectedSpeechMode.value, deviceHints, cloudAvailable.value))
const draftSpeechPolicy = computed(() => resolveSpeechMode(draftSpeechMode.value, deviceHints, cloudAvailable.value))
const activeSpeechEngine = ref<SpeechEngine>(speechPolicy.value.engine)
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
const avatarContext = createAvatarContext({ onChange: delivery => live2d?.setDelivery(delivery) })
const avatarMountController = new AbortController()
let viewDisposed = false
let latestMouth: { opening: number | null, form: number } = { opening: 0, form: 0 }
let speech: ReturnType<typeof createSpeechController> | null = null
let chatScroll: ReturnType<typeof createChatScrollController> | null = null
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
  idle: speechPolicy.value.engine === 'local' ? '免费本地声线 · 首次需下载约 330 MB'
    : speechPolicy.value.engine === 'cloud' ? `MiniMax · ${cloudModel.value} · 服务端固定声线`
      : '轻量浏览器语音 · 无需下载 Kokoro',
  loading: '正在载入免费本地声线，首次需下载约 330 MB…',
  ready: `Kokoro ${isSpeaking.value ? activeVoiceLabel.value : selectedVoiceLabel.value} · 音频驱动口型`,
  fallback: '当前设备使用浏览器朗读 · 音频驱动口型暂不可用',
  browser: '轻量浏览器语音 · 系统声线 · 简化说话动画',
  cloud: `MiniMax · ${cloudModel.value} · 服务端固定声线 · 音频驱动口型`,
})[voiceState.value])

const fallbackReplies = [
  'DeepSeek 还没有连接好，所以这次是我的本地演示回复。配置 API Key 后，我就能根据完整人格与你交流了。',
  '我现在处于本地降级模式。你仍然可以测试文字与朗读流程，但真正的内容生成需要 DeepSeek。',
  '这句话暂时没有经过大模型思考。等 DeepSeek 连接完成后，我会用自己的性格认真回答你。',
]

onMounted(async () => {
  if (messagesViewport.value)
    chatScroll = createChatScrollController(messagesViewport.value, { onUnread: value => (hasUnreadReply.value = value) })
  if (!speechPlayer.value)
    return
  speech = createSpeechController(speechPlayer.value, {
    onState: state => (voiceState.value = state),
    onPlaying: playing => (isSpeaking.value = playing),
    onPreparing: preparing => (isPreparingSpeech.value = preparing),
    onDelivery: delivery => (activeDelivery.value = delivery),
    onMouth: (opening, form) => {
      latestMouth = { opening, form }
      live2d?.setMouth(opening, form)
    },
    onAudioReady: ready => (audioAvailable.value = ready),
    onProblem: message => (voiceProblem.value = message),
  }, {
    synthesizeCloud: (sentence, signal) => fetchCloudSpeech({
      text: sentence.text, delivery: sentence.delivery, accessCode: accessCode.value, signal,
    }),
  })
  refreshProviderStatus()
  if (!modelStage.value)
    return
  try {
    const avatar = await mountHiyori(modelStage.value, { signal: avatarMountController.signal, deviceHints })
    if (viewDisposed) {
      avatar.destroy()
      return
    }
    live2d = avatar
    live2d.setMouth(latestMouth.opening, latestMouth.form)
    syncAvatarActivity()
    modelStatus.value = ''
  }
  catch (error) {
    if (viewDisposed || avatarMountController.signal.aborted) return
    console.error('Live2D load failed', error)
    modelStatus.value = 'Live2D 加载失败，请刷新页面重试。'
  }
})
onUnmounted(() => {
  viewDisposed = true
  avatarMountController.abort()
  chatScroll?.destroy()
  activeController.value?.abort()
  speech?.dispose()
  avatarContext.destroy()
  live2d?.destroy()
  live2d = null
})
function syncAvatarActivity() {
  live2d?.setActivity(avatarActivity.value)
  avatarContext.sync({
    speaking: isSpeaking.value,
    waiting: isGenerating.value || isPreparingSpeech.value,
    spokenDelivery: activeDelivery.value,
  })
  // Also sync a late-mounted model when the cue itself has not changed.
  live2d?.setDelivery(avatarContext.current)
}
watch([avatarActivity, activeDelivery, isGenerating, isPreparingSpeech], syncAvatarActivity)
watch(() => [messages.value.length, messages.value.at(-1)?.id, messages.value.at(-1)?.text], () => chatScroll?.notifyContentChanged(), { flush: 'post' })

function closeChatSettings() {
  if (chatSettings.value)
    chatSettings.value.open = false
}

function jumpToLatest() {
  chatScroll?.jumpToLatest()
}

async function refreshProviderStatus() {
  try {
    const status = await fetchProviderStatus()
    providerModel.value = status.model
    providerMode.value = status.configured ? 'deepseek' : 'fallback'
    accessProtected.value = status.accessProtected
    cloudAvailable.value = status.speech?.configured === true && status.speech.provider === 'minimax'
    if (cloudAvailable.value && status.speech)
      cloudModel.value = status.speech.model
  }
  catch {
    providerMode.value = 'fallback'
    cloudAvailable.value = false
  }
}

function speak(text: string, delivery: Delivery = 'neutral', cues: DeliveryCue[] = []) {
  activeVoice.value = selectedVoice.value
  activeSpeechEngine.value = speechPolicy.value.engine
  void speech?.speak(text, delivery, selectedVoice.value, cues, activeSpeechEngine.value)
}

function replayLastResponse() {
  const message = messages.value.filter(item => item.role === 'assistant').at(-1)
  if (message?.text) {
    const previousUser = messages.value.filter(item => item.role === 'user').at(-1)
    speak(message.text, message.delivery ?? chooseDelivery(previousUser?.text ?? '', message.text), message.deliveryCues)
  }
}

async function sendMessage() {
  const text = input.value.trim()
  if (!text || isGenerating.value)
    return
  if (text.length > MAX_MESSAGE_CHARS) {
    lastError.value = `消息太长，请缩短到 ${MAX_MESSAGE_CHARS} 字符以内。`
    return
  }
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

  let chatRequest: ReturnType<typeof normaliseChatRequest>
  try {
    chatRequest = normaliseChatRequest({
      messages: [
        ...messages.value.filter(message => message.source !== 'fallback').map(message => ({ role: message.role, content: message.text })),
        { role: 'user', content: text },
      ],
      persona: persona.value,
      userMemory: userMemory.value,
    })
  }
  catch (error) {
    lastError.value = error instanceof Error ? error.message : '聊天内容过大，请精简后再发送。'
    return
  }

  speech?.cancel()
  avatarContext.beginTurn(text)

  lastError.value = ''
  interactionNotice.value = ''
  const userMessage: Message = { id: Date.now(), role: 'user', text }
  messages.value.push(userMessage)
  chatScroll?.jumpToLatest()
  live2d?.acknowledge()
  input.value = ''
  await nextTick()

  const assistantMessage = createAssistantMessage(Date.now() + 1)
  messages.value.push(assistantMessage)

  isGenerating.value = true
  const controller = new AbortController()
  activeController.value = controller
  activeAssistantId.value = assistantMessage.id
  const speechStream: { current: ReturnType<ReturnType<typeof createSpeechController>['beginStream']> | null } = { current: null }
  let chatSucceeded = false
  let latestDelivery: Delivery | undefined
  const turnVoice = selectedVoice.value
  const turnSpeechEngine = speechPolicy.value.engine

  try {
    await streamChat({
      messages: chatRequest.messages,
      persona: chatRequest.persona,
      userMemory: chatRequest.userMemory,
      accessCode: accessCode.value,
      signal: controller.signal,
      onDelivery: (delivery) => {
        if (controller.signal.aborted || activeController.value !== controller)
          return
        assistantMessage.delivery ??= delivery
        latestDelivery = delivery
        assistantMessage.deliveryCues ??= []
        assistantMessage.deliveryCues.push({ start: assistantMessage.text.length, delivery })
        speechStream.current?.setDelivery(delivery)
      },
      onDelta: (chunk) => {
        if (controller.signal.aborted || activeController.value !== controller)
          return
        assistantMessage.text += chunk
        assistantMessage.source = 'deepseek'
        if (!speechStream.current && speech) {
          activeVoice.value = turnVoice
          activeSpeechEngine.value = turnSpeechEngine
          speechStream.current = speech.beginStream(text, latestDelivery, turnVoice, turnSpeechEngine)
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
      speak(assistantMessage.text, assistantMessage.delivery, assistantMessage.deliveryCues)
    }
  }
}

function openPersonaEditor() {
  closeChatSettings()
  draftPersona.value = { ...persona.value }
  personaOpen.value = true
}

function applyPersona() {
  if (isGenerating.value)
    return
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
  closeChatSettings()
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
  closeChatSettings()
  draftVoice.value = selectedVoice.value
  draftSpeechMode.value = selectedSpeechMode.value
  voiceSettingsError.value = ''
  voiceOpen.value = true
}

function previewVoice(voice: VoiceId) {
  if (isGenerating.value) return
  activeDelivery.value = 'neutral'
  activeVoice.value = voice
  activeSpeechEngine.value = 'local'
  void speech?.speak('嗨，我是日和。今天想听你说一件小事，也可以让我先讲个奇怪的想法。', 'neutral', voice, [], 'local')
}

function previewSpeechMode() {
  if (isGenerating.value) return
  voiceSettingsError.value = ''
  const engine = draftSpeechPolicy.value.engine
  if (engine === 'cloud' && accessProtected.value && !accessCode.value) {
    voiceSettingsError.value = '请先在设置中保存体验码，再试听云端语音。'
    lastError.value = voiceSettingsError.value
    return
  }
  activeVoice.value = draftVoice.value
  activeSpeechEngine.value = engine
  void speech?.speak('诶，你终于来了！我刚才还在想，今天要不要偷偷多吃一块蛋糕。', 'bright', draftVoice.value, [], engine)
}

function applyVoice() {
  if (isGenerating.value) return
  voiceSettingsError.value = ''
  try {
    selectedSpeechMode.value = saveSpeechMode(draftSpeechMode.value)
    selectedVoice.value = saveVoice(draftVoice.value)
    lastError.value = ''
    voiceOpen.value = false
  }
  catch {
    voiceSettingsError.value = '语音设置未能全部保存，请检查浏览器本地存储；草稿已保留。'
    lastError.value = voiceSettingsError.value
  }
}

function stopCurrentTurn() {
  live2d?.clearReaction()
  const controller = activeController.value
  if (controller) {
    controller.abort()
    activeController.value = null
    isGenerating.value = false
    messages.value = interruptAssistantMessage(messages.value, activeAssistantId.value)
    activeAssistantId.value = null
    saveConversation(messages.value)
  }
  speech?.cancel()
  avatarContext.clear()
  voiceProblem.value = ''
  lastError.value = ''
  interactionNotice.value = '好，我先停下。你接着说。'
  composerInput.value?.focus()
}

function resetConversation() {
  closeChatSettings()
  live2d?.clearReaction()
  activeController.value?.abort()
  activeController.value = null
  activeAssistantId.value = null
  speech?.cancel()
  avatarContext.clear()
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
  chatScroll?.jumpToLatest()
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
        {{ isSpeaking ? '正在朗读' : isGenerating ? '正在思考' : isPreparingSpeech ? '正在准备语音' : providerLabel }}
      </div>
    </section>

    <section class="conversation">
      <header>
        <div>
          <p class="eyebrow">CONVERSATION</p>
          <h1>和 {{ characterName }} 聊聊</h1>
        </div>
        <div class="header-actions">
          <button v-if="isGenerating || isSpeaking || isPreparingSpeech" class="voice-button stop-button" type="button" @click="stopCurrentTurn">
            停下
          </button>
          <button class="voice-button" type="button" title="朗读最后一条回复" :disabled="isGenerating" @click="replayLastResponse">
            朗读
          </button>
          <details ref="chatSettings" class="chat-settings" @keydown.esc="closeChatSettings">
            <summary class="voice-button">设置</summary>
            <div class="chat-settings-menu" role="group" aria-label="聊天设置">
              <button type="button" @click="openPersonaEditor">角色人格</button>
              <button type="button" @click="openMemoryEditor">个人记忆{{ userMemory ? ' · 已保存' : '' }}</button>
              <button type="button" :disabled="isGenerating" @click="openVoiceEditor">选择声线</button>
              <button type="button" @click="resetConversation">清空当前对话</button>
            </div>
          </details>
        </div>
      </header>

      <div class="chat-history">
      <div ref="messagesViewport" class="messages" aria-live="polite" tabindex="0" aria-label="聊天记录">
        <article v-for="message in messages" :key="message.id" class="message" :class="[message.role, { generating: isGenerating && message.role === 'assistant' && !message.text }]">
          <span>{{ message.role === 'assistant' ? characterName : 'You' }}{{ message.source === 'fallback' ? ' · 本地演示' : '' }}{{ message.role === 'assistant' && message.interrupted ? ' · 已停下' : '' }}</span>
          <p v-if="message.text">{{ message.text }}</p>
          <p v-else class="typing"><i /><i /><i /></p>
          <button v-if="message.role === 'user' && message.text" class="remember-button" type="button" aria-label="把这条消息加入记忆草稿" @click="rememberMessage(message)">记住这句…</button>
        </article>
      </div>
      <button v-if="hasUnreadReply" class="latest-button" type="button" @click="jumpToLatest">回到最新 ↓</button>
      </div>

      <form v-if="accessProtected && !accessCode" class="access-form" @submit.prevent="saveAccessCode">
        <label for="access-code">输入体验码后开始聊天</label>
        <div>
          <input id="access-code" v-model="accessDraft" type="password" autocomplete="off" placeholder="体验码">
          <button type="submit" :disabled="!accessDraft.trim()">解锁</button>
        </div>
      </form>

      <form class="composer" @submit.prevent="sendMessage">
        <input ref="composerInput" v-model="input" :maxlength="MAX_MESSAGE_CHARS" :disabled="accessProtected && !accessCode" :aria-label="`发送给 ${characterName} 的消息`" autocomplete="off" :placeholder="isGenerating ? '可以先写下一句，停下后发送……' : '输入一段文字……'" @focus="composerFocused = true" @blur="composerFocused = false">
        <button type="submit" :disabled="isGenerating || !input.trim() || (accessProtected && !accessCode)">
          {{ isGenerating ? '生成中' : '发送' }}
        </button>
      </form>

      <p v-if="lastError || interactionNotice || providerMode !== 'deepseek'" class="notice" :class="{ error: lastError }">
        {{ lastError || interactionNotice || (providerMode === 'deepseek' ? '回复由 DeepSeek 生成，完整句子会逐步朗读；可点击角色互动。' : '尚未配置 DeepSeek Key，当前会使用明确标注的本地回复。') }}
      </p>
      <p v-if="voiceProblem || voiceState === 'loading'" class="voice-notice" role="status">{{ voiceProblem || voiceLabel }}</p>
      <details class="connection-info">
        <summary>连接与说明 · {{ providerMode === 'deepseek' ? providerModel : providerLabel }}</summary>
        <div>
          <p>{{ providerLabel }} · 回复由模型生成，完整句子会逐步朗读；可点击角色互动。</p>
          <p>当前标签页保留最近 160 条对话；长文优先保留最近完整回合。「清空」不删你主动保存的记忆。</p>
          <p>{{ voiceLabel }} · <a href="https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh" target="_blank" rel="noopener noreferrer">开源模型</a></p>
        </div>
      </details>
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

        <p class="persona-intro">写下日和的性格、稳定偏好和说话习惯。她会在相关的话题里自然带出这些特点。</p>

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
            <span>稳定偏好与小习惯</span>
            <textarea v-model="draftPersona.preferences" rows="4" maxlength="2000" placeholder="例如：喜欢草莓味、轻快的音乐和解谜；不喜欢苦味。留空则不设置固定偏好。" />
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
            <button class="primary-button" type="submit" :disabled="isGenerating">{{ isGenerating ? '等回复写完再保存' : '保存人格' }}</button>
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

        <p class="persona-intro">自动模式按设备信息选择本地或轻量语音，绝不会自动调用云端。云端声音由服务器固定，不使用下面的本地 A/B/C 预设；这不是训练或克隆出的专属声音。</p>
        <form class="persona-form" @submit.prevent="applyVoice">
          <label class="speech-mode-field">
            <span>语音方式</span>
            <select v-model="draftSpeechMode" aria-label="语音方式">
              <option value="auto">自动 · 按设备选择</option>
              <option value="local">固定本地 · Kokoro</option>
              <option value="browser">轻量 · 浏览器语音</option>
              <option value="cloud" :disabled="!cloudAvailable">云端 · MiniMax{{ cloudAvailable ? '' : '（服务未启用）' }}</option>
            </select>
          </label>
          <p class="memory-hint">{{ draftSpeechPolicy.notice }}</p>
          <p class="memory-hint">本地 Kokoro 合成不上传朗读正文；浏览器语音可能使用系统联网声线。只有你选择云端模式时，需朗读的回复正文才会发给 MiniMax，密钥仅保存在服务器。聊天内容仍会发给 DeepSeek。</p>
          <button class="secondary-button" type="button" :disabled="isGenerating" @click="previewSpeechMode">试听当前模式</button>
          <div v-for="option in draftSpeechPolicy.engine === 'local' ? VOICE_OPTIONS : []" :key="option.id" class="voice-choice">
            <label>
              <input v-model="draftVoice" type="radio" name="hiyori-voice" :value="option.id">
              <span><strong>{{ option.label }}</strong><small>{{ option.description }}</small></span>
            </label>
            <button class="secondary-button" type="button" :aria-label="`试听${option.label}`" :disabled="isGenerating" @click="previewVoice(option.id)">试听</button>
          </div>
          <p class="memory-hint" role="status">{{ voiceProblem || voiceLabel }}</p>
          <p v-if="voiceSettingsError" class="memory-warning" role="alert">{{ voiceSettingsError }}</p>
          <div class="persona-actions">
            <button class="primary-button" type="submit" :disabled="isGenerating">保存语音设置</button>
          </div>
        </form>
      </aside>
    </div>
  </main>
</template>
