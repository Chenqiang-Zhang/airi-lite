import { readFileSync } from 'node:fs'

const request = JSON.parse(readFileSync(0, 'utf8'))
const accessCode = process.env.AIRI_DEMO_ACCESS_CODE
if (!accessCode)
  throw new Error('AIRI_DEMO_ACCESS_CODE is required for this smoke test')

const response = await fetch(process.env.AIRI_SMOKE_URL || 'http://127.0.0.1:3001/airi/api/chat', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Demo-Access-Code': accessCode,
  },
  body: JSON.stringify(request),
  signal: AbortSignal.timeout(90_000),
})

if (!response.ok)
  throw new Error(`Chat smoke test failed with HTTP ${response.status}`)

const body = await response.text()
let reply = ''
let delivery = null
const deliveryCues = []
for (const line of body.split('\n')) {
  if (!line.trim())
    continue
  const event = JSON.parse(line)
  if (event.type === 'error')
    throw new Error('Chat stream ended with an error')
  if (event.type === 'delta' && typeof event.content === 'string')
    reply += event.content
  if (event.type === 'delivery' && typeof event.value === 'string') {
    delivery = event.value
    deliveryCues.push({ start: reply.length, delivery })
  }
}

if (!reply.trim())
  throw new Error('Chat smoke test returned an empty reply')
if (process.env.AIRI_SMOKE_SHOW_DELIVERY === '1')
  process.stderr.write(`delivery=${delivery ?? 'missing'}\n`)
if (process.env.AIRI_SMOKE_SHOW_CUES === '1')
  process.stderr.write(`delivery cues=${JSON.stringify(deliveryCues)}\n`)
process.stdout.write(`${reply}\n`)
