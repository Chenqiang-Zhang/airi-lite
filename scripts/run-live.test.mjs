import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { binScript, buildSteps, parseArguments, serverArguments, serverEnvironment } from './run-live.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

test('live builds and enables live mode; --skip-build and --start do not build', () => {
  assert.deepEqual(parseArguments([]), { live: true, build: true })
  assert.deepEqual(parseArguments(['--skip-build']), { live: true, build: false })
  assert.deepEqual(parseArguments(['--start']), { live: false, build: false })
})

test('the server environment is set in Node and wins over .env.local', () => {
  const shell = { PATH: '/bin', NODE_ENV: 'development', AIRI_LIVE: '0', HOST: '127.0.0.1' }
  assert.deepEqual(serverEnvironment(shell, { live: true }),
    { PATH: '/bin', NODE_ENV: 'production', AIRI_LIVE: '1', HOST: '127.0.0.1' })
  // Same as the old `NODE_ENV=production node ...` start script.
  assert.deepEqual(serverEnvironment({ PATH: '/bin' }, { live: false }), { PATH: '/bin', NODE_ENV: 'production' })
  assert.equal(shell.NODE_ENV, 'development', 'the caller environment is not mutated')
  // Node's --env-file never overrides a variable that is already set.
  assert.deepEqual(serverArguments(), ['--env-file-if-exists=.env.local', 'server/index.mjs'])
})

test('build steps run the packages\' own JavaScript entries, never a shell shim', () => {
  const steps = buildSteps(root)
  assert.deepEqual(steps.map(step => step.label), ['vue-tsc --noEmit', 'vite build'])
  assert.equal(steps[0].args[0], join(root, 'node_modules', 'vue-tsc', 'bin', 'vue-tsc.js'))
  assert.deepEqual(steps[0].args.slice(1), ['--noEmit'])
  assert.equal(steps[1].args[0], join(root, 'node_modules', 'vite', 'bin', 'vite.js'))
  assert.deepEqual(steps[1].args.slice(1), ['build'])
  const read = () => JSON.stringify({ bin: { other: 'x.js' } })
  assert.throws(() => binScript('missing', '/nowhere', read), /has no command/)
  assert.equal(binScript('tool', '/r', () => JSON.stringify({ bin: 'cli.js' })), join('/r', 'node_modules', 'tool', 'cli.js'))
})
