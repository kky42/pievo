// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JobSummary } from '../types'
import { DashboardView, type DashboardData } from './DashboardView'

const h = vi.hoisted(() => ({
  listJobs: vi.fn(async () => [] as JobSummary[]),
  onCreated: null as null | (() => void),
}))

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => () => {} }))
vi.mock('../server/loopApi', () => ({
  listJobs: h.listJobs,
  listMyTeams: vi.fn(async () => undefined),
}))
vi.mock('../server/machineFns', () => ({ listMachines: vi.fn(async () => []) }))
vi.mock('./LoopCard', () => ({
  LoopCard: ({ job }: { job: JobSummary }) =>
    createElement('div', { 'data-testid': `loop-${job.id}` }, job.name),
}))
vi.mock('./TeamSwitcher', () => ({ TeamSwitcher: () => null }))
vi.mock('./MachinesModal', () => ({ MachinesModal: () => null }))
vi.mock('./NotificationsModal', () => ({ NotificationsModal: () => null }))
vi.mock('./TeamsModal', () => ({ TeamsModal: () => null }))
vi.mock('./ComposeModal', () => ({
  ComposeModal: ({ onCreated }: { onCreated: () => void }) => {
    h.onCreated = onCreated
    return null
  },
}))
vi.mock('./LoopPlaybook', () => ({ LoopPlaybook: () => null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function job(id: string, name: string): JobSummary {
  return {
    id,
    name,
    cron: '0 6 * * *',
    kind: 'exec:claude-code',
    enabled: true,
    notify: 'auto',
    nextRun: null,
    running: false,
    lastRunTs: null,
    graduation: null,
    deleteRequestedAt: null,
    runs: [],
    runCount: 0,
  }
}

const initial = (jobs: JobSummary[]): DashboardData => ({
  jobs,
  templates: [],
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

function loop(id: string) {
  return host!.querySelector(`[data-testid="loop-${id}"]`)
}

afterEach(async () => {
  h.listJobs.mockReset()
  h.listJobs.mockResolvedValue([])
  h.onCreated = null
  if (root) await act(async () => root!.unmount())
  host?.remove()
  host = null
  root = null
})

describe('DashboardView loader and live data ordering', () => {
  it('renders a refreshed loader result instead of retaining its one-time seed', async () => {
    await render(initial([job('deleted', 'Deleted loop')]))
    expect(loop('deleted')).not.toBeNull()

    await render(initial([]))

    expect(loop('deleted')).toBeNull()
  })

  it('does not let an older loader result overwrite a successful live refresh', async () => {
    await render(initial([]))
    h.listJobs.mockResolvedValue([job('live', 'Live loop')])

    await act(async () => {
      h.onCreated!()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(loop('live')).not.toBeNull()

    await render(initial([job('deleted', 'Deleted loop')]))

    expect(loop('live')).not.toBeNull()
    expect(loop('deleted')).toBeNull()
  })
})
