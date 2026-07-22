import { describe, expect, it } from 'vitest'
import type { JobDetail, JobSummary, RunSummary } from '../types'
import { daemonStopSupport, deriveLoopLifecycle, lifecycleDisplay } from './lifecycleUi'

const run = (patch: Partial<RunSummary> = {}): RunSummary => ({
  id: 'r1', loopId: 'l1', ts: '2026-01-01T00:00:00Z', agent: null, status: null, message: null, durationMs: null, exitCode: null,
  finalText: null, usage: null, error: null, state: null, control: null, sessionId: null,
  ...patch,
})
const job = (patch: Partial<JobSummary> = {}): JobSummary => ({
  id: 'l1', name: 'Loop', cron: '0 6 * * *', kind: 'exec', enabled: true,
  notify: 'auto', nextRun: null, lastRunTs: null, graduation: null, runs: [], runCount: 0,
  ...patch,
})

function detail(summary: JobSummary, machine: Partial<JobDetail['machine']> = {}): JobDetail {
  return {
    job: { id: summary.id, cron: summary.cron, scheduleMode: 'cron', continuousDelayMinutes: 1, enabled: summary.enabled, notify: 'auto' },
    summary, taskFileContent: null, taskFileSyncedAt: null, runs: summary.runs,
    machine: { id: 'm1', name: 'MacBook Pro', online: true, presence: 'online', lastSeen: null, daemonProtocol: 2, ...machine },
  }
}

describe('Dashboard lifecycle derivation', () => {
  it('uses the specified precedence and never calls cancellation intent Canceled', () => {
    expect(deriveLoopLifecycle(job({ completedAt: '2026-01-01T00:00:00Z', deleteRequestedAt: '2026-01-02T00:00:00Z' }))).toBe('deleting')
    expect(deriveLoopLifecycle(job({ deleteRequestedAt: '2026-01-02T00:00:00Z', enabled: false }))).toBe('deleting')
    expect(deriveLoopLifecycle(job({ enabled: false, running: true, runs: [run({ running: true, cancelRequested: true })] }))).toBe('stopping')
    expect(deriveLoopLifecycle(job({ enabled: false, running: true, runs: [run({ running: true })] }))).toBe('paused-finishing')
    expect(deriveLoopLifecycle(job({ enabled: false }))).toBe('paused')
    expect(deriveLoopLifecycle(job())).toBe('active')
  })

  it('renders exact offline and incompatible Stop wording', () => {
    const stopping = job({ enabled: false, running: true, runs: [run({ running: true, cancelRequested: true })] })
    expect(lifecycleDisplay(detail(stopping, { online: false, presence: 'offline' }))).toBe('Stopping · waiting for MacBook Pro')
    expect(lifecycleDisplay(detail(stopping, { daemonProtocol: 1 }))).toBe('Daemon upgrade required to stop a running process. Run `npm install -g @kky42/pievo@latest`, then `pievo daemon restart`.')
  })

  it('reports breaking protocol support explicitly', () => {
    expect(daemonStopSupport(2)).toEqual({ supported: true, label: 'Daemon protocol 2 · Stop supported' })
    expect(daemonStopSupport(1)).toEqual({ supported: false, label: 'Daemon protocol 1 · upgrade required' })
    expect(daemonStopSupport(null)).toEqual({ supported: false, label: 'Daemon protocol unknown · upgrade required' })
  })
})
