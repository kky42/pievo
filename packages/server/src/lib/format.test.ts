import { describe, expect, it } from 'vitest'
import { dotColor, dotLabel, scheduleText } from './format'
import type { RunSummary } from '../types'

const run = (over: Partial<RunSummary>): RunSummary => ({
  id: 'r1', loopId: 'l1', ts: '2026-01-01T00:00:00Z', phase: 'done', agent: null, status: null,
  message: null, durationMs: null, exitCode: null, finalText: null, usage: null, error: null,
  sessionId: null, ...over,
})

describe('schedule summaries', () => {
  it('humanizes cron while retaining its overlap policy', () => {
    expect(scheduleText({ mode: 'cron', cron: '0 9 * * *', timezone: 'Asia/Taipei', overlap: 'skip' }))
      .toBe('daily 09:00 · Asia/Taipei · overlap skip')
  })

  it('labels complex cron without misrepresenting its cadence', () => {
    expect(scheduleText({ mode: 'cron', cron: '0,30 */3 * * *', timezone: 'UTC', overlap: 'skip' }))
      .toBe('custom schedule · UTC · overlap skip')
  })

  it('describes continuous delay without an overlap policy', () => {
    const text = scheduleText({ mode: 'continuous', delayMinutes: 5 })
    expect(text).toBe('continuous · 5m after completion')
    expect(text).not.toContain('overlap')
  })
})

describe('minimal report statuses', () => {
  it('renders keep green, no-change gray, block yellow, and errors red', () => {
    expect(dotLabel(run({ phase: 'done', status: 'keep' }))).toBe('Keep')
    expect(dotColor(run({ phase: 'done', status: 'keep' }))).toBe('var(--color-run-keep)')
    expect(dotColor(run({ phase: 'done', status: 'no-change' }))).toBe('var(--color-run-no-change)')
    expect(dotColor(run({ phase: 'done', status: 'block' }))).toBe('var(--color-run-block)')
    expect(dotColor(run({ phase: 'error' }))).toBe('var(--color-run-error)')
    expect(dotColor(run({ phase: 'error', status: 'block' }))).toBe('var(--color-run-error)')
    expect(dotLabel(run({ phase: 'error', status: 'block' }))).toBe('Error')
  })
})

describe('truthful cancellation labels', () => {
  it('shows intent as running and preserves actual terminal results', () => {
    expect(dotLabel(run({ phase: 'running', cancelRequested: true }))).toBe('Stopping…')
    expect(dotLabel(run({ phase: 'done', cancelRequested: true }))).toBe('Succeeded while stopping')
    expect(dotLabel(run({ phase: 'error', cancelRequested: true }))).toBe('Failed while stopping')
    expect(dotLabel(run({ phase: 'canceled', cancelRequested: true, error: 'stopped by user' }))).toBe('Canceled')
  })
})
