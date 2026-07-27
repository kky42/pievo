// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LoopSummary } from '../types'
import { DashboardView, type DashboardData } from './DashboardView'

const h = vi.hoisted(() => ({
  listLoops: vi.fn(async () => [] as LoopSummary[]),
}))

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => () => {} }))
vi.mock('../server/loopApi', () => ({
  listLoops: h.listLoops,
  listMyTeams: vi.fn(async () => undefined),
}))
vi.mock('../server/machineFns', () => ({ listMachines: vi.fn(async () => []) }))
vi.mock('./LoopCard', () => ({
  LoopCard: ({ loop }: { loop: LoopSummary }) =>
    createElement('div', { 'data-testid': `loop-${loop.id}` }, loop.name),
}))
vi.mock('./TeamSwitcher', () => ({ TeamSwitcher: () => null }))
vi.mock('./MachinesModal', () => ({ MachinesModal: () => null }))
vi.mock('./TeamsModal', () => ({ TeamsModal: () => null }))
vi.mock('./ComposeModal', () => ({ ComposeModal: () => null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function loopSummary(id: string, name: string): LoopSummary {
  return {
    id,
    name,
    schedule: { mode: 'cron', cron: '0 6 * * *', timezone: 'UTC', overlap: 'queue-one' },
    workdir: '/tmp/project',
    agent: 'claude-code',
    model: null,
    reasoningEffort: null,
    enabled: true,
    nextRun: null,
    running: false,
    lastRunTs: null,
    deleteRequestedAt: null,
    runs: [],
    runCount: 0,
  }
}

const initial = (loops: LoopSummary[]): DashboardData => ({
  loops,
  machines: [],
  teams: undefined,
})

let host: HTMLDivElement | null = null
let root: Root | null = null

async function render(data: DashboardData) {
  if (!root) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  await act(async () => {
    root!.render(createElement(DashboardView, { teamId: 'team-1', initial: data }))
    await Promise.resolve()
  })
}

function findLoop(id: string) {
  return host!.querySelector(`[data-testid="loop-${id}"]`)
}

afterEach(async () => {
  h.listLoops.mockReset()
  h.listLoops.mockResolvedValue([])
  if (root) await act(async () => root!.unmount())
  host?.remove()
  host = null
  root = null
})

describe('DashboardView loader and live data ordering', () => {
  it('renders a refreshed loader result instead of retaining its one-time seed', async () => {
    await render(initial([loopSummary('deleted', 'Deleted loop')]))
    expect(findLoop('deleted')).not.toBeNull()

    await render(initial([]))

    expect(findLoop('deleted')).toBeNull()
  })
})
