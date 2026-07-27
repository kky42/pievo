import type { LoopDetail, LoopSummary } from '../types'

export const DASHBOARD_PROTOCOL = 4
export const DAEMON_UPGRADE_REQUIRED = 'Daemon upgrade required to stop a running process. Run `npm install -g @kky42/pievo@latest`, then `pievo daemon restart`.'

export type LoopLifecycle = 'deleting' | 'stopping' | 'paused-finishing' | 'paused' | 'active'

/** Derive product lifecycle state only from durable server facts. */
export function deriveLoopLifecycle(loop: LoopSummary): LoopLifecycle {
  if (loop.deleteRequestedAt != null) return 'deleting'
  const running = loop.runs.find((run) => run.phase === 'running')
  if (!loop.enabled && running?.cancelRequested) return 'stopping'
  if (!loop.enabled && (loop.running || running)) return 'paused-finishing'
  if (!loop.enabled) return 'paused'
  return 'active'
}

export function daemonStopSupport(protocol: number | null | undefined): { supported: boolean; label: string } {
  return protocol === DASHBOARD_PROTOCOL
    ? { supported: true, label: `Daemon protocol ${DASHBOARD_PROTOCOL} · Stop supported` }
    : { supported: false, label: `Daemon protocol ${protocol ?? 'unknown'} · upgrade required` }
}

/** Exact user-facing lifecycle wording, including uncertainty boundaries. */
export function lifecycleDisplay(detail: LoopDetail): string {
  const state = deriveLoopLifecycle(detail.summary)
  if (detail.summary.queued && detail.summary.reconciliationBlocking) {
    return detail.machine.presence === 'online'
      ? 'Queued · machine is checking an interrupted run'
      : 'Queued · waiting for machine recovery'
  }
  const running = detail.summary.runs.find((run) => run.phase === 'running')
  if (running && detail.machine.daemonProtocol !== DASHBOARD_PROTOCOL) {
    return DAEMON_UPGRADE_REQUIRED
  }
  if (state === 'stopping' && running && !detail.machine.online) {
    return `Stopping · waiting for ${detail.machine.name || 'machine'}`
  }
  switch (state) {
    case 'deleting': return 'Deleting'
    case 'stopping': return 'Stopping'
    case 'paused-finishing': return detail.summary.pauseCause?.kind === 'blocked' ? 'Paused — blocked · current run finishing' : detail.summary.pauseCause?.kind === 'owner' ? 'Paused by owner · current run finishing' : 'Paused · current run finishing'
    case 'paused': return detail.summary.pauseCause?.kind === 'blocked' ? 'Paused — blocked' : detail.summary.pauseCause?.kind === 'failure-streak' ? 'Paused automatically' : detail.summary.pauseCause?.kind === 'owner' ? 'Paused by owner' : 'Paused'
    case 'active': return 'Active'
  }
}
