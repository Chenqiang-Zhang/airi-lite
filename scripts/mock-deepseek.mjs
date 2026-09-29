import { createServer } from 'node:http'

const chunks = [
  '[[tone:bright]]嗨！',
  '刚才你说无聊，',
  '我先丢个小游戏。',
  'Deep',
  'Seek 这个词被拆开传过来，',
  '朗读时应该保持完整。',
  '最后再补一句，我们慢慢聊。',
]
const firstGapMs = Number(process.env.MOCK_FIRST_GAP_MS) || 6_000

const server = createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/chat/completions') {
    response.writeHead(404)
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
