interface ChatViewport {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  addEventListener: (event: string, listener: () => void) => void
  removeEventListener: (event: string, listener: () => void) => void
}

// Follow the conversation only while the visitor is already at its end. Reading
// earlier messages must not be interrupted by streamed tokens or audio controls.
export function createChatScrollController(viewport: ChatViewport, options: {
  requestFrame?: (callback: () => void) => number
  cancelFrame?: (id: number) => void
  onUnread?: (unread: boolean) => void
} = {}) {
  const requestFrame = options.requestFrame ?? (callback => requestAnimationFrame(callback))
  const cancelFrame = options.cancelFrame ?? (id => cancelAnimationFrame(id))
  let following = true
  let unread = false
  let destroyed = false
  let frame: number | null = null
  let automaticTop: number | null = null

  function setUnread(value: boolean) {
    if (unread === value)
      return
    unread = value
    options.onUnread?.(value)
  }
  function cancelPending() {
    if (frame !== null)
      cancelFrame(frame)
    frame = null
  }
  function scheduleFollow() {
    if (destroyed || frame !== null)
      return
    frame = requestFrame(() => {
      frame = null
      if (destroyed || !following)
        return
      const before = viewport.scrollTop
      viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
      automaticTop = viewport.scrollTop === before ? null : viewport.scrollTop
      setUnread(false)
    })
  }
  function onScroll() {
    if (destroyed)
      return
    // Our scroll event can arrive after another delta grew the document. A
    // large new bottom gap does not mean the visitor scrolled away in that case.
    if (automaticTop !== null && Math.abs(viewport.scrollTop - automaticTop) < 1) {
      automaticTop = null
      if (following)
        scheduleFollow()
      return
    }
    automaticTop = null
    following = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 48
    if (following)
      setUnread(false)
    else
      cancelPending()
  }
  viewport.addEventListener('scroll', onScroll)
  const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
    if (following)
      scheduleFollow()
  })
  resize?.observe(viewport as HTMLElement)
  scheduleFollow()

  return {
    notifyContentChanged() {
      if (destroyed)
        return
      if (following)
        scheduleFollow()
      else
        setUnread(true)
    },
    jumpToLatest() {
      if (destroyed)
        return
      following = true
      setUnread(false)
      scheduleFollow()
    },
    destroy() {
      destroyed = true
      automaticTop = null
      cancelPending()
      resize?.disconnect()
      viewport.removeEventListener('scroll', onScroll)
    },
  }
}
