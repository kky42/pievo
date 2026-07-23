import type { JobDetail, JobSummary } from '../types'

export const DASHBOARD_PROTOCOL = 3
export const DAEMON_UPGRADE_REQUIRED = 'Daemon upgrade required to stop a running process. Run `npm install -g @kky42/pievo@latest`, then `pievo daemon restart`.'

export type LoopLifecycle = 'deleting' | 'stopping' | 'paused-finishing' | 'paused' | 'active'

/** Derive product lifecycle state only from durable server facts. */
export function deriveLoopLifecycle(job: JobSummary): LoopLifecycle {
  if (job.deleteRequestedAt != null) return 'deleting'
  const running = job.runs.find((run) => run.running)
  if (!job.enabled && running?.cancelRequested) return 'stopping'
  if (!job.enabled && (job.running || running)) return 'paused-finishing'
  if (!job.enabled) return 'paused'
  return 'active'
}

export function daemonStopSupport(protocol: number | null | undefined): { supported: boolean; label: string } {
  return protocol === DASHBOARD_PROTOCOL
    ? { supported: true, label: `Daemon protocol ${DASHBOARD_PROTOCOL} · Stop supported` }
    : { supported: false, label: `Daemon protocol ${protocol ?? 'unknown'} · upgrade required` }
}

/** Exact user-facing lifecycle wording, including uncertainty boundaries. */
export function lifecycleDisplay(detail: JobDetail): string {
  const state = deriveLoopLifecycle(detail.summary)
  const running = detail.summary.runs.find((run) => run.running)
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
