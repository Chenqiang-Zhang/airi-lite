import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

import { main } from '../../scripts/bili-probe.mjs'
import { normalizeOpenLiveMessage } from './events.mjs'

const script = fileURLToPath(new URL('../../scripts/bili-probe.mjs', import.meta.url))

// The real source is only built on the missing/invalid-configuration paths;
// configured runs use a fake source factory. No test reaches the platform.
test('the probe lists missing variable names and exits non-zero before any network use', async () => {
  const errors = []
  const output = []
  const code = await main({ env: {}, argv: [], stdout: line => output.push(line), stderr: line => errors.push(line) })
  assert.equal(code, 1)
  assert.deepEqual(output, [])
  for (const name of ['BILIBILI_OPEN_ACCESS_KEY_ID', 'BILIBILI_OPEN_ACCESS_KEY_SECRET', 'BILIBILI_OPEN_APP_ID', 'BILIBILI_OPEN_CODE'])
    assert.match(errors.join('\n'), new RegExp(name))
  assert.match(errors.join('\n'), /\.env\.local/)
})

test('run as a script, it never echoes the values that were provided', async () => {
  const run = promisify(execFile)(process.execPath, [script], {
    env: { PATH: process.env.PATH, BILIBILI_OPEN_ACCESS_KEY_ID: 'PROBE-ID-VALUE-1', BILIBILI_OPEN_APP_ID: 'not-a-number-2' },
    timeout: 10_000,
  })
  const error = await run.then(() => null, value => value)
  assert.ok(error, 'the probe must exit non-zero')
  assert.equal(error.code, 1)
  assert.match(error.stderr, /BILIBILI_OPEN_ACCESS_KEY_SECRET/)
  assert.match(error.stderr, /BILIBILI_OPEN_CODE/)
  assert.match(error.stderr, /BILIBILI_OPEN_APP_ID（应为纯数字的项目 ID）/)
  assert.ok(!`${error.stdout}${error.stderr}`.includes('PROBE-ID-VALUE-1'))
  assert.ok(!`${error.stdout}${error.stderr}`.includes('not-a-number-2'))
})

function fakeSource({ startError = null } = {}) {
  const calls = []
  let options
  let releaseStop
  const source = {
    calls,
    get options() { return options },
    release: () => releaseStop?.(),
    factory(value) {
      options = value
      return {
        start: async () => {
          calls.push('start')
          if (startError)
            throw startError
        },
        stop: () => {
          calls.push('stop')
          return new Promise((resolve) => { releaseStop = resolve })
        },
        status: () => ({}),
      }
    },
  }
  return source
}

const configuredEnv = {
  BILIBILI_OPEN_ACCESS_KEY_ID: 'PROBE-KEY-ID-XYZ', BILIBILI_OPEN_ACCESS_KEY_SECRET: 'PROBE-SECRET-XYZ',
  BILIBILI_OPEN_APP_ID: '1234567890123', BILIBILI_OPEN_CODE: 'PROBECODEXYZ',
}

test('configured, the probe prints masked events and statuses and ends the game on SIGINT', async () => {
  const signals = new EventEmitter()
  const fake = fakeSource()
  const lines = []
  const running = main({ env: configuredEnv, argv: [], stdout: line => lines.push(line), stderr: line => lines.push(line),
    createSource: fake.factory, signals })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(fake.options.env, configuredEnv)
  fake.options.onStatus({ state: 'connected', roomId: 4242, hasGame: true, lastEventAgeMs: null, errorCode: null })
  const dm = JSON.parse(readFileSync(new URL('./fixtures/LIVE_OPEN_PLATFORM_DM.json', import.meta.url), 'utf8'))
  fake.options.onEvent(normalizeOpenLiveMessage(dm))
  fake.options.logger.warn(`dependency echoed ${configuredEnv.BILIBILI_OPEN_ACCESS_KEY_SECRET}`)

  signals.emit('SIGINT', 'SIGINT')
  assert.deepEqual(fake.calls, ['start', 'stop'])
  fake.release()
  assert.equal(await running, 0)
  assert.equal(signals.listenerCount('SIGINT'), 0)
  const output = lines.join('\n')
  assert.match(output, /状态：已连接.*（房间 4242）/)
  assert.match(output, /弹幕 测\*\* \[舰长\]\[小测 12\]：主播晚上好！/)
  assert.match(output, /\/v2\/app\/end/)
  assert.ok(!output.includes('测试观众甲'))
  for (const value of Object.values(configuredEnv).filter(value => !/^\d+$/.test(value)))
    assert.ok(!output.includes(value))
})

test('--json prints masked JSON, a second signal exits at once, and a failed start still stops', async () => {
  const signals = new EventEmitter()
  const fake = fakeSource()
  const lines = []
  const running = main({ env: configuredEnv, argv: ['--json'], stdout: line => lines.push(line), stderr: line => lines.push(line),
    createSource: fake.factory, signals })
  await new Promise(resolve => setImmediate(resolve))
  fake.options.onEvent({ type: 'enter', cmd: 'X', user: { name: '测试观众戊', face: 'https://face.test/a.jpg' } })
  assert.deepEqual(JSON.parse(lines[0]).user, { name: '测**', face: '[已隐藏]' })
  signals.emit('SIGTERM', 'SIGTERM')
  signals.emit('SIGINT', 'SIGINT')
  assert.equal(await running, 130)
  fake.release()

  const failing = fakeSource({ startError: Object.assign(new Error(`bad ${configuredEnv.BILIBILI_OPEN_CODE}`), { code: 7007 }) })
  const failedLines = []
  const failed = main({ env: configuredEnv, argv: [], stdout: line => failedLines.push(line), stderr: line => failedLines.push(line),
    createSource: failing.factory, signals: new EventEmitter() })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(failing.calls, ['start', 'stop'])
  failing.release()
  assert.equal(await failed, 1)
  assert.match(failedLines.join('\n'), /启动失败/)
  assert.ok(!failedLines.join('\n').includes(configuredEnv.BILIBILI_OPEN_CODE))
})
