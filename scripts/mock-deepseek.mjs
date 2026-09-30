import { createServer } from 'node:http'

const chunks = [
  '[[tone:bright]]嗨！',
  '刚才你说无聊，',
  '我先丢个小游戏。',
  'Deep',
  'Seek 这个词被拆开传过来，',
  '朗读时应该保持完整。',
  '\n\n[[to',
  'ne:soft]]不过累了的话，',
  '我们慢慢聊就好。',
  '\n[[tone:cur',
  'ious]]你想从哪个小游戏开始？',
]
const firstGapMs = Number(process.env.MOCK_FIRST_GAP_MS) || 6_000

const server = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/chat/completions') {
    response.writeHead(404)
    return response.end()
  }

  let bytes = 0
  const body = []
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > 512_000) {
      response.writeHead(413)
      return response.end()
    }
    body.push(chunk)
  }
  try {
    const payload = JSON.parse(Buffer.concat(body).toString('utf8'))
    // Diagnostic sizes only: never log text, credentials or a saved memory.
    console.log(`Mock request: ${bytes} bytes, ${Array.isArray(payload.messages) ? payload.messages.length : 0} messages including system`)
  }
  catch {
    response.writeHead(400)
    return response.end()
  }

  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
  })

  let index = 0
  const sendNext = () => {
    if (response.destroyed)
      return
    if (index >= chunks.length) {
      response.write('data: [DONE]\n\n')
      return response.end()
    }
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[index] } }] })}\n\n`)
    index++
    setTimeout(sendNext, index === 1 ? firstGapMs : 850)
  }
  sendNext()
})

server.listen(4174, '127.0.0.1', () => {
  console.log('Mock DeepSeek listening on http://127.0.0.1:4174')
})
