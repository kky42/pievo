import type { LoopSummary } from '../types'

/** Mirrors gateway/protocol.ts DAEMON_PROTOCOL_VERSION; Stop requires the
 *  current protocol because older daemons cannot prove termination. */
export const DASHBOARD_PROTOCOL = 7
export const DAEMON_UPGRADE_REQUIRED = 'Daemon upgrade required to stop a running process. Run `npm install -g @kky42/pievo@latest`, then `pievo daemon restart`.'

export type LoopLifecycle = 'deleting' | 'stopping' | 'paused-finishing' | 'paused' | 'active'
export type LoopLifecycleTone = 'neutral' | 'accent'

export function deriveLoopLifecycle(loop: LoopSummary): LoopLifecycle {
  if (loop.deleteRequestedAt != null) return 'deleting'
  const running = loop.runs.find((run) => run.phase === 'running')
  if (!loop.enabled && running?.cancelRequested) return 'stopping'
  if (!loop.enabled && (loop.running || running)) return 'paused-finishing'
  if (!loop.enabled) return 'paused'
  return 'active'
}

/** Stable lifecycle badge shared by dashboard cards and loop detail. It shows
 * only scheduling state and its durable pause cause; execution transients
 * (queued/running/stopping) stay in the runs timeline and never replace it. */
export function lifecyclePresentation(loop: LoopSummary): { label: string; tone: LoopLifecycleTone } {
  if (loop.deleteRequestedAt != null) return { label: 'Deleting', tone: 'accent' }
  // Green is reserved for attention, so a healthy loop's badge stays neutral.
  if (loop.enabled) return { label: 'Active', tone: 'neutral' }
  if (loop.pauseCause?.kind === 'blocked') return { label: 'Paused · blocked', tone: 'accent' }
  if (loop.pauseCause?.kind === 'failure-streak') return { label: 'Paused · failure streak', tone: 'accent' }
  if (loop.pauseCause?.kind === 'owner') return { label: 'Paused · owner', tone: 'neutral' }
  return { label: 'Paused', tone: 'neutral' }
}

export function daemonStopSupport(protocol: number | null | undefined): { supported: boolean; label: string } {
  return protocol === DASHBOARD_PROTOCOL
    ? { supported: true, label: `Daemon protocol ${DASHBOARD_PROTOCOL} · Stop supported` }
    : { supported: false, label: `Daemon protocol ${protocol ?? 'unknown'} · upgrade required` }
}
