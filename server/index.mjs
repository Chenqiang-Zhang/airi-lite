import { createServer } from 'node:http'

import { createRequestHandler, readServerConfig, rootDirectory } from './app.mjs'

const config = readServerConfig()
const vite = config.production
  ? null
  : await import('vite').then(({ createServer }) => createServer({
      root: rootDirectory,
      appType: 'spa',
      server: { middlewareMode: true },
    }))

const server = createServer(createRequestHandler({ config, vite }))

server.listen(config.port, config.host, () => {
  console.log(`AIRI Lite running at http://${config.host}:${config.port}/airi/`)
  console.log(`DeepSeek: ${process.env.DEEPSEEK_API_KEY?.trim() ? `configured (${config.model})` : 'not configured; local fallback enabled'}`)
})
