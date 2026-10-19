import type { Delivery } from '../delivery'

export type LiveControl = 'running' | 'paused' | 'panic'

export interface LiveState {
  control: LiveControl
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
    startedAgoMs: number
    sentencesPlanned: number
    sentencesBought: number
  }
  lastOutcome: null | { turnId: string, outcome: string, at: number, sentencesBought: number, sentencesPlanned: number }
  lastProblem: null | { message: string, at: number }
  speech: { configured: boolean, provider: string, model: string, region?: string }
}

export class LiveApiError extends Error {
  readonly code: string
  readonly status: number

  constructor(status: number, code: string) {
    super(code)
    this.status = status
    this.code = code
  }
}

const base = import.meta.env?.BASE_URL ?? '/'

export async function fetchLiveState(signal?: AbortSignal): Promise<LiveState> {
  const response = await fetch(`${base}api/live/state`, { cache: 'no-store', signal })
  if (!response.ok)
    throw new LiveApiError(response.status, (await response.json().catch(() => null))?.code ?? 'LIVE_UNAVAILABLE')
  return response.json() as Promise<LiveState>
}

export type LiveAction =
  | { action: 'say', text: string, delivery: Delivery }
  | { action: 'stop' | 'pause' | 'resume' | 'panic' | 'reload-stage' }

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
    throw new LiveApiError(response.status, body?.code ?? 'LIVE_UNAVAILABLE')
  return body
}

// Host-facing explanations for the server's stable codes.
const MESSAGES: Record<string, string> = {
  LIVE_PAUSED: '已暂停或处于紧急停止，先点「继续」。',
  LIVE_NO_STAGE: '没有已就绪的 OBS 舞台：确认 OBS 浏览器源已打开 stage.html?role=obs。',
  LIVE_TURN_ACTIVE: '上一句还没说完，先等它结束或点「停下」。',
  LIVE_INVALID_TEXT: '文字需为 1–200 字，不能包含 [[ 或 ]]。',
  LIVE_INVALID_DELIVERY: '语气无效。',
  LIVE_EMPTY: '这句话没有可朗读的正文。',
  LIVE_NOT_LOCAL: '只能在推流这台电脑本机访问控制台。',
  LIVE_BAD_HOST: '请用 127.0.0.1 或 localhost 打开控制台。',
  LIVE_UNAVAILABLE: '直播服务没有响应：确认以 AIRI_LIVE=1 启动。',
}

export function describeLiveError(error: unknown): string {
  if (error instanceof LiveApiError)
    return MESSAGES[error.code] ?? `请求失败（${error.code}）`
  return '无法连接本地直播服务。'
}
