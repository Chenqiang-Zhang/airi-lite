<script setup lang="ts">
import { nextTick, ref } from 'vue'

interface Message {
  id: number
  role: 'assistant' | 'user'
  text: string
}

const characterName = 'Hiyori'
const input = ref('')
const isSpeaking = ref(false)
const messages = ref<Message[]>([
  {
    id: 1,
    role: 'assistant',
    text: '你好，我是 Hiyori。现在还只是一个很小的原型，但我已经可以陪你说说话了。',
  },
])

const demoReplies = [
  '我听见了。虽然我还在学习怎样更好地回应，但我会认真记住我们从这里开始。',
  '这件事听起来很有意思。等我的人格和记忆逐渐完善以后，也许我会给出更像自己的答案。',
  '好呀。现在先让我把这句话读给你听，之后我们再慢慢增加更多能力。',
]

function speak(text: string) {
  if (!('speechSynthesis' in window))
    return

  window.speechSynthesis.cancel()
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.lang = 'zh-CN'
  utterance.rate = 1
  utterance.onstart = () => (isSpeaking.value = true)
  utterance.onend = () => (isSpeaking.value = false)
  utterance.onerror = () => (isSpeaking.value = false)
  window.speechSynthesis.speak(utterance)
}

async function sendMessage() {
  const text = input.value.trim()
  if (!text)
    return

  messages.value.push({ id: Date.now(), role: 'user', text })
  input.value = ''

  await nextTick()
  const reply = demoReplies[messages.value.length % demoReplies.length]
  messages.value.push({ id: Date.now() + 1, role: 'assistant', text: reply })
  speak(reply)
}
</script>

<template>
  <main class="shell">
    <section class="stage" aria-label="Live2D character stage">
      <div class="brand">
        <span class="brand-mark">A</span>
        <div>
          <p>AIRI Lite</p>
          <span>local companion prototype</span>
        </div>
      </div>

      <div class="model-placeholder" :class="{ speaking: isSpeaking }">
        <div class="halo" />
        <div class="portrait">
          <span>Live2D</span>
          <strong>{{ characterName }}</strong>
          <small>模型文件将在下一步接入</small>
        </div>
      </div>

      <div class="status-pill">
        <span class="status-dot" />
        {{ isSpeaking ? '正在朗读' : '在线 · 等待输入' }}
      </div>
    </section>

    <section class="conversation">
      <header>
        <div>
          <p class="eyebrow">CONVERSATION</p>
          <h1>和 {{ characterName }} 聊聊</h1>
        </div>
        <button class="voice-button" type="button" title="朗读最后一条回复" @click="speak(messages.filter(message => message.role === 'assistant').at(-1)?.text ?? '')">
          朗读
        </button>
      </header>

      <div class="messages" aria-live="polite">
        <article v-for="message in messages" :key="message.id" class="message" :class="message.role">
          <span>{{ message.role === 'assistant' ? characterName : 'You' }}</span>
          <p>{{ message.text }}</p>
        </article>
      </div>

      <form class="composer" @submit.prevent="sendMessage">
        <input v-model="input" aria-label="发送给 Hiyori 的消息" autocomplete="off" placeholder="输入一段文字……">
        <button type="submit">发送</button>
      </form>

      <p class="notice">当前使用本地演示回复，不需要 API Key，也不会访问麦克风。</p>
    </section>
  </main>
</template>
