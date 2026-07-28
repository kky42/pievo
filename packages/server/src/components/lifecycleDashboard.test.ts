// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LoopDetail, RunSummary } from '../types'
import { LoopDetailView } from './LoopDetailView'
import { RunDetailView } from './RunView'

const h = vi.hoisted(() => ({
  detail: null as LoopDetail | null,
  pause: vi.fn(async () => ({ ok: true })),
  del: vi.fn(async () => ({ ok: true, waiting: true })),
}))
vi.mock('../server/loopApi', () => ({
  getLoopDetail: vi.fn(async () => h.detail), loadOlderRuns: vi.fn(async () => []),
  deleteLoop: h.del,
  pauseLoop: h.pause, startLoop: vi.fn(async () => ({ ok: true })), stopLoop: vi.fn(async () => ({ ok: true, waiting: true })),
  patchLoop: vi.fn(async () => ({})), runLoop: vi.fn(async () => ({})),
  getRunDiff: vi.fn(async () => null), stopRun: vi.fn(async () => ({ ok: true, waiting: true })),
}))
vi.mock('@tanstack/react-router', () => ({ Link: ({ children }: { children: React.ReactNode }) => createElement('span', null, children), useNavigate: () => () => {} }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const runningRun = (cancelRequested = false): RunSummary => ({
  id: 'r1', loopId: 'l1', ts: '2026-01-01T00:00:00Z', phase: 'running', cancelRequested,
  agent: 'claude-code', status: null, message: null, durationMs: null,
  exitCode: null, finalText: null, usage: null, error: null, sessionId: null,
})

type DetailState = 'active' | 'paused' | 'deleting'
function makeDetail(over: { state?: DetailState; online?: boolean; protocol?: number | null; running?: boolean; cancelRequested?: boolean } = {}): LoopDetail {
  const state = over.state ?? 'paused'
  const running = over.running ?? false
  const r = runningRun(!!over.cancelRequested)
  const enabled = state === 'active'
  const deleteRequestedAt = state === 'deleting' ? '2026-01-01T00:01:00Z' : null
  return {
    loop: { id: 'l1', name: 'Lifecycle loop', schedule: { mode: 'cron', cron: '0 6 * * *', timezone: 'UTC', overlap: 'queue-one' }, workdir: '/tmp/project', agent: 'claude-code', model: null, reasoningEffort: null, prompt: 'Do the work.', statusDefinitions: { keep: 'keep it', noChange: 'nothing needed', block: 'needs help' }, artifacts: [], enabled },
    summary: { id: 'l1', name: 'Lifecycle loop', schedule: { mode: 'cron', cron: '0 6 * * *', timezone: 'UTC', overlap: 'queue-one' }, workdir: '/tmp/project', agent: 'claude-code', model: null, reasoningEffort: null, enabled, nextRun: null, running, lastRunTs: running ? r.ts : null, deleteRequestedAt, runs: running ? [r] : [], runCount: running ? 1 : 0 },
    runs: running ? [r] : [],
    machine: { id: 'm1', name: 'MacBook Pro', online: over.online ?? true, presence: (over.online ?? true) ? 'online' : 'offline', lastSeen: null, daemonProtocol: over.protocol === undefined ? 4 : over.protocol, daemonVersion: '2.4.0', needsUpdate: false, requiredDaemonVersion: '2.4.0' },
  }
}

let host: HTMLDivElement | null = null
let root: Root | null = null
async function mount(d: LoopDetail) {
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
    ['active', ['Run once', 'Settings', 'Pause', 'Delete'], ['Start', 'Stop']],
    ['paused', ['Run once', 'Settings', 'Start', 'Delete'], ['Pause', 'Stop']],
    ['deleting', [], ['Run once', 'Settings', 'Start', 'Pause', 'Stop', 'Deleting…']],
  ] as const)('shows every action with the %s availability matrix', async (state, on, off) => {
    await mount(makeDetail({ state }))
    expect(host!.querySelector('[aria-label="More actions"]')).toBeNull()
    expect(button('Run once')?.parentElement?.className).toContain('flex-wrap')
    expect(button('Run once')?.parentElement?.className).toContain('min-w-0')
    expect(host!.textContent).not.toContain('Push…')
    for (const label of on) expect(enabled(label), `${label} enabled`).toBe(true)
    for (const label of off) expect(enabled(label), `${label} disabled`).toBe(false)
    expect(host!.querySelectorAll('button')).toHaveLength(6)
  })

  it('enables Stop only for a running run and keeps protocol gating actionable', async () => {
    await mount(makeDetail({ state: 'paused', running: true, protocol: 4 }))
    expect(enabled('Stop')).toBe(true)
    await act(async () => { root!.unmount() }); root = null; host!.remove(); host = null
    await mount(makeDetail({ state: 'active', running: true, protocol: 1 }))
    expect(enabled('Stop')).toBe(false)
    expect(button('Stop')?.title).toContain('Daemon upgrade required')
  })

  it('executes non-delete actions directly', async () => {
    await mount(makeDetail({ state: 'active' }))
    await act(async () => { button('Pause')!.click(); await Promise.resolve() })
    expect(h.pause).toHaveBeenCalledOnce()
    expect(host!.textContent).not.toContain('Pause future runs?')
  })

  it('uses one complete Delete confirmation and no force-delete second step', async () => {
    await mount(makeDetail({ state: 'active', online: false, running: true }))
    await act(async () => { button('Delete')!.click(); await Promise.resolve() })
    expect(host!.textContent).toContain('This stops the loop and deletes server history and collected artifacts.')
    expect(host!.textContent).toContain('Files in the working directory are not deleted.')
    expect(host!.textContent).toContain('If the machine is unreachable, its local process may continue running.')
    expect(host!.textContent).not.toContain('Delete server data anyway')
    const confirms = [...host!.querySelectorAll('button')].filter((b) => b.textContent === 'Delete')
    await act(async () => { confirms.at(-1)!.click(); await Promise.resolve() })
    expect(h.del).toHaveBeenCalledOnce()
  })

  it('distinguishes owner and automatic pauses', async () => {
    const owner = makeDetail({ state: 'paused' })
    owner.summary.pauseCause = { kind: 'owner', at: '2026-01-01T00:00:00Z' }
    await mount(owner)
    expect(host!.textContent).toContain('Paused · owner')
    await act(async () => { root!.unmount() }); root = null; host!.remove(); host = null
    const automatic = makeDetail({ state: 'paused' })
    automatic.summary.pauseCause = { kind: 'failure-streak', at: '2026-01-01T00:00:00Z', runId: 'r1', count: 3 }
    await mount(automatic)
    expect(host!.textContent).toContain('Paused · failure streak')
  })

  it('shows one input-plus-output token total and ignores cache telemetry', async () => {
    const d = makeDetail({ state: 'active', running: true })
    const run = d.runs[0]!
    run.usage = { inputTokens: 1_000, outputTokens: 250, cacheReadTokens: 50_000, cacheCreationTokens: 10_000 }
    h.detail = d
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
    await act(async () => { root!.render(createElement(RunDetailView, { loopId: 'l1', runId: 'r1' })) })
    await act(async () => { await Promise.resolve() })
    expect(host!.textContent).toContain('Token usage1.3k tokens')
    expect(host!.textContent).not.toContain('50,000')
    expect(host!.textContent).not.toContain('in ·')

    run.usage = { cacheReadTokens: 50_000, cacheCreationTokens: 10_000 }
    await act(async () => { root!.render(createElement(RunDetailView, { loopId: 'l1', runId: 'r1' })) })
    await act(async () => { await Promise.resolve() })
    expect(host!.textContent).not.toContain('Token usage')
  })

  it('renders terminal report diagnostics on the run page', async () => {
    const d = makeDetail({ state: 'active', running: true })
    const run = d.runs[0]!
    run.phase = 'error'
    run.error = 'Terminal report rejected.'
    run.reportIncident = {
      at: '2026-01-01T00:00:00Z', code: 'REPORT_INVALID', reason: run.error,
      issues: ['durationMs must be non-negative'], reportId: 'report-1', payloadDigest: 'digest',
      faultDomain: 'protocol', recommendedAction: 'Upgrade and restart the daemon.',
    }
    h.detail = d
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
    await act(async () => { root!.render(createElement(RunDetailView, { loopId: 'l1', runId: 'r1' })) })
    await act(async () => { await Promise.resolve() })
    expect(host!.textContent).toContain('Terminal report rejected')
    expect(host!.textContent).toContain('REPORT_INVALID')
    expect(host!.textContent).toContain('protocol')
    expect(host!.textContent).toContain('Upgrade and restart the daemon.')
    expect(host!.textContent).toContain('report-1')
  })

  it('keeps execution transients out of the lifecycle badge and preserves RunView protocol wording', async () => {
    const stopping = makeDetail({ state: 'paused', online: false, running: true, cancelRequested: true })
    stopping.summary.pauseCause = { kind: 'owner', at: '2026-01-01T00:00:00Z' }
    await mount(stopping)
    expect(host!.textContent).toContain('Paused · owner')
    await act(async () => { root!.unmount() }); root = null; host!.remove(); host = null
    const d = makeDetail({ state: 'paused', protocol: 1, running: true })
    h.detail = d
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
    await act(async () => { root!.render(createElement(RunDetailView, { loopId: 'l1', runId: 'r1' })) })
    await act(async () => { await Promise.resolve() })
    expect(button('Stop run')?.title).toContain('pievo daemon restart')
  })
})
