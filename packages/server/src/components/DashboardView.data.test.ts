// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LoopSummary } from '../types'
import { DashboardView, type DashboardData } from './DashboardView'

const h = vi.hoisted(() => ({
  listLoops: vi.fn(async () => [] as LoopSummary[]),
  navigate: vi.fn(),
  invalidate: vi.fn(),
  signOut: vi.fn(async () => undefined),
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => h.navigate,
  useRouter: () => ({ invalidate: h.invalidate }),
}))
vi.mock('../lib/auth-client', () => ({
  signOut: h.signOut,
  useSession: () => ({ data: { user: { name: 'Alice', email: 'alice@example.com' } }, isPending: false }),
}))
vi.mock('../server/loopApi', () => ({ listLoops: h.listLoops }))
vi.mock('../server/machineFns', () => ({ listMachines: vi.fn(async () => []) }))
vi.mock('./LoopCard', () => ({
  LoopCard: ({ loop }: { loop: LoopSummary }) =>
    createElement('div', { 'data-testid': `loop-${loop.id}` }, loop.name),
}))
vi.mock('./MachinesModal', () => ({ MachinesModal: () => null }))
vi.mock('./ComposeModal', () => ({ ComposeModal: () => null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function loopSummary(id: string, name: string, patch: Partial<LoopSummary> = {}): LoopSummary {
  return {
    id,
    name,
    tags: [],
    schedule: { mode: 'cron', cron: '0 6 * * *', timezone: 'UTC', overlap: 'queue-one' },
    workdir: '/tmp/project',
    agent: 'claude-code',
    model: null,
    reasoningEffort: null,
    machine: { id: 'machine-1', name: 'Test machine', online: true, presence: 'online', lastSeen: null },
    enabled: true,
    nextRun: null,
    running: false,
    lastRunTs: null,
    deleteRequestedAt: null,
    runs: [],
    runCount: 0,
    recentUsage: { runCount: 0, tokenCount: 0 },
    ...patch,
  }
}

const initial = (loops: LoopSummary[]): DashboardData => ({
  loops,
  machines: [],
})

let host: HTMLDivElement | null = null
let root: Root | null = null

async function render(data: DashboardData, mode: 'auth' | 'open' = 'open') {
  if (!root) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  await act(async () => {
    root!.render(createElement(DashboardView, { initial: data, mode }))
    await Promise.resolve()
  })
}

function findLoop(id: string) {
  return host!.querySelector(`[data-testid="loop-${id}"]`)
}

afterEach(async () => {
  h.listLoops.mockReset()
  h.listLoops.mockResolvedValue([])
  h.navigate.mockReset()
  h.invalidate.mockReset()
  h.signOut.mockClear()
  if (root) await act(async () => root!.unmount())
  host?.remove()
  host = null
  root = null
})

describe('DashboardView loader and live data ordering', () => {
  it('shows the shared-administration warning only in open mode', async () => {
    await render(initial([]), 'open')
    expect(host!.textContent).toContain('anyone who can reach this server can view and manage every loop')
    expect(host!.textContent).toContain('authenticated reverse proxy')

    await render(initial([]), 'auth')
    expect(host!.textContent).not.toContain('Open mode:')
  })

  it('shows the signed-in account and invalidates the dashboard after logout', async () => {
    await render(initial([]), 'auth')
    expect(host!.textContent).toContain('alice@example.com')
    const button = [...host!.querySelectorAll('button')].find((candidate) => candidate.textContent === 'Sign out')
    expect(button).toBeDefined()

    await act(async () => {
      button!.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(h.signOut).toHaveBeenCalledOnce()
    expect(h.navigate).toHaveBeenCalledWith({ to: '/' })
    expect(h.invalidate).toHaveBeenCalledOnce()
  })

  it('filters by one lifecycle or custom tag while keeping global counts visible', async () => {
    const loops = [
      loopSummary('active', 'Active loop', { tags: ['daily', 'project'] }),
      loopSummary('paused', 'Paused loop', { enabled: false, tags: ['ops'], pauseCause: { kind: 'owner', at: '2026-01-01T00:00:00Z' } }),
      loopSummary('blocked', 'Blocked loop', { enabled: false, tags: ['daily'], pauseCause: { kind: 'blocked', at: '2026-01-01T00:00:00Z', runId: 'r1' } }),
      loopSummary('untagged', 'Untagged loop'),
    ]
    await render(initial(loops))

    const radios = () => [...host!.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')]
    const radio = (label: string) => radios().find((item) => item.textContent?.startsWith(label))
    expect(radios().map((item) => item.textContent)).toEqual([
      'All Loops(4)', 'Active(2)', 'Paused(2)', 'Blocked(1)', 'daily(2)', 'ops(1)', 'project(1)',
    ])
    expect(radio('All Loops')?.getAttribute('aria-pressed')).toBe('true')

    await act(async () => { radio('daily')!.click() })
    expect(findLoop('active')).not.toBeNull()
    expect(findLoop('blocked')).not.toBeNull()
    expect(findLoop('paused')).toBeNull()
    expect(findLoop('untagged')).toBeNull()
    expect(radio('daily')?.getAttribute('aria-pressed')).toBe('true')

    await act(async () => { radio('Paused')!.click() })
    expect(findLoop('paused')).not.toBeNull()
    expect(findLoop('blocked')).not.toBeNull()
    expect(findLoop('active')).toBeNull()

    await act(async () => { radio('Blocked')!.click() })
    expect(findLoop('blocked')).not.toBeNull()
    expect(findLoop('paused')).toBeNull()
  })

  it('returns to All Loops when polling removes the selected custom tag', async () => {
    await render(initial([loopSummary('one', 'One', { tags: ['daily'] })]))
    const daily = [...host!.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find((item) => item.textContent?.startsWith('daily'))!
    await act(async () => { daily.click() })
    expect(daily.getAttribute('aria-pressed')).toBe('true')

    await render(initial([loopSummary('one', 'One')]))
    await act(async () => { await Promise.resolve() })
    expect(host!.querySelector('button[aria-pressed]')?.getAttribute('aria-pressed')).toBe('true')
    expect(findLoop('one')).not.toBeNull()
  })

  it('renders a refreshed loader result instead of retaining its one-time seed', async () => {
    await render(initial([loopSummary('deleted', 'Deleted loop')]))
    expect(findLoop('deleted')).not.toBeNull()
    expect(host!.querySelector('button[aria-pressed]')?.textContent).toBe('All Loops(1)')

    await render(initial([]))

    expect(findLoop('deleted')).toBeNull()
  })
})
