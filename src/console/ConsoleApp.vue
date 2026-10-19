<script setup lang="ts">
import type { Delivery } from '../delivery'
import type { LiveAction, LiveState } from './console-api'

import { computed, onMounted, onUnmounted, ref } from 'vue'

import { describeLiveError, fetchLiveState, sendLiveControl } from './console-api'

const DELIVERY_OPTIONS: { value: Delivery, label: string }[] = [
  { value: 'neutral', label: '平常' },
  { value: 'soft', label: '温柔' },
  { value: 'bright', label: '开心' },
  { value: 'curious', label: '好奇' },
]
const OUTCOME_LABELS: Record<string, string> = {
  played: '已播完', partial: '只播了一部分', failed: '失败', cancelled: '被取消',
  empty: '没有可读正文', stopped: '已停下', timeout: '超时未回报',
}

const state = ref<LiveState | null>(null)
const offline = ref('')
const notice = ref('')
const draft = ref('')
const delivery = ref<Delivery>('neutral')
const busy = ref(false)
let poll: ReturnType<typeof setInterval> | null = null
let inFlight: AbortController | null = null

const primary = computed(() => state.value?.stage.primary ?? null)
const stageLabel = computed(() => {
  const stage = primary.value
  if (!stage)
    return '未连接（打开 OBS 浏览器源或 stage.html?role=obs）'
  return stage.ready ? '已就绪' : '已连接，等待就绪'
})
const obsLabel = computed(() => {
  const obs = primary.value?.obs
  if (!obs)
    return '未检测到 OBS（普通浏览器舞台）'
  const flag = (value: boolean | null, yes: string, no: string) => value === null ? '未知' : value ? yes : no
  return `源${flag(obs.active, '激活', '未激活')} · ${flag(obs.visible, '可见', '隐藏')} · ${flag(obs.streaming, '推流中', '未推流')}`
})
const controlLabel = computed(() => ({ running: '运行中', paused: '已暂停', panic: '紧急停止' })[state.value?.control ?? 'running'])
const speechLabel = computed(() => {
  const speech = state.value?.speech
  if (!speech) return ''
  return `${speech.configured ? '已配置' : '未配置'} · ${speech.provider} · ${speech.model}${speech.region ? ` · ${speech.region}` : ''}`
})
const canSay = computed(() => Boolean(draft.value.trim()) && !busy.value && state.value?.control === 'running'
  && Boolean(primary.value?.ready) && !state.value?.turn)

async function refresh() {
  inFlight?.abort()
  const controller = new AbortController()
  inFlight = controller
  try {
    state.value = await fetchLiveState(controller.signal)
    offline.value = ''
  }
  catch (error) {
    if (controller.signal.aborted) return
    offline.value = describeLiveError(error)
  }
}

async function run(command: LiveAction) {
  busy.value = true
  notice.value = ''
  try {
    await sendLiveControl(command)
    if (command.action === 'say')
      draft.value = ''
  }
  catch (error) {
    notice.value = describeLiveError(error)
  }
  finally {
    busy.value = false
    void refresh()
  }
}

function say() {
  if (canSay.value)
    void run({ action: 'say', text: draft.value.trim(), delivery: delivery.value })
}

function sayOnEnter(event: KeyboardEvent) {
  // Never send while an input method is still composing (keyCode 229).
  if (event.isComposing || event.keyCode === 229 || event.shiftKey)
    return
  event.preventDefault()
  say()
}

function ago(ms: number | null | undefined) {
  if (ms === null || ms === undefined) return '—'
  return ms < 1_000 ? '刚刚' : `${Math.round(ms / 1_000)} 秒前`
}

onMounted(() => {
  void refresh()
  poll = setInterval(() => void refresh(), 1_000)
})
onUnmounted(() => {
  if (poll) clearInterval(poll)
  inFlight?.abort()
})
</script>

<template>
  <main class="console">
    <header>
      <h1>AIRI 直播控制台</h1>
      <span class="badge" :data-control="state?.control ?? 'offline'">{{ offline ? '离线' : controlLabel }}</span>
    </header>

    <p v-if="offline" class="alert">{{ offline }}</p>

    <section class="status" aria-label="状态">
      <dl>
        <dt>舞台</dt><dd>{{ stageLabel }}</dd>
        <dt>形象</dt><dd>{{ primary?.avatar ?? '—' }}</dd>
        <dt>OBS</dt><dd>{{ obsLabel }}</dd>
        <dt>其他页面</dt><dd>待命 {{ state?.stage.standby ?? 0 }} · 预览 {{ state?.stage.previews ?? 0 }}</dd>
        <dt>舞台上报</dt><dd>{{ ago(primary?.lastReportAgoMs) }}</dd>
        <dt>语音</dt><dd>{{ speechLabel }}</dd>
        <dt>画面</dt><dd>{{ state?.mode === 'brb' ? '「稍后回来」' : '正常' }}</dd>
      </dl>
    </section>

    <section class="turn" aria-label="当前回合">
      <h2>当前</h2>
      <p v-if="state?.turn">
        「{{ state.turn.text }}」 · 已取音 {{ state.turn.sentencesBought }}/{{ state.turn.sentencesPlanned }} 句 · {{ ago(state.turn.startedAgoMs) }}开始
      </p>
      <p v-else class="muted">空闲</p>
      <p v-if="state?.lastOutcome" class="muted">
        上一句：{{ OUTCOME_LABELS[state.lastOutcome.outcome] ?? state.lastOutcome.outcome }}
        （取音 {{ state.lastOutcome.sentencesBought }}/{{ state.lastOutcome.sentencesPlanned }} 句）
      </p>
      <p v-if="state?.lastProblem" class="problem">舞台提示：{{ state.lastProblem.message }}</p>
    </section>

    <section class="say" aria-label="直接说">
      <h2>让她说</h2>
      <textarea v-model="draft" maxlength="200" rows="3" placeholder="输入要说的话，回车发送（Shift+回车换行）" @keydown.enter="sayOnEnter" />
      <div class="row">
        <select v-model="delivery" aria-label="语气">
          <option v-for="option in DELIVERY_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
        <span class="muted">{{ draft.length }}/200</span>
        <button type="button" class="primary" :disabled="!canSay" @click="say">说</button>
      </div>
      <p v-if="notice" class="alert">{{ notice }}</p>
    </section>

    <section class="controls" aria-label="控制">
      <button type="button" :disabled="busy || !state?.turn" @click="run({ action: 'stop' })">停下</button>
      <button type="button" :disabled="busy || state?.control !== 'running'" @click="run({ action: 'pause' })">暂停</button>
      <button type="button" :disabled="busy || state?.control === 'running'" @click="run({ action: 'resume' })">继续</button>
      <button type="button" class="danger" :disabled="busy" @click="run({ action: 'panic' })">紧急停止</button>
      <button type="button" :disabled="busy" @click="run({ action: 'reload-stage' })">刷新舞台</button>
    </section>
  </main>
</template>

<style>
:root {
  color: #2d2a29;
  background: #f4f1ee;
  font-family: "PingFang SC", ui-sans-serif, -apple-system, BlinkMacSystemFont, sans-serif;
}
body { margin: 0; }
.console { max-width: 760px; margin: 0 auto; padding: 24px 16px 48px; display: grid; gap: 16px; }
header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
h1 { font-size: 22px; margin: 0; }
h2 { font-size: 16px; margin: 0 0 8px; }
section { background: #fff; border-radius: 12px; padding: 16px; box-shadow: 0 1px 2px rgb(0 0 0 / 6%); }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0; }
dt { color: #7a7270; }
dd { margin: 0; }
.badge { padding: 4px 12px; border-radius: 999px; background: #dfe9df; }
.badge[data-control="paused"] { background: #f3e6c8; }
.badge[data-control="panic"], .badge[data-control="offline"] { background: #f2d0cc; }
textarea { width: 100%; box-sizing: border-box; font: inherit; padding: 8px; border-radius: 8px; border: 1px solid #d8d1cd; resize: vertical; }
.row { display: flex; align-items: center; gap: 12px; margin-top: 8px; }
.row .primary { margin-left: auto; }
.controls { display: flex; flex-wrap: wrap; gap: 8px; }
button, select { font: inherit; padding: 8px 16px; border-radius: 8px; border: 1px solid #d8d1cd; background: #faf8f6; cursor: pointer; }
button:disabled { opacity: 0.5; cursor: default; }
button.primary { background: #3d6b4f; color: #fff; border-color: #3d6b4f; }
button.danger { background: #a23b2e; color: #fff; border-color: #a23b2e; }
.muted { color: #7a7270; }
.alert { color: #a23b2e; margin: 8px 0 0; }
.problem { color: #8a5a00; }
p { margin: 4px 0; }
</style>
