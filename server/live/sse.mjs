// Server-sent events to the stage pages. Zero dependencies: Node 24 has no
// built-in WebSocket server, and the stage only needs server -> page pushes
// (it reports back with small POSTs).
export function createSseChannel({
  heartbeatMs = 15_000,
  maxBufferedBytes = 256 * 1024,
  timers = { setInterval, clearInterval },
} = {}) {
  const clients = new Set()
  let heartbeat = null
  let nextId = 0

  function startHeartbeat() {
    if (heartbeat || !clients.size)
      return
    heartbeat = timers.setInterval(() => {
      for (const client of clients)
        client.write(': ping\n\n')
    }, heartbeatMs)
    // Never keep the process (or a test) alive just to ping idle pages.
    heartbeat.unref?.()
  }

  function stopHeartbeat() {
    if (heartbeat && !clients.size) {
      timers.clearInterval(heartbeat)
      heartbeat = null
    }
  }

  function open(request, response, { onClose } = {}) {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    })
    response.flushHeaders?.()
    let closed = false
    const client = {
      write(text) {
        if (closed)
          return false
        // A stalled reader (frozen OBS source) must not grow memory forever.
        if (response.writableLength > maxBufferedBytes) {
          client.close()
          return false
        }
        response.write(text)
        return true
      },
      send(event, data) {
        return client.write(`id: ${++nextId}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      },
      close() {
        if (closed)
          return
        closed = true
        clients.delete(client)
        stopHeartbeat()
        response.end()
        // Deferred: a close triggered by an overfull write happens inside a
        // publish loop; lease handover must not run in the middle of it.
        if (onClose)
          queueMicrotask(onClose)
      },
      get closed() { return closed },
    }
    clients.add(client)
    // A lost page reconnects after 2 s and obtains a fresh hello/lease.
    response.write('retry: 2000\n\n')
    // Only the response's close means the page went away: an IncomingMessage
    // emits its own 'close' as soon as an empty GET body has been read.
    response.once('close', () => client.close())
    startHeartbeat()
    return client
  }

  function closeAll() {
    for (const client of [...clients])
      client.close()
  }

  return { open, closeAll, get size() { return clients.size } }
}
