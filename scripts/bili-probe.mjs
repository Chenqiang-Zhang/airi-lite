// B站直播开放平台探针：连接自己的直播间，打印规范化后的事件（昵称打码，
// 不打印任何密钥、身份码或 auth_body），Ctrl-C / SIGTERM 时先结束场次再退出。
//
//   node --env-file-if-exists=.env.local scripts/bili-probe.mjs [--json]
//
// 需要 BILIBILI_OPEN_ACCESS_KEY_ID、BILIBILI_OPEN_ACCESS_KEY_SECRET、
// BILIBILI_OPEN_APP_ID、BILIBILI_OPEN_CODE 四个环境变量（只放在 .env.local）。
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createRedactingLogger, describeEvent, maskEvent } from '../server/bilibili/redact.mjs'
import { BILIBILI_ENV_NAMES, createBilibiliSource, describeConfigProblem, readBilibiliConfig } from '../server/bilibili/source.mjs'

const STATE_TEXT = Object.freeze({
  starting: '正在开启场次…',
  connecting: '正在连接长连接…',
  connected: '已连接，等待直播间消息（按 Ctrl-C 结束）',
  reconnecting: '长连接断开，正在重连…',
  restarting: '正在重新开启场次…',
  stopping: '正在结束场次…',
  stopped: '场次已结束',
  error: '出错',
})
const time = () => new Date().toTimeString().slice(0, 8)

export async function main({ env = process.env, argv = process.argv.slice(2), stdout = console.log, stderr = console.error,
  createSource = createBilibiliSource, signals = process } = {}) {
  const config = readBilibiliConfig(env)
  if (!config.configured) {
    stderr(describeConfigProblem(config))
    return 1
  }
  const json = argv.includes('--json')
  const log = createRedactingLogger({ info: stdout, warn: stderr, error: stderr },
    () => Object.values(BILIBILI_ENV_NAMES).map(name => env[name]))
  let lastState = ''
  const source = createSource({
    env,
    logger: log,
    onEvent(event) {
      log.info(json ? JSON.stringify(maskEvent(event)) : `[${time()}] ${describeEvent(event)}`)
    },
    onStatus(status) {
      if (status.state === lastState)
        return
      lastState = status.state
      const room = status.roomId ? `（房间 ${status.roomId}）` : ''
      const code = status.errorCode ? ` 错误码 ${status.errorCode}` : ''
      log.info(`[${time()}] 状态：${STATE_TEXT[status.state] ?? status.state}${room}${code}`)
    },
  })

  return await new Promise((finish) => {
    let stopping = false
    const done = (code) => {
      signals.off('SIGINT', shutdown)
      signals.off('SIGTERM', shutdown)
      finish(code)
    }
    async function shutdown(signal) {
      if (stopping) {
        log.warn(`再次收到 ${signal}，立即退出；未结束的场次会在下次启动时自动清理。`)
        return done(130)
      }
      stopping = true
      log.info(`收到 ${signal}，正在调用 /v2/app/end 结束场次…`)
      await source.stop()
      done(0)
    }
    signals.on('SIGINT', shutdown)
    signals.on('SIGTERM', shutdown)
    source.start().catch(async (error) => {
      if (stopping)
        return
      stopping = true
      log.error(`启动失败：${error?.message ?? error}`)
      await source.stop()
      done(1)
    })
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exit(await main())
