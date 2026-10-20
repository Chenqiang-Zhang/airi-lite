import { randomUUID } from 'node:crypto'
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// The go-live checklist. Every check is {id, ok, detail, fix}: `detail` says
// what was found and `fix` tells the host what to do, both in the console's
// language. Read-only apart from one probe file in .data/; never calls a paid
// API. "resume" is refused until every check passes, unless the host skips.
export const PROFILES = Object.freeze(['cloud', 'local-voice'])
// A ledger reservation holds its lock for milliseconds; anything older was
// left behind by a process that died mid-write (server/tts-budget.mjs).
export const STALE_LOCK_MS = 15_000
const PROBE_TIMEOUT_MS = 1_500
const CLOUD_PROVIDERS = new Set(['minimax', 'elevenlabs'])

export function resolveProfile(env = {}) {
  const raw = typeof env.AIRI_PROFILE === 'string' ? env.AIRI_PROFILE.trim() : ''
  const profile = raw || 'cloud'
  return { profile: PROFILES.includes(profile) ? profile : 'cloud', requested: profile, valid: PROFILES.includes(profile) }
}

export function countRuleTerms(rules) {
  return ['drop', 'avoid', 'crisis', 'literal', 'word']
    .reduce((total, key) => total + (Array.isArray(rules?.[key]) ? rules[key].length : 0), 0)
}

const pass = (id, detail) => ({ id, ok: true, detail, fix: null })
const fail = (id, detail, fix) => ({ id, ok: false, detail, fix })

function ago(ms) {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1_000))} 秒前`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} 分钟前`
  return `${Math.round(ms / 3_600_000)} 小时前`
}

function checkProfile({ requested, valid }) {
  return valid
    ? pass('profile', `AIRI_PROFILE=${requested}`)
    : fail('profile', `AIRI_PROFILE=${requested.slice(0, 40)} 无法识别（按 cloud 检查其余项）`,
        '在 .env.local 把 AIRI_PROFILE 设为 cloud 或 local-voice，然后重启 npm run live。')
}

function checkDeepSeek({ configured, model }) {
  return configured
    ? pass('deepseek', `已配置${model ? `（${model}）` : ''}`)
    : fail('deepseek', '没有 DEEPSEEK_API_KEY，大脑不会生成回复。',
        '在 .env.local 写入 DEEPSEEK_API_KEY=…，然后重启 npm run live。')
}

function checkSpeech(profile, health) {
  const provider = typeof health?.provider === 'string' ? health.provider : 'unavailable'
  const label = `${provider}${health?.model ? ` · ${health.model}` : ''}`
  if (profile === 'local-voice' && provider !== 'local') {
    return fail('tts', `local-voice 档位应使用本地 TTS，当前是 ${label}。`,
      '在 .env.local 设 TTS_PROVIDER=local 和 LOCAL_TTS_URL，或把 AIRI_PROFILE 改回 cloud，然后重启。')
  }
  if (profile === 'cloud' && provider === 'local') {
    return fail('tts', 'cloud 档位却选了本地 TTS。',
      '这台机器跑本地语音时把 AIRI_PROFILE 设为 local-voice；否则改回云端 TTS_PROVIDER，然后重启。')
  }
  if (health?.configured !== true) {
    const fix = profile === 'local-voice'
      ? '在 .env.local 设 TTS_PROVIDER=local、LOCAL_TTS_URL（及模型、音色），然后重启。'
      : provider === 'elevenlabs'
        ? '在 .env.local 设 ELEVENLABS_TTS_ENABLED=1、ELEVENLABS_API_KEY、ELEVENLABS_VOICE_ID、ELEVENLABS_TTS_DAILY_CHAR_LIMIT，然后重启。'
        : '在 .env.local 设 MINIMAX_TTS_ENABLED=1、MINIMAX_API_KEY、MINIMAX_VOICE_ID、MINIMAX_TTS_DAILY_CHAR_LIMIT，然后重启。'
    return fail('tts', `语音未配置（${label}），舞台不会出声。`, fix)
  }
  if (profile === 'cloud' && !CLOUD_PROVIDERS.has(provider))
    return fail('tts', `无法识别的语音服务 ${label}。`, '检查 .env.local 里的 TTS_PROVIDER，然后重启。')
  return pass('tts', `已配置（${label}${health.region ? ` · ${health.region}` : ''}）`)
}

// Any HTTP answer, even 404 or 405, means the engine's server is up. Only the
// origin is probed and only its host is shown: the URL may carry a token.
async function checkLocalTts(env, probe, timeoutMs) {
  const raw = typeof env.LOCAL_TTS_URL === 'string' ? env.LOCAL_TTS_URL.trim() : ''
  const fixUrl = '在 .env.local 设 LOCAL_TTS_URL（例如 http://127.0.0.1:9880/v1/audio/speech），然后重启。'
  if (!raw)
    return fail('local-tts', '没有 LOCAL_TTS_URL。', fixUrl)
  let url
  try { url = new URL(raw) }
  catch { return fail('local-tts', 'LOCAL_TTS_URL 不是有效网址。', fixUrl) }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return fail('local-tts', 'LOCAL_TTS_URL 只能是 http 或 https。', fixUrl)
  try {
    const response = await probe(`${url.origin}/`, {
      method: 'HEAD', redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs),
    })
    await response.body?.cancel().catch(() => {})
    return pass('local-tts', `${url.host} 可达（HTTP ${response.status}）`)
  }
  catch (error) {
    const reason = error?.name === 'TimeoutError' ? `${timeoutMs / 1_000} 秒内没有响应` : '连接失败'
    return fail('local-tts', `${url.host} ${reason}。`,
      '先启动本地 TTS 服务，确认它监听的地址和端口与 LOCAL_TTS_URL 一致（防火墙放行局域网），然后点「重新检查」。')
  }
}

// The ledgers (TTS characters, daily replies) live directly in .data/. A
// leftover `<ledger>.lock` directory makes that ledger fail closed until it
// is removed, and this process keeps treating it as unhealthy until restart.
async function checkLedger(dataDirectory, fs, now, staleLockMs) {
  if (!dataDirectory)
    return pass('ledger', '没有数据目录（测试模式，额度只记在内存里）。')
  const probe = join(dataDirectory, `.preflight-${randomUUID()}.tmp`)
  try {
    await fs.mkdir(dataDirectory, { recursive: true, mode: 0o700 })
    await fs.writeFile(probe, 'ok\n', { flag: 'wx', mode: 0o600 })
  }
  catch (error) {
    return fail('ledger', `.data 目录不可写（${error?.code ?? 'error'}），语音和回复额度会全部拒绝。`,
      '确认项目目录在本机磁盘上、当前用户有写权限（Windows 上不要放在受保护的文件夹或只读网盘里），然后重启。')
  }
  finally {
    await fs.unlink(probe).catch(() => {})
  }
  const stale = []
  try {
    for (const name of await fs.readdir(dataDirectory)) {
      if (!name.endsWith('.lock'))
        continue
      const info = await fs.stat(join(dataDirectory, name)).catch(() => null)
      const age = info ? now() - info.mtimeMs : 0
      if (info && age >= staleLockMs)
        stale.push(`${name}（${ago(age)}）`)
    }
  }
  catch (error) {
    return fail('ledger', `读不了 .data 目录（${error?.code ?? 'error'}）。`, '检查 .data 目录的权限，然后重启。')
  }
  if (stale.length) {
    return fail('ledger', `残留的账本锁：${stale.join('、')}。对应的额度会一直拒绝。`,
      '先确认没有另一个 AIRI 服务还在运行（npm run live / mock-live / dev），再停止本服务，删除 .data 里这些 .lock 文件夹，然后重新 npm run live。')
  }
  return pass('ledger', '.data 可写，没有残留的锁。')
}

function checkModeration({ loaded, problem, terms, ignored = 0 }) {
  const file = '.data/moderation/blocklist.txt'
  if (!loaded)
    return fail('moderation', '屏蔽词还在读取。', '稍等一秒再点「重新检查」。')
  if (problem === 'blocklist-unreadable')
    return fail('moderation', `${file} 读取失败，只有内置规则在生效。`, `检查 ${file} 的权限和编码（UTF-8），然后重启。`)
  if (!terms) {
    return fail('moderation', `没有主播自己的屏蔽词（${file} 不存在或为空），只有内置规则在生效。`,
      `在 ${file} 每行写一个屏蔽词（可加 drop:/avoid:/crisis: 前缀），然后重启。`)
  }
  return pass('moderation', `已载入 ${terms} 条${ignored ? `，另有 ${ignored} 条无法使用（见状态栏）` : ''}。`)
}

function checkStage(primary, stageUrl) {
  if (!primary)
    return fail('stage', '没有 OBS 舞台连接。', `在 OBS 添加浏览器源 ${stageUrl}（或用浏览器打开它）。`)
  if (!primary.ready)
    return fail('stage', '舞台已连接，还没就绪。', '稍等几秒；一直不就绪就点「刷新舞台」，或在 OBS 里对浏览器源点「刷新当前页面的缓存」。')
  return pass('stage', '舞台已连接并就绪。')
}

const AVATAR_PROBLEMS = {
  unknown: ['舞台还没上报形象状态。', '稍等几秒再点「重新检查」。'],
  loading: ['形象还在载入。', '稍等几秒再点「重新检查」；第一次载入模型会慢一些。'],
  failed: ['形象载入失败（舞台会自动重试）。', '确认 public/models/hiyori 存在且已用 npm run live 重新构建；用 Chrome 打开 stage.html?role=preview，在开发者工具的控制台看报错，然后点「刷新舞台」。'],
}

function checkAvatar(primary) {
  if (!primary)
    return fail('avatar', '等舞台连上后才能确认。', '先解决「舞台」这一项。')
  if (primary.avatar === 'ready')
    return pass('avatar', '形象已载入。')
  const [detail, fix] = AVATAR_PROBLEMS[primary.avatar] ?? AVATAR_PROBLEMS.unknown
  return fail('avatar', detail, fix)
}

function checkObs(primary) {
  if (!primary)
    return fail('obs', '等舞台连上后才能确认。', '先解决「舞台」这一项。')
  const active = primary.obs?.active
  if (active === false) {
    return fail('obs', 'OBS 源未激活（不在节目画面上），她不会开口。',
      '在 OBS 切到含舞台浏览器源的场景；确认源的「当不可见时关闭源」没有勾选。')
  }
  if (active === true)
    return pass('obs', `OBS 源已激活${primary.obs?.streaming === true ? '，正在推流' : ''}。`)
  return pass('obs', '没有 OBS 状态（舞台不在 OBS 里，例如用直播姬采集浏览器窗口），按已激活处理。')
}

// Runs every check; never throws. `stage` is the stage bus summary's primary
// (or null), `speech` the speech handler's health().
export async function runPreflight({
  env = {},
  deepseek = { configured: false, model: '' },
  speech = null,
  dataDirectory = null,
  moderation = { loaded: false, problem: null, terms: 0, ignored: 0 },
  stage = null,
  stageUrl = 'http://127.0.0.1:5173/airi/stage.html?role=obs',
  probe = fetch,
  fs = { mkdir, readdir, stat, unlink, writeFile },
  now = Date.now,
  staleLockMs = STALE_LOCK_MS,
  probeTimeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
  const selected = resolveProfile(env)
  const { profile } = selected
  const checks = [
    checkProfile(selected),
    checkDeepSeek(deepseek),
    checkSpeech(profile, speech),
    ...(profile === 'local-voice' ? [await checkLocalTts(env, probe, probeTimeoutMs)] : []),
    await checkLedger(dataDirectory, fs, now, staleLockMs),
    checkModeration(moderation),
    checkStage(stage, stageUrl),
    checkAvatar(stage),
    checkObs(stage),
  ]
  return { profile, ok: checks.every(check => check.ok), at: now(), checks }
}
