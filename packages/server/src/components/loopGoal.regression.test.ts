import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Regression guard for the open/closed-loop UI surfaces (batch 1).
 *
 * The dashboard split and the loop/card chrome moved off the old `isDone`
 * (disabled+resolved) heuristic onto the explicit `isCompleted` (completedAt)
 * loop state. These string-level checks pin the three states — open active,
 * closed active (Goal chip + goal line), and completed (Completed badge +
 * Reopen + Run-once disabled) — so a refactor can't silently drop one.
 */
const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
// The dashboard BODY (the open/completed split) lives in the shared DashboardView,
// rendered by both `/` (open mode) and `/t/$teamId`.
const dashboard = read('./DashboardView.tsx')
const card = read('./LoopCard.tsx')
const detail = read('./LoopDetailView.tsx')
const format = read('../lib/format.ts')

describe('dashboard completed split', () => {
  it('splits on isCompleted (not the retired isDone) and labels the section "Completed"', () => {
    expect(format).toMatch(/export function isCompleted\b/)
    expect(format).not.toMatch(/export function isDone\b/)
    expect(dashboard).toContain('isCompleted')
    expect(dashboard).not.toContain('isDone')
    expect(dashboard).toContain('jobs.filter(isCompleted)')
    expect(dashboard).toContain('Completed')
    expect(dashboard).not.toMatch(/>\s*Done\s*</)
  })
})

describe('LoopCard closed/completed chrome', () => {
  it('renders a Completed badge + a Goal chip and drops the old Done badge', () => {
    expect(card).toContain('isCompleted')
    expect(card).toContain('isClosed')
    expect(card).toMatch(/>\s*Completed\s*</)
    expect(card).toMatch(/>\s*Goal\s*</)
    expect(card).not.toMatch(/>\s*Done\s*</)
    // Completion reason/date shows in the card meta.
    expect(card).toContain('completionReason')
  })
})

describe('LoopDetailView closed/completed states', () => {
  it('surfaces the Goal chip + "Working toward" line, the Completed badge, and Reopen', () => {
    expect(detail).toContain('isCompleted')
    expect(detail).toContain('isClosed')
    expect(detail).toContain('Working toward')
    expect(detail).toMatch(/>\s*Completed\s*</)
    expect(detail).toMatch(/>Reopen<\/button>/)
    expect(detail).toContain('completionReason')
  })

  it('keeps Run once visible and gates it through the lifecycle availability matrix', () => {
    expect(detail).toContain("const canRunWork = active || paused")
    expect(detail).toContain('disabled={actionDisabled || !canRunWork}')
    expect(detail).toMatch(/>\s*\{pending === 'run' \? 'Queuing…' : 'Run once'\}\s*<\/button>/)
  })
})
