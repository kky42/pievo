import { describe, expect, it } from 'vitest'
import type { LoopDetail, LoopSummary, RunSummary } from '../types'
import { daemonStopSupport, deriveLoopLifecycle, lifecycleDisplay } from './lifecycleUi'

const run = (patch: Partial<RunSummary> = {}): RunSummary => ({
  id: 'r1', loopId: 'l1', ts: '2026-01-01T00:00:00Z', phase: 'done', agent: null, status: null, message: null, durationMs: null, exitCode: null,
  finalText: null, usage: null, error: null, sessionId: null,
  ...patch,
})
const loop = (patch: Partial<LoopSummary> = {}): LoopSummary => ({
  id: 'l1', name: 'Loop', schedule: { mode: 'cron', cron: '0 6 * * *', timezone: 'UTC', overlap: 'queue-one' },
  workdir: '/tmp/project', agent: 'claude-code', model: null, reasoningEffort: null, enabled: true,
  nextRun: null, lastRunTs: null, runs: [], runCount: 0,
  ...patch,
})

function detail(summary: LoopSummary, machine: Partial<LoopDetail['machine']> = {}): LoopDetail {
  return {
    loop: { id: summary.id, name: summary.name, schedule: summary.schedule, workdir: summary.workdir, agent: summary.agent, model: summary.model, reasoningEffort: summary.reasoningEffort, prompt: 'Do it.', statusDefinitions: { keep: 'keep', noChange: 'none', block: 'blocked' }, artifacts: [], enabled: summary.enabled },
    summary, runs: summary.runs,
    machine: { id: 'm1', name: 'MacBook Pro', online: true, presence: 'online', lastSeen: null, daemonProtocol: 4, daemonVersion: '2.4.0', needsUpdate: false, requiredDaemonVersion: '2.4.0', ...machine },
  }
}

describe('Dashboard lifecycle derivation', () => {
  it('uses the specified precedence and never calls cancellation intent Canceled', () => {
    expect(deriveLoopLifecycle(loop({ deleteRequestedAt: '2026-01-02T00:00:00Z', enabled: false }))).toBe('deleting')
    expect(deriveLoopLifecycle(loop({ enabled: false, running: true, runs: [run({ phase: 'running', cancelRequested: true })] }))).toBe('stopping')
    expect(deriveLoopLifecycle(loop({ enabled: false, running: true, runs: [run({ phase: 'running' })] }))).toBe('paused-finishing')
    expect(deriveLoopLifecycle(loop({ enabled: false }))).toBe('paused')
    expect(deriveLoopLifecycle(loop())).toBe('active')
  })

  it('renders exact offline and unsupported-protocol Stop wording', () => {
    const stopping = loop({ enabled: false, running: true, runs: [run({ phase: 'running', cancelRequested: true })] })
    expect(lifecycleDisplay(detail(stopping, { online: false, presence: 'offline' }))).toBe('Stopping · waiting for MacBook Pro')
    expect(lifecycleDisplay(detail(stopping, { daemonProtocol: 1 }))).toBe('Daemon upgrade required to stop a running process. Run `npm install -g @kky42/pievo@latest`, then `pievo daemon restart`.')
  })

  it('reports breaking protocol support explicitly', () => {
    expect(daemonStopSupport(4)).toEqual({ supported: true, label: 'Daemon protocol 4 · Stop supported' })
    expect(daemonStopSupport(1)).toEqual({ supported: false, label: 'Daemon protocol 1 · upgrade required' })
    expect(daemonStopSupport(null)).toEqual({ supported: false, label: 'Daemon protocol unknown · upgrade required' })
  })
})
