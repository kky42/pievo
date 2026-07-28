import { describe, expect, it } from 'vitest'
import type { LoopDetail, LoopSummary, RunSummary } from '../types'
import { daemonStopSupport, deriveLoopLifecycle, lifecycleDisplay, lifecyclePresentation } from './lifecycleUi'

const run = (patch: Partial<RunSummary> = {}): RunSummary => ({
  id: 'r1', loopId: 'l1', ts: '2026-01-01T00:00:00Z', phase: 'done', agent: null, status: null, message: null, durationMs: null, exitCode: null,
  finalText: null, usage: null, error: null, sessionId: null,
  ...patch,
})
const loop = (patch: Partial<LoopSummary> = {}): LoopSummary => ({
  id: 'l1', name: 'Loop', schedule: { mode: 'cron', cron: '0 6 * * *', timezone: 'UTC', overlap: 'queue-one' },
  workdir: '/tmp/project', agent: 'claude-code', model: null, reasoningEffort: null,
  machine: { id: 'm1', name: 'MacBook Pro', online: true, presence: 'online', lastSeen: null }, enabled: true,
  nextRun: null, lastRunTs: null, runs: [], runCount: 0, recentUsage: { runCount: 0, tokenCount: 0 },
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

  it('maps durable scheduling state and pause causes to stable labels and tones', () => {
    expect(lifecyclePresentation(loop())).toEqual({ label: 'Active', tone: 'success' })
    expect(lifecyclePresentation(loop({ enabled: false, pauseCause: { kind: 'owner', at: '2026-01-01T00:00:00Z' } }))).toEqual({ label: 'Paused · owner', tone: 'neutral' })
    expect(lifecyclePresentation(loop({ enabled: false, pauseCause: { kind: 'failure-streak', at: '2026-01-01T00:00:00Z', runId: 'r1', count: 3 } }))).toEqual({ label: 'Paused · failure streak', tone: 'attention' })
    expect(lifecyclePresentation(loop({ enabled: false, pauseCause: { kind: 'blocked', at: '2026-01-01T00:00:00Z', runId: 'r1' } }))).toEqual({ label: 'Paused · blocked', tone: 'attention' })
    expect(lifecyclePresentation(loop({ enabled: false }))).toEqual({ label: 'Paused', tone: 'neutral' })
    expect(lifecyclePresentation(loop({ enabled: false, deleteRequestedAt: '2026-01-01T00:00:00Z' }))).toEqual({ label: 'Deleting', tone: 'accent' })
  })

  it('does not let queued execution replace the Active lifecycle label', () => {
    expect(lifecyclePresentation(loop({ queued: true }))).toEqual({ label: 'Active', tone: 'success' })
  })

  it('does not let running or stopping execution replace the persisted pause cause', () => {
    const owner = { kind: 'owner' as const, at: '2026-01-01T00:00:00Z' }
    const finishing = loop({ enabled: false, running: true, pauseCause: owner, runs: [run({ phase: 'running' })] })
    const stopping = loop({ enabled: false, running: true, pauseCause: owner, runs: [run({ phase: 'running', cancelRequested: true })] })
    expect(lifecycleDisplay(detail(finishing))).toBe('Paused · owner')
    expect(lifecycleDisplay(detail(stopping, { online: false, presence: 'offline', daemonProtocol: 1 }))).toBe('Paused · owner')
  })

  it('reports breaking protocol support explicitly', () => {
    expect(daemonStopSupport(4)).toEqual({ supported: true, label: 'Daemon protocol 4 · Stop supported' })
    expect(daemonStopSupport(1)).toEqual({ supported: false, label: 'Daemon protocol 1 · upgrade required' })
    expect(daemonStopSupport(null)).toEqual({ supported: false, label: 'Daemon protocol unknown · upgrade required' })
  })
})
