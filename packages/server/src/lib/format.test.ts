import { describe, expect, it } from 'vitest'
import { dotLabel } from './format'
import type { RunSummary } from '../types'

const run = (over: Partial<RunSummary>): RunSummary => ({
  id: 'r1', loopId: 'l1', ts: '2026-01-01T00:00:00Z', agent: null, status: null,
  message: null, durationMs: null, exitCode: null, finalText: null, usage: null, error: null,
  metrics: null, control: null, sessionId: null, ...over,
})

describe('truthful cancellation labels', () => {
  it('shows intent as running and preserves actual terminal results', () => {
    expect(dotLabel(run({ running: true, cancelRequested: true }))).toBe('Stopping…')
    expect(dotLabel(run({ phase: 'done', cancelRequested: true }))).toBe('Succeeded while stopping')
    expect(dotLabel(run({ phase: 'error', cancelRequested: true }))).toBe('Failed while stopping')
    expect(dotLabel(run({ canceled: true, cancelRequested: true, error: 'stopped by user' }))).toBe('Canceled')
  })
})
