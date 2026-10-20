import type { Delivery } from '../delivery'

export type LiveControl = 'running' | 'paused' | 'panic'

export type QueueStatus = 'pending' | 'approved' | 'answering' | 'answered' | 'blocked' | 'rejected' | 'expired' | 'failed' | 'dropped'

export interface QueueItem {
  id: string
  kind: 'danmaku' | 'superchat' | 'host'
  user: null | { openId: string, name: string, guardLevel: number, medalLevel: number, isAdmin: boolean }
  text: string
  amountCny: number
  receivedAt: number
  expiresAt: number
  status: QueueStatus
  detail?: string
}

export interface LiveState {
  control: LiveControl
  pauseReason: string | null
  mode: 'live' | 'brb'
  stage: {
    primary: null | {
      ready: boolean
      avatar: string
      obs: null | { active: boolean | null, visible: boolean | null, streaming: boolean | null }
      connectedForMs: number
      lastReportAgoMs: number | null
    }
    standby: number
    previews: number
  }
  turn: null | {
    turnId: string
    text: string
    delivery: Delivery
    origin: 'host' | 'brain'
    startedAgoMs: number
    sentencesPlanned: number
    sentencesBought: number
  }
  lastOutcome: null | { turnId: string, outcome: string, at: number, sentencesBought: number, sentencesPlanned: number }
  lastProblem: null | { message: string, at: number }
  lastHostBlock: null | { reason: string, term: string | null, at: number }
  queue: { open: QueueItem[], recent: QueueItem[] }
  brain: {
    configured: boolean
    phase: 'idle' | 'generating' | 'speaking' | 'cooldown'
    strikes: number
    strikeLimit: number
    historyRounds: number
    usage: { calls: number, failedCalls: number, promptTokens: number, completionTokens: number, cacheHitTokens: number }
    lastBlock: null | { reason: string, category: string | null, term: string | null, at: number }
    lastError: null | { message: string, at: number }
    dailyReplyLimit: number
    dailyRepliesReserved: number | null
  }
  moderation: { rulesProblem: string | null, ignoredTerms: string[], provider: boolean }
  speech: { configured: boolean, provider: string, model: string, region?: string }
}

export type PreflightCheckId = 'profile' | 'deepseek' | 'tts' | 'local-tts' | 'ledger' | 'moderation' | 'stage' | 'avatar' | 'obs'

export interface PreflightCheck {
  id: PreflightCheckId
  ok: boolean
  detail: string
  fix: string | null
}

export interface PreflightResult {
  profile: 'cloud' | 'local-voice'
  ok: boolean
  at: number
  checks: PreflightCheck[]
}

export class LiveApiError extends Error {
  readonly code: string
  readonly status: number
  // The checklist that refused a resume (LIVE_PREFLIGHT_FAILED).
  readonly preflight: PreflightResult | null

  constructor(status: number, code: string, preflight: PreflightResult | null = null) {
    super(code)
    this.status = status
    this.code = code
    this.preflight = preflight
  }
}

const base = import.meta.env?.BASE_URL ?? '/'

export async function fetchLiveState(signal?: AbortSignal): Promise<LiveState> {
  const response = await fetch(`${base}api/live/state`, { cache: 'no-store', signal })
  if (!response.ok)
    throw new LiveApiError(response.status, (await response.json().catch(() => null))?.code ?? 'LIVE_UNAVAILABLE')
  return response.json() as Promise<LiveState>
}

// Read-only: runs the go-live checklist without changing anything.
export async function fetchPreflight(signal?: AbortSignal): Promise<PreflightResult> {
  const response = await fetch(`${base}api/live/preflight`, { cache: 'no-store', signal })
  if (!response.ok)
    throw new LiveApiError(response.status, (await response.json().catch(() => null))?.code ?? 'LIVE_UNAVAILABLE')
  return response.json() as Promise<PreflightResult>
}

export type LiveAction =
  | { action: 'say', text: string, delivery: Delivery }
  | { action: 'inject', text: string }
  | { action: 'approve' | 'reject', itemId: string }
  // skipPreflight: the host resumes although the checklist failed.
  | { action: 'resume', skipPreflight?: true }
  | { action: 'stop' | 'pause' | 'panic' | 'reload-stage' }

export async function sendLiveControl(command: LiveAction): Promise<unknown> {
  const response = await fetch(`${base}api/live/control`, {
    method: 'POST',
    mode: 'same-origin',
    credentials: 'same-origin',
    redirect: 'error',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-Airi-Live': '1' },
    body: JSON.stringify(command),
  })
  const body = await response.json().catch(() => null)
  if (!response.ok)
    throw new LiveApiError(response.status, body?.code ?? 'LIVE_UNAVAILABLE', body?.preflight ?? null)
  return body
}

// Host-facing explanations for the server's stable codes.
const MESSAGES: Record<string, string> = {
  LIVE_PAUSED: '已暂停或处于紧急停止，先点「继续」。',
  LIVE_NO_STAGE: '没有已就绪的 OBS 舞台：确认 OBS 浏览器源已打开 stage.html?role=obs。',
  LIVE_TURN_ACTIVE: '上一句还没说完，先等它结束或点「停下」。',
  LIVE_INVALID_TEXT: '文字需为 1–200 字，不能包含 [[ 或 ]]。',
  LIVE_BLOCKED: '这句话没有通过输出审核（链接、联系方式、索要礼物或屏蔽词），没有说出。',
  LIVE_ITEM_NOT_FOUND: '这条消息已经处理、过期或被挤出队列。',
  LIVE_INVALID_DELIVERY: '语气无效。',
  LIVE_EMPTY: '这句话没有可朗读的正文。',
  LIVE_NOT_LOCAL: '只能在推流这台电脑本机访问控制台。',
  LIVE_BAD_HOST: '请用 127.0.0.1 或 localhost 打开控制台。',
  LIVE_UNAVAILABLE: '直播服务没有响应：确认已用 npm run live（彩排用 mock-live）启动。',
  LIVE_PREFLIGHT_FAILED: '开播预检没有全部通过，没有继续：按「开播预检」里的提示处理，或确认后点「跳过预检，仍然继续」。',
  LIVE_CONTROL_CHANGED: '预检期间又按了暂停或紧急停止，没有继续。',
}

export function describeLiveError(error: unknown): string {
  if (error instanceof LiveApiError)
    return MESSAGES[error.code] ?? `请求失败（${error.code}）`
  return '无法连接本地直播服务。'
}
