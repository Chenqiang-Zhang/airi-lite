// Stage pages connect here. The newest OBS page holds the only speaking lease
// (primary); older OBS pages are told to stand by, and previews only show
// captions. Only the primary may buy speech or report playback.
export const STAGE_ROLES = new Set(['obs', 'preview'])

export function createStageBus({ sse, newId, now = Date.now, getMode = () => 'live', getActivity = () => 'idle' }) {
  const stages = new Set()
  const listeners = new Set()
  let primary = null

  function hello(stage) {
    // The current activity too: a page that reconnects while the brain is
    // composing shows the thinking pose without waiting for the next cue.
    stage.client.send('hello', {
      leaseId: stage.leaseId, role: stage.role, primary: stage === primary, mode: getMode(), activity: getActivity(),
    })
  }

  function setPrimary(next) {
    const previous = primary
    if (previous === next)
      return
    primary = next
    if (previous && !previous.client.closed) {
      previous.leaseId = null
      previous.status = { ...previous.status, ready: false }
      previous.client.send('standby', {})
    }
    if (next) {
      next.leaseId = newId()
      next.status = { ...next.status, ready: false }
      hello(next)
    }
    for (const listener of listeners) {
      try { listener(previous, next) }
      catch (error) { console.error('Stage primary listener failed', error) }
    }
  }

  function connect(request, response, role) {
    const stage = {
      role,
      leaseId: null,
      connectedAt: now(),
      status: { ready: false, avatar: 'unknown', obs: null, lastReportAt: null },
      client: null,
    }
    stage.client = sse.open(request, response, {
      onClose: () => {
        stages.delete(stage)
        if (stage === primary) {
          // Hand the lease to the most recently connected remaining OBS page,
          // so closing a duplicate tab never leaves the broadcast mute.
          const fallback = [...stages].filter(candidate => candidate.role === 'obs').at(-1) ?? null
          setPrimary(fallback)
        }
      },
    })
    stages.add(stage)
    if (role === 'obs')
      setPrimary(stage)
    else
      hello(stage)
    return stage
  }

  function stageForLease(leaseId) {
    return typeof leaseId === 'string' && primary?.leaseId === leaseId ? primary : null
  }

  return {
    connect,
    isPrimary: leaseId => stageForLease(leaseId) !== null,
    hasReadyPrimary: () => Boolean(primary?.status.ready),
    updatePrimaryStatus(leaseId, patch) {
      const stage = stageForLease(leaseId)
      if (!stage)
        return false
      stage.status = { ...stage.status, ...patch, lastReportAt: now() }
      return true
    },
    publish(event, data) {
      for (const stage of stages)
        stage.client.send(event, data)
    },
    onPrimaryChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    summary() {
      const time = now()
      return {
        primary: primary ? {
          ready: primary.status.ready,
          avatar: primary.status.avatar,
          obs: primary.status.obs,
          connectedForMs: time - primary.connectedAt,
          lastReportAgoMs: primary.status.lastReportAt === null ? null : time - primary.status.lastReportAt,
        } : null,
        standby: [...stages].filter(stage => stage.role === 'obs' && stage !== primary).length,
        previews: [...stages].filter(stage => stage.role === 'preview').length,
      }
    },
    closeAll() {
      listeners.clear()
      primary = null
      sse.closeAll()
    },
  }
}
