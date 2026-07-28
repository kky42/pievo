// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LoopDetailView } from './LoopDetailView'
import type { LoopDetail } from '../types'

/* Cross-team links must never silently change the user's active team. */

const h = vi.hoisted(() => ({ detail: null as LoopDetail | null }))

vi.mock('../server/loopApi', () => ({
  getLoopDetail: vi.fn(async () => h.detail),
  loadOlderRuns: vi.fn(async () => []),
  deleteLoop: vi.fn(async () => ({})),
  pauseLoop: vi.fn(async () => ({})),
  startLoop: vi.fn(async () => ({})),
  stopLoop: vi.fn(async () => ({})),
  patchLoop: vi.fn(async () => ({})),
  runLoop: vi.fn(async () => ({})),
}))

// The page renders TanStack <Link>s + useNavigate; outside a router they throw.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => createElement('span', null, children),
  useNavigate: () => () => {},
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const detailWithTeam = (team: LoopDetail['team']): LoopDetail =>
  ({
    loop: {
      id: 'l1', name: 'Daily react-doctor triage',
      schedule: { mode: 'cron', cron: '0 6 * * *', timezone: 'UTC', overlap: 'queue-one' },
      workdir: '/tmp/react-doctor', agent: 'claude-code', model: null, reasoningEffort: null,
      prompt: 'Run react doctor.', statusDefinitions: { keep: 'fixed', noChange: 'clean', block: 'needs owner' }, artifacts: [], enabled: true,
    },
    summary: {
      id: 'l1', name: 'Daily react-doctor triage',
      schedule: { mode: 'cron', cron: '0 6 * * *', timezone: 'UTC', overlap: 'queue-one' },
      workdir: '/tmp/react-doctor', agent: 'claude-code', model: null, reasoningEffort: null,
      machine: { id: 'm1', name: 'repro-box', online: true, presence: 'online', lastSeen: null },
      enabled: true,
      nextRun: '2026-07-08T13:00:00.000Z',
      running: false,
      lastRunTs: null,
      runs: [],
      runCount: 0,
      recentUsage: { runCount: 0, tokenCount: 0 },
    },
    machine: { id: 'm1', name: 'repro-box', online: true, presence: 'online', lastSeen: null, daemonProtocol: 4 },
    team,
    runs: [],
  }) as unknown as LoopDetail

let host: HTMLDivElement | null = null
let root: Root | null = null

async function mount() {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(createElement(LoopDetailView, { id: 'l1' }))
  })
  await act(async () => {
    await Promise.resolve()
  })
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  host = null
  root = null
})

describe('loop detail cross-team header', () => {
  it('a member viewing a cross-team loop sees the team chip + explicit switch banner', async () => {
    h.detail = detailWithTeam({ id: 'team-b', name: 'Acme Web', isActive: false })
    await mount()
    const text = host!.textContent ?? ''
    expect(text).toContain('Viewing a loop in Acme Web')
    expect(text).toContain('not your active team')
    expect(text).toContain('Switch to this team')
    expect(text).toContain('Acme Web')
    expect(text).toContain('Daily react-doctor triage')

    const header = host!.querySelector('header')
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pievo-cross-team-evidence-'))
    fs.writeFileSync(path.join(dir, 'loop-header-cross-team.html'), header?.outerHTML ?? '', 'utf8')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('the switch banner is a button that sets the team cookie and does NOT silently switch', async () => {
    h.detail = detailWithTeam({ id: 'team-b', name: 'Acme Web', isActive: false })
    await mount()
    expect(document.cookie).not.toContain('pievo.team')
    const btn = [...host!.querySelectorAll('button')].find((b) => b.textContent?.includes('Switch to this team'))
    expect(btn).toBeTruthy()
    Object.defineProperty(window, 'location', { value: { ...window.location, reload: () => {} }, writable: true })
    await act(async () => {
      btn!.click()
    })
    expect(document.cookie).toContain('pievo.team=team-b')
  })

  it('a loop in the caller’s ACTIVE team shows no chip and no switch banner', async () => {
    h.detail = detailWithTeam({ id: 'team-a', name: 'Acme Web', isActive: true })
    await mount()
    const text = host!.textContent ?? ''
    expect(text).not.toContain('Switch to this team')
    expect(text).not.toContain('Viewing a loop in')
    expect(text).toContain('Daily react-doctor triage')
  })

  it('open mode (no team context) shows no chip and no switch banner', async () => {
    h.detail = detailWithTeam(null)
    await mount()
    const text = host!.textContent ?? ''
    expect(text).not.toContain('Switch to this team')
    expect(text).not.toContain('Viewing a loop in')
    expect(text).toContain('Daily react-doctor triage')
  })
})
