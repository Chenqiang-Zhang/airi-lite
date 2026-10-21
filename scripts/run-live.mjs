// Cross-platform launcher for the production server. Environment variables
// are set here in Node, not with POSIX `VAR=x cmd` syntax, so the same npm
// scripts work in cmd.exe, PowerShell, zsh and bash.
//
//   node scripts/run-live.mjs               build, then serve with AIRI_LIVE=1 (npm run live)
//   node scripts/run-live.mjs --skip-build  serve the existing dist/ with AIRI_LIVE=1
//   node scripts/run-live.mjs --start       serve dist/ without live mode (npm start)
//
// The server child loads .env.local itself (--env-file-if-exists), and a
// variable already set here wins over the file, so .env.local cannot turn
// production or live mode back off. This script never reads .env.local.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

// The JavaScript entry of a dependency's command, run with this same node:
// no shell, no .cmd shims, no PATH lookup.
export function binScript(name, directory = root, read = readFileSync) {
  const manifestPath = join(directory, 'node_modules', name, 'package.json')
  const { bin } = JSON.parse(read(manifestPath, 'utf8'))
  const relative = typeof bin === 'string' ? bin : bin?.[name]
  if (!relative)
    throw new Error(`${name} has no command`)
  return join(dirname(manifestPath), relative)
}

export function parseArguments(argv) {
  const start = argv.includes('--start')
  return { live: !start, build: !start && !argv.includes('--skip-build') }
}

// The child's environment: production always, plus AIRI_LIVE=1 for live.
// `--start` adds nothing else, exactly like the old POSIX start script.
export function serverEnvironment(environment, { live }) {
  return { ...environment, NODE_ENV: 'production', ...(live ? { AIRI_LIVE: '1' } : {}) }
}

export function buildSteps(directory = root) {
  return [
    { label: 'vue-tsc --noEmit', args: [binScript('vue-tsc', directory), '--noEmit'] },
    { label: 'vite build', args: [binScript('vite', directory), 'build'] },
  ]
}

export function serverArguments() {
  return ['--env-file-if-exists=.env.local', 'server/index.mjs']
}

function runStep({ label, args }) {
  console.log(`> ${label}`)
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0)
        resolve()
      else
        reject(new Error(`${label} failed (${signal ?? `exit ${code}`})`))
    })
  })
}

// The avatar profile is bundled; a syntax error would only show up as a
// confusing build failure, so say plainly what is wrong first.
export function checkAvatarProfile(directory = root, read = readFileSync) {
  const path = join(directory, 'src', 'avatar-profiles', 'active.json')
  try {
    JSON.parse(read(path, 'utf8'))
  }
  catch (error) {
    throw new Error(`avatar profile ${path} is not valid JSON: ${error.message}`)
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.build) {
    checkAvatarProfile()
    for (const step of buildSteps())
      await runStep(step)
  }
  const server = spawn(process.execPath, serverArguments(), {
    cwd: root,
    stdio: 'inherit',
    env: serverEnvironment(process.env, options),
  })
  // Ctrl+C reaches every process in the terminal, the server included, and
  // the server shuts down gracefully on its first SIGINT (a second one would
  // kill it before the ledgers are released). So only keep this launcher
  // alive until the server has finished; forward the signals a terminal
  // does not deliver to the whole group.
  process.on('SIGINT', () => {})
  for (const signal of ['SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      if (server.exitCode === null && server.signalCode === null)
        server.kill('SIGTERM')
    })
  }
  server.once('error', (error) => {
    console.error(error)
    process.exit(1)
  })
  server.once('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
