<script setup lang="ts">
import type { Delivery } from '../delivery'
import type { LiveAction, LiveState, QueueItem } from './console-api'

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
const KIND_LABELS: Record<QueueItem['kind'], string> = { danmaku: '弹幕', superchat: 'SC', host: '主播' }
const STATUS_LABELS: Record<string, string> = {
  pending: '待审', approved: '已通过', answering: '回答中', answered: '已回答', blocked: '被审核拦下',
  rejected: '已拒绝', expired: '已过期', failed: '未完成', dropped: '队列满被挤出',
}
const PAUSE_LABELS: Record<string, string> = {
  host: '主播暂停', panic: '紧急停止', strikes: '连续被审核拦下，自动暂停',
  'reply-budget': '今日回复额度用完，自动暂停', 'reply-budget-unavailable': '回复额度记录不可用，自动暂停',
  'upstream-errors': 'DeepSeek 连续出错，自动暂停',
}
const PHASE_LABELS: Record<string, string> = { idle: '空闲', generating: '正在想', speaking: '正在说', cooldown: '稍等片刻' }
const BLOCK_LABELS: Record<string, string> = {
  empty: '空回复', 'too-long': '太长', markup: '泄露了标签', url: '含链接', contact: '含联系方式',
  blocklist: '命中屏蔽词', provider: '云审核不通过', 'provider-timeout': '云审核超时', 'provider-error': '云审核出错',
}

const state = ref<LiveState | null>(null)
const offline = ref('')
const notice = ref('')
const draft = ref('')
const injectDraft = ref('')
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
const brain = computed(() => state.value?.brain ?? null)
const pauseLabel = computed(() => state.value?.pauseReason ? PAUSE_LABELS[state.value.pauseReason] ?? state.value.pauseReason : '')
const openItems = computed(() => state.value?.queue.open ?? [])
const recentItems = computed(() => state.value?.queue.recent ?? [])
const canInject = computed(() => Boolean(injectDraft.value.trim()) && !busy.value && Boolean(brain.value?.configured))
// Not while the brain is composing: its screened reply would have to be
// regenerated after this line.
const canSay = computed(() => Boolean(draft.value.trim()) && !busy.value && state.value?.control === 'running'
  && Boolean(primary.value?.ready) && !state.value?.turn && brain.value?.phase !== 'generating')
const rulesLabel = computed(() => {
  const moderation = state.value?.moderation
  if (!moderation) return ''
  if (moderation.rulesProblem === 'blocklist-unreadable') return ' · 屏蔽词文件读取失败'
  if (moderation.ignoredTerms.length) return ` · 屏蔽词有 ${moderation.ignoredTerms.length} 条无法使用：${moderation.ignoredTerms.join('、')}`
  return ''
})

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
    if (command.action === 'inject')
      injectDraft.value = ''
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

function inject() {
  if (canInject.value)
    void run({ action: 'inject', text: injectDraft.value.trim() })
}

function injectOnEnter(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229 || event.shiftKey)
    return
  event.preventDefault()
  inject()
}

function who(item: QueueItem) {
  if (item.kind === 'host') return '主播'
  return item.user?.name || '观众'
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
      <p v-if="pauseLabel" class="alert">{{ pauseLabel }}</p>
    </section>

    <section class="brain" aria-label="大脑">
      <h2>大脑</h2>
      <dl v-if="brain">
        <dt>DeepSeek</dt><dd>{{ brain.configured ? '已配置' : '未配置（不会生成回复）' }}</dd>
        <dt>状态</dt><dd>{{ PHASE_LABELS[brain.phase] ?? brain.phase }} · 上下文 {{ brain.historyRounds }} 轮</dd>
        <dt>审核</dt><dd>10 分钟内被拦 {{ brain.strikes }}/{{ brain.strikeLimit }} 次{{ rulesLabel }}</dd>
        <dt>今日额度</dt><dd>已用 {{ brain.dailyRepliesReserved ?? '未知' }}/{{ brain.dailyReplyLimit }} 次（含失败和中止的调用）</dd>
        <dt>本次启动</dt><dd>成功 {{ brain.usage.calls }} 次 · 失败或中止 {{ brain.usage.failedCalls }} 次 · 输入 {{ brain.usage.promptTokens }}（缓存 {{ brain.usage.cacheHitTokens }}）· 输出 {{ brain.usage.completionTokens }} tokens</dd>
      </dl>
      <p v-if="brain?.lastBlock" class="problem">
        上次拦下：{{ BLOCK_LABELS[brain.lastBlock.reason] ?? brain.lastBlock.reason }}{{ brain.lastBlock.term ? `（${brain.lastBlock.term}）` : '' }}
      </p>
      <p v-if="brain?.lastError" class="problem">上次出错：{{ brain.lastError.message }}</p>
    </section>

    <section class="queue" aria-label="待回答">
      <h2>待回答（{{ openItems.length }}）</h2>
      <p v-if="!openItems.length" class="muted">暂无。观众弹幕要先在这里通过，才会交给她回答。</p>
      <ul>
        <li v-for="item in openItems" :key="item.id" :data-status="item.status">
          <span class="kind" :data-kind="item.kind">{{ KIND_LABELS[item.kind] }}<template v-if="item.amountCny"> ¥{{ item.amountCny }}</template></span>
          <span class="who">{{ who(item) }}</span>
          <span class="text">{{ item.text }}</span>
          <span class="actions">
            <template v-if="item.status === 'pending'">
              <button type="button" class="primary" :disabled="busy" @click="run({ action: 'approve', itemId: item.id })">通过</button>
              <button type="button" :disabled="busy" @click="run({ action: 'reject', itemId: item.id })">拒绝</button>
            </template>
            <span v-else class="muted">{{ STATUS_LABELS[item.status] ?? item.status }}</span>
          </span>
        </li>
      </ul>
      <details v-if="recentItems.length">
        <summary>最近处理（{{ recentItems.length }}）</summary>
        <ul>
          <li v-for="item in recentItems" :key="item.id" :data-status="item.status">
            <span class="kind" :data-kind="item.kind">{{ KIND_LABELS[item.kind] }}</span>
            <span class="who">{{ who(item) }}</span>
            <span class="text">{{ item.text }}</span>
            <span class="muted">{{ STATUS_LABELS[item.status] ?? item.status }}{{ item.detail ? ` · ${item.detail}` : '' }}</span>
          </li>
        </ul>
      </details>
    </section>

    <section class="inject" aria-label="对她说">
      <h2>对她说（由大脑回答）</h2>
      <textarea v-model="injectDraft" maxlength="200" rows="2" placeholder="以主播身份和她聊一句，她会用大模型回答（回车发送）" @keydown.enter="injectOnEnter" />
      <div class="row">
        <span class="muted">{{ injectDraft.length }}/200</span>
        <button type="button" class="primary" :disabled="!canInject" @click="inject">发给她</button>
      </div>
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
      <p v-if="state?.lastHostBlock" class="problem">照读被拦下：{{ BLOCK_LABELS[state.lastHostBlock.reason] ?? state.lastHostBlock.reason }}{{ state.lastHostBlock.term ? `（${state.lastHostBlock.term}）` : '' }}</p>
    </section>

    <section class="say" aria-label="直接说">
      <h2>让她照读（不经过大模型）</h2>
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
ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
li { display: grid; grid-template-columns: max-content max-content 1fr max-content; gap: 8px; align-items: center; padding: 6px 8px; border-radius: 8px; background: #faf8f6; }
li[data-status="approved"], li[data-status="answering"] { background: #eef5ef; }
.kind { font-size: 12px; padding: 2px 8px; border-radius: 999px; background: #e9e4e0; }
.kind[data-kind="superchat"] { background: #f6dfb8; }
.kind[data-kind="host"] { background: #d9e6f5; }
.who { color: #5b5452; max-width: 9em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.text { overflow-wrap: anywhere; }
.actions { display: flex; gap: 6px; }
.actions button { padding: 4px 10px; }
details { margin-top: 8px; }
summary { cursor: pointer; color: #7a7270; }
@media (max-width: 560px) { li { grid-template-columns: max-content 1fr; } .text, .actions { grid-column: 1 / -1; } }
</style>
