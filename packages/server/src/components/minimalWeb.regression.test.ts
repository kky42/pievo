import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8')
const form = read('./LoopForm.tsx')
const detail = read('./LoopDetailView.tsx')
const list = read('./LoopCard.tsx')
const dashboard = read('./DashboardView.tsx')
const files = read('./LoopFilesPanel.tsx')
const run = read('./RunView.tsx')

const web = [form, detail, list, dashboard].join('\n')

describe('minimal prompt-runner web surface', () => {
  it('shows only the final editable configuration', () => {
    for (const label of ['Name', 'Schedule', 'Cron overlap', 'Working directory', 'Coding agent', 'Model', 'Reasoning effort', 'User prompt', 'Status definitions', 'Artifact paths']) {
      expect(form).toContain(label)
    }
    expect(files).toContain('Configured exact paths')
    expect(list).toContain('loop.schedule')
  })

  it('retains lifecycle, machine, history, artifacts, and provider diagnostics', () => {
    for (const kept of ['Run once', 'Settings', 'Start', 'Pause', 'Stop', 'Delete', 'Machine', 'Runs', 'LoopFilesPanel']) expect(detail).toContain(kept)
    for (const kept of ['run.sessionId', 'run.finalText', 'Token usage']) expect(run).toContain(kept)
  })

  it('does not add status aggregate widgets', () => {
    expect(web).not.toMatch(/status distribution|status breakdown|keep count|block count/i)
  })
})
