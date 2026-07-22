import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
const dashboard = read('./DashboardView.tsx')
const card = read('./LoopCard.tsx')
const detail = read('./LoopDetailView.tsx')

describe('standing-objective dashboard', () => {
  it('keeps every loop in one list with no completed partition', () => {
    expect(dashboard).toContain('jobs.map')
    expect(dashboard).not.toContain('isCompleted')
    expect(dashboard).not.toMatch(/>\s*Completed\s*</)
  })

  it('labels a configured goal as an objective without terminal UI', () => {
    expect(card).toMatch(/>\s*Objective\s*</)
    expect(card).not.toContain('completionReason')
    expect(detail).toContain('Working toward')
    expect(detail).toMatch(/>\s*Objective\s*</)
    expect(detail).not.toMatch(/>Reopen<\/button>/)
    expect(detail).not.toContain('completionReason')
  })

  it('keeps Run once visible and gates it through the lifecycle availability matrix', () => {
    expect(detail).toContain("const canRunWork = active || paused")
    expect(detail).toContain('disabled={actionDisabled || !canRunWork}')
    expect(detail).toMatch(/>\s*\{pending === 'run' \? 'Queuing…' : 'Run once'\}\s*<\/button>/)
  })
})
