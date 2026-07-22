// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JobDetail, RunSummary } from '../types'
import { LoopDetailView } from './LoopDetailView'
import { RunDetailView } from './RunView'

const h = vi.hoisted(() => ({
  detail: null as JobDetail | null,
  pause: vi.fn(async () => ({ ok: true })),
  del: vi.fn(async () => ({ ok: true, waiting: true })),
}))
vi.mock('../server/loopApi', () => ({
  getJobDetail: vi.fn(async () => h.detail), loadOlderRuns: vi.fn(async () => []),
  deleteJob: h.del, forceDeleteJob: vi.fn(async () => ({ ok: true, deleted: true })),
  pauseJob: h.pause, startJob: vi.fn(async () => ({ ok: true })), stopJob: vi.fn(async () => ({ ok: true, waiting: true })),
  evolveJob: vi.fn(async () => ({})), patchJob: vi.fn(async () => ({})), requestEdit: vi.fn(async () => ({})), runJob: vi.fn(async () => ({})),
  getRunDiff: vi.fn(async () => null), stopRun: vi.fn(async () => ({ ok: true, waiting: true })),
}))
vi.mock('../server/notifyFns', () => ({ listChannels: vi.fn(async () => []) }))
vi.mock('@tanstack/react-router', () => ({ Link: ({ children }: { children: React.ReactNode }) => createElement('span', null, children), useNavigate: () => () => {} }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const runningRun = (cancelRequested = false): RunSummary => ({
  id: 'r1', loopId: 'l1', ts: '2026-01-01T00:00:00Z', running: true, cancelRequested,
  agent: 'claude-code', status: null, message: null, durationMs: null,
  exitCode: null, finalText: null, usage: null, error: null, state: null, control: null, sessionId: null,
})

type DetailState = 'active' | 'paused' | 'completed' | 'deleting'
function makeDetail(over: { state?: DetailState; online?: boolean; protocol?: number | null; running?: boolean; cancelRequested?: boolean } = {}): JobDetail {
  const state = over.state ?? 'paused'
  const running = over.running ?? false
  const r = runningRun(!!over.cancelRequested)
  const enabled = state === 'active'
  const completedAt = state === 'completed' ? '2026-01-02T00:00:00Z' : null
  const deleteRequestedAt = state === 'deleting' ? '2026-01-01T00:01:00Z' : null
  return {
    job: { id: 'l1', cron: '0 6 * * *', scheduleMode: 'cron', continuousDelayMinutes: 1, enabled, notify: 'auto', agent: 'claude-code', exec: { executor: 'claude-code', workdir: '/tmp/project' } },
    summary: { id: 'l1', name: 'Lifecycle loop', cron: '0 6 * * *', kind: 'exec:claude-code', enabled, notify: 'auto', nextRun: null, running, lastRunTs: running ? r.ts : null, graduation: null, completedAt, deleteRequestedAt, runs: running ? [r] : [], runCount: running ? 1 : 0 },
    taskFileContent: null, taskFileSyncedAt: null, runs: running ? [r] : [],
    machine: { id: 'm1', name: 'MacBook Pro', online: over.online ?? true, presence: (over.online ?? true) ? 'online' : 'offline', lastSeen: null, daemonProtocol: over.protocol === undefined ? 2 : over.protocol, daemonVersion: '2.0.1', needsUpdate: false, requiredDaemonVersion: '2.0.1' },
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
function button(label: string) {
  return [...host!.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined
}
function enabled(label: string) {
  const found = button(label)
  expect(found, `${label} is rendered`).toBeTruthy()
  return !found!.disabled
}

afterEach(async () => {
  h.pause.mockClear(); h.del.mockClear()
  if (root) await act(async () => root!.unmount())
  host?.remove(); host = null; root = null
})

describe('LoopDetailView flat lifecycle actions', () => {
  it.each([
    ['active', ['Run once', 'Agent edit', 'Evolve once', 'Settings', 'Pause', 'Delete'], ['Start', 'Stop', 'Reopen']],
    ['paused', ['Run once', 'Agent edit', 'Evolve once', 'Settings', 'Start', 'Delete'], ['Pause', 'Stop', 'Reopen']],
    ['completed', ['Agent edit', 'Settings', 'Reopen', 'Delete'], ['Run once', 'Evolve once', 'Start', 'Pause', 'Stop']],
    ['deleting', [], ['Run once', 'Agent edit', 'Evolve once', 'Settings', 'Start', 'Pause', 'Stop', 'Reopen', 'Deleting…']],
  ] as const)('shows every action with the %s availability matrix', async (state, on, off) => {
    await mount(makeDetail({ state }))
    expect(host!.querySelector('[aria-label="More actions"]')).toBeNull()
    expect(button('Run once')?.parentElement?.className).toContain('flex-wrap')
    expect(button('Run once')?.parentElement?.className).toContain('min-w-0')
    expect(host!.textContent).not.toContain('Push…')
    for (const label of on) expect(enabled(label), `${label} enabled`).toBe(true)
    for (const label of off) expect(enabled(label), `${label} disabled`).toBe(false)
    expect(host!.querySelectorAll('button')).toHaveLength(9)
  })

  it('enables Stop only for a running run and keeps protocol gating actionable', async () => {
    await mount(makeDetail({ state: 'paused', running: true, protocol: 2 }))
    expect(enabled('Stop')).toBe(true)
    await act(async () => { root!.unmount() }); root = null; host!.remove(); host = null
    await mount(makeDetail({ state: 'active', running: true, protocol: 1 }))
    expect(enabled('Stop')).toBe(false)
    expect(button('Stop')?.title).toContain('Daemon upgrade required')
  })

  it('executes non-delete actions directly and Agent edit has no Settings sub-entry', async () => {
    await mount(makeDetail({ state: 'active' }))
    await act(async () => { button('Pause')!.click(); await Promise.resolve() })
    expect(h.pause).toHaveBeenCalledOnce()
    expect(host!.textContent).not.toContain('Pause future runs?')
    await act(async () => { button('Agent edit')!.click(); await Promise.resolve() })
    expect(host!.textContent).toContain('Dispatch to your coding agent')
    expect(host!.textContent).toContain('Copy prompt')
    expect(host!.textContent).not.toContain('Manual settings')
  })

  it('uses one complete Delete confirmation and no force-delete second step', async () => {
    await mount(makeDetail({ state: 'active', online: false, running: true }))
    await act(async () => { button('Delete')!.click(); await Promise.resolve() })
    expect(host!.textContent).toContain('This stops the loop and deletes server history and synced artifacts.')
    expect(host!.textContent).toContain('Local files are not deleted.')
    expect(host!.textContent).toContain('If the machine is unreachable, server data is still deleted and its local process may continue running.')
    expect(host!.textContent).not.toContain('Delete server data anyway')
    const confirms = [...host!.querySelectorAll('button')].filter((b) => b.textContent === 'Delete')
    await act(async () => { confirms.at(-1)!.click(); await Promise.resolve() })
    expect(h.del).toHaveBeenCalledOnce()
  })

  it('distinguishes owner and automatic pauses', async () => {
    const owner = makeDetail({ state: 'paused' })
    owner.summary.pauseCause = { kind: 'owner', at: '2026-01-01T00:00:00Z' }
    await mount(owner)
    expect(host!.textContent).toContain('Paused by owner')
    await act(async () => { root!.unmount() }); root = null; host!.remove(); host = null
    const automatic = makeDetail({ state: 'paused' })
    automatic.summary.pauseCause = { kind: 'failure-streak', at: '2026-01-01T00:00:00Z', runId: 'r1', count: 3 }
    await mount(automatic)
    expect(host!.textContent).toContain('Paused automatically')
  })

  it('renders the latest run terminal report warning on the loop page', async () => {
    const d = makeDetail({ state: 'active' })
    const latest: RunSummary = { ...runningRun(), id: 'newest', ts: '2026-01-02T00:00:00Z', running: false }
    latest.reportIncident = {
      at: '2026-01-02T00:00:00Z', code: 'REPORT_INVALID', reason: 'Terminal report rejected.',
      issues: ['durationMs must be non-negative'], reportId: 'report-newest', payloadDigest: 'digest',
      faultDomain: 'compatibility', recommendedAction: 'Upgrade and restart the daemon.',
    }
    const oldest: RunSummary = { ...runningRun(), id: 'oldest', ts: '2026-01-01T00:00:00Z', running: false }
    d.runs = [latest, oldest]
    d.summary.runs = d.runs
    d.summary.runCount = d.runs.length
    await mount(d)
    expect(host!.textContent).toContain('Last run telemetry warning · Terminal report rejected')
  })

  it('renders terminal report diagnostics on the run page', async () => {
    const d = makeDetail({ state: 'active', running: true })
    const run = d.runs[0]!
    run.running = false
    run.error = 'Terminal report rejected.'
    run.reportIncident = {
      at: '2026-01-01T00:00:00Z', code: 'REPORT_INVALID', reason: run.error,
      issues: ['durationMs must be non-negative'], reportId: 'report-1', payloadDigest: 'digest',
      faultDomain: 'compatibility', recommendedAction: 'Upgrade and restart the daemon.',
    }
    h.detail = d
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
    await act(async () => { root!.render(createElement(RunDetailView, { loopId: 'l1', runId: 'r1' })) })
    await act(async () => { await Promise.resolve() })
    expect(host!.textContent).toContain('Terminal report rejected')
    expect(host!.textContent).toContain('REPORT_INVALID')
    expect(host!.textContent).toContain('compatibility')
    expect(host!.textContent).toContain('Upgrade and restart the daemon.')
    expect(host!.textContent).toContain('report-1')
  })

  it('keeps truthful paused/stopping and RunView protocol wording', async () => {
    await mount(makeDetail({ state: 'paused', online: false, running: true, cancelRequested: true }))
    expect(host!.textContent).toContain('Stopping · waiting for MacBook Pro')
    await act(async () => { root!.unmount() }); root = null; host!.remove(); host = null
    const d = makeDetail({ state: 'paused', protocol: 1, running: true })
    h.detail = d
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
    await act(async () => { root!.render(createElement(RunDetailView, { loopId: 'l1', runId: 'r1' })) })
    await act(async () => { await Promise.resolve() })
    expect(button('Stop run')?.title).toContain('pievo daemon restart')
  })
})
