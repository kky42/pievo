// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JobDetail, RunSummary } from '../types'
import { LoopDetailView } from './LoopDetailView'
import { RunDetailView } from './RunView'

const h = vi.hoisted(() => ({ detail: null as JobDetail | null }))
vi.mock('../server/loopApi', () => ({
  getJobDetail: vi.fn(async () => h.detail), loadOlderRuns: vi.fn(async () => []),
  deleteJob: vi.fn(async () => ({ ok: true, waiting: true })), forceDeleteJob: vi.fn(async () => ({ ok: true, deleted: true })),
  pauseJob: vi.fn(async () => ({ ok: true })), startJob: vi.fn(async () => ({ ok: true })), stopJob: vi.fn(async () => ({ ok: true, waiting: true })),
  evolveJob: vi.fn(async () => ({})), patchJob: vi.fn(async () => ({})), requestEdit: vi.fn(async () => ({})), runJob: vi.fn(async () => ({})),
  getRunDiff: vi.fn(async () => null), stopRun: vi.fn(async () => ({ ok: true, waiting: true })),
}))
vi.mock('../server/notifyFns', () => ({ listChannels: vi.fn(async () => []) }))
vi.mock('@tanstack/react-router', () => ({ Link: ({ children }: { children: React.ReactNode }) => createElement('span', null, children), useNavigate: () => () => {} }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const runningRun = (cancelRequested: boolean): RunSummary => ({
  id: 'r1', loopId: 'l1', ts: '2026-01-01T00:00:00Z', running: true, cancelRequested,
  agent: 'claude-code', outcome: 'exec', status: null, message: null, durationMs: null,
  exitCode: null, finalText: null, usage: null, error: null, state: null, control: null, sessionId: null,
})
function makeDetail(over: { online?: boolean; protocol?: number | null; deleting?: boolean; cancelRequested?: boolean } = {}): JobDetail {
  const r = runningRun(!!over.cancelRequested)
  return {
    job: { id: 'l1', cron: '0 6 * * *', scheduleMode: 'cron', continuousDelayMinutes: 1, enabled: false, notify: 'auto', agent: 'claude-code', exec: { executor: 'claude-code', workdir: '/tmp/project' } },
    summary: { id: 'l1', name: 'Lifecycle loop', cron: '0 6 * * *', kind: 'exec:claude-code', enabled: false, notify: 'auto', nextRun: null, running: true, lastRunTs: r.ts, graduation: null, deleteRequestedAt: over.deleting ? '2026-01-01T00:01:00Z' : null, runs: [r], runCount: 1 },
    taskFileContent: null, taskFileSyncedAt: null, runs: [r],
    machine: { id: 'm1', name: 'MacBook Pro', online: over.online ?? true, presence: (over.online ?? true) ? 'online' : 'offline', lastSeen: null, daemonProtocol: over.protocol === undefined ? 2 : over.protocol },
  }
}

let host: HTMLDivElement | null = null
let root: Root | null = null
async function mount(d: JobDetail) {
  h.detail = d
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  await act(async () => { root!.render(createElement(LoopDetailView, { id: 'l1' })) })
  await act(async () => { await Promise.resolve() })
}
afterEach(async () => { if (root) await act(async () => root!.unmount()); host?.remove(); host = null; root = null })

describe('Dashboard lifecycle reliability wording', () => {
  it('shows a paused run as finishing, never Canceled', async () => {
    await mount(makeDetail())
    expect(host!.textContent).toContain('Paused · current run finishing')
    expect(host!.textContent).not.toContain('Canceled')
    expect(host!.textContent).toContain('Daemon protocol 2 · Stop supported')
  })

  it('shows the exact offline Stop state without claiming cancellation', async () => {
    await mount(makeDetail({ online: false, cancelRequested: true }))
    expect(host!.textContent).toContain('Stopping · waiting for MacBook Pro')
    expect(host!.textContent).not.toContain('Canceled')
  })

  it('requires a second force-delete confirmation and shows the exact uncertainty warning', async () => {
    await mount(makeDetail({ online: false, deleting: true, cancelRequested: true }))
    expect(host!.textContent).toContain('Server deletion is waiting for execution authority to end.')
    const first = [...host!.querySelectorAll('button')].find((button) => button.textContent === 'Delete server data anyway')
    expect(first).toBeTruthy()
    await act(async () => { first!.click(); await Promise.resolve() })
    expect(host!.textContent).toContain('The machine is unreachable. Its local process may still be running. This removes Pievo authority and server data only.')
    expect([...host!.querySelectorAll('button')].filter((button) => button.textContent === 'Delete server data anyway')).toHaveLength(1)
  })

  it.each([1, null])('gates both Stop and Delete for an active run on incompatible protocol %s', async (protocol) => {
    await mount(makeDetail({ protocol, cancelRequested: false }))
    expect(host!.textContent).toContain('Daemon upgrade required to stop a running process')
    expect(host!.textContent).toContain('npm install -g @kky42/pievo@latest')
    expect(host!.textContent).toContain('pievo daemon restart')
    expect(host!.textContent).toContain(`Daemon protocol ${protocol ?? 'unknown'} · upgrade required`)

    const more = host!.querySelector('button[aria-label="More actions"]') as HTMLButtonElement
    await act(async () => { more.click(); await new Promise((resolve) => setTimeout(resolve, 0)) })
    for (const label of ['Stop', 'Delete']) {
      const item = ([...document.body.querySelectorAll('[role="menuitem"]')] as HTMLElement[]).find((el) => el.textContent === label)
      expect(item, `${label} menu item`).toBeTruthy()
      expect(item!.getAttribute('data-disabled')).not.toBeNull()
      expect(item!.getAttribute('title')).toBe('Daemon upgrade required to stop a running process. Run `npm install -g @kky42/pievo@latest`, then `pievo daemon restart`.')
    }
  })

  it('RunView uses the same actionable daemon upgrade flow', async () => {
    const d = makeDetail({ protocol: 1 })
    h.detail = d
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
    await act(async () => { root!.render(createElement(RunDetailView, { loopId: 'l1', runId: 'r1' })) })
    await act(async () => { await Promise.resolve() })
    const stop = [...host!.querySelectorAll('button')].find((button) => button.textContent === 'Stop run')
    expect(stop?.getAttribute('title')).toContain('Daemon upgrade required')
    expect(stop?.getAttribute('title')).toContain('npm install -g @kky42/pievo@latest')
    expect(stop?.getAttribute('title')).toContain('pievo daemon restart')
  })

  it('renders the exact Pause, Stop, and Delete confirmation copy', async () => {
    const d = makeDetail()
    d.job.enabled = true; d.summary.enabled = true; d.summary.running = false; d.summary.runs = []; d.runs = []
    await mount(d)
    const openMenu = async () => {
      const more = host!.querySelector('button[aria-label="More actions"]') as HTMLButtonElement
      await act(async () => { more.click(); await new Promise((resolve) => setTimeout(resolve, 0)) })
    }
    await openMenu()
    const assertConfirm = async (label: string, expected: string) => {
      const item = ([...document.body.querySelectorAll('[role="menuitem"]')] as HTMLElement[]).find((el) => el.textContent === label)
      expect(item, `${label} menu item`).toBeTruthy()
      await act(async () => { item!.click(); await Promise.resolve() })
      expect(host!.textContent).toContain(expected)
    }
    await assertConfirm('Pause', 'Pause future runs? The current run will continue.')
    // Re-open the menu after canceling each inline confirmation.
    await act(async () => { ([...host!.querySelectorAll('button')].find((b) => b.textContent === 'Cancel') as HTMLButtonElement).click(); await Promise.resolve() })
    await openMenu()
    await assertConfirm('Stop', 'Pause this loop, cancel queued work, and stop the current run if it is still running?')
    await act(async () => { ([...host!.querySelectorAll('button')].find((b) => b.textContent === 'Cancel') as HTMLButtonElement).click(); await Promise.resolve() })
    await openMenu()
    await assertConfirm('Delete', 'Stop this loop and delete its Pievo history and synced artifacts? Local project files are not deleted.')
  })
})
