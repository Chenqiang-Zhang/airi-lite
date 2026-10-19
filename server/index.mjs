import { createServer } from 'node:http'

import { createRequestHandler, readServerConfig, rootDirectory } from './app.mjs'

const config = readServerConfig()
// Live streaming control is for the streaming machine only. The deployed demo
// never sets AIRI_LIVE; every /api/live/* request is also checked per request.
const liveEnabled = process.env.AIRI_LIVE === '1'
if (liveEnabled && !['127.0.0.1', '::1', 'localhost'].includes(config.host))
  throw new Error('AIRI_LIVE=1 requires HOST to be a loopback address')

const vite = config.production
  ? null
  : await import('vite').then(({ createServer }) => createServer({
      root: rootDirectory,
      appType: 'spa',
      server: { middlewareMode: true },
    }))

// Loaded only in live mode: the runtime reuses src/speech-sentences.ts, and a
// deployed demo syncs only server/, shared/ and dist/ (no src/).
const createLiveRuntime = liveEnabled
  ? (await import('./live/runtime.mjs')).createLiveRuntime
  : null
const handler = createRequestHandler({
  config,
  vite,
  live: createLiveRuntime ? deps => createLiveRuntime(deps) : null,
})
const server = createServer(handler)

server.listen(config.port, config.host, () => {
  console.log(`AIRI Lite running at http://${config.host}:${config.port}/airi/`)
  console.log(`DeepSeek: ${process.env.DEEPSEEK_API_KEY?.trim() ? `configured (${config.model})` : 'not configured; local fallback enabled'}`)
  if (liveEnabled)
    console.log('Live mode: enabled (stage /airi/stage.html, console /airi/console.html)')
})

if (liveEnabled) {
  // Close open stage streams first so server.close() is not held open by
  // them, then let the event loop drain instead of exiting at once: an
  // aborted sentence purchase still finishes its ledger write and releases
  // the ledger lock. The unref'd timer only bounds a hung shutdown.
  const shutdown = async () => {
    setTimeout(() => process.exit(0), 3_000).unref()
    await handler.stop()
    server.close()
    server.closeAllConnections()
    await vite?.close()
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}
