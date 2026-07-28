// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { LoopSummary } from '../types'
import { LoopCard } from './LoopCard'

vi.mock('../server/loopApi', () => ({ loadOlderRuns: vi.fn(async () => []) }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const loop: LoopSummary = {
  id: 'loop-1',
  name: 'Active loop',
  schedule: { mode: 'cron', cron: '0 6 * * *', timezone: 'UTC', overlap: 'queue-one' },
  workdir: '/tmp/project',
  agent: 'claude-code',
  model: null,
  reasoningEffort: null,
  machine: { id: 'machine-1', name: 'nex.local', online: true, presence: 'online', lastSeen: null },
  enabled: true,
  nextRun: null,
  running: false,
  queued: false,
  lastRunTs: null,
  runs: [],
  runCount: 0,
}

let host: HTMLDivElement | null = null
let root: ReturnType<typeof createRoot> | null = null

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  host = null
  root = null
})

async function renderLoop(value: LoopSummary) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(createElement(LoopCard, { loop: value, onOpen: () => {}, onPickRun: () => {} }))
  })
}

test('shows lifecycle and agent labels beside the loop name', async () => {
  await renderLoop(loop)

  expect(host!.textContent).toContain('Active loop')
  const labels = [...host!.querySelectorAll('span')].map((element) => element.textContent)
  expect(labels).toContain('Active')
  expect(labels).toContain('Claude Code')
  expect(host!.textContent).not.toContain('·claude-code')
  expect([...host!.querySelectorAll('span')].find((element) => element.textContent === 'Active')?.className).toContain('bg-success-soft')
})

test('shows the shared schedule, next run, machine, and execution metadata', async () => {
  await renderLoop(loop)

  expect(host!.textContent).toContain('daily 06:00 · UTC · overlap queue-one')
  expect(host!.textContent).toContain('next —')
  expect(host!.textContent).toContain('nex.local')
  expect(host!.textContent).toContain('/tmp/project · Model: default · Reasoning: default')
})

test('keeps Active as the loop lifecycle while execution is queued or running', async () => {
  await renderLoop({ ...loop, running: true, queued: true })

  const labels = [...host!.querySelectorAll('span')].map((element) => element.textContent)
  expect(labels).toContain('Active')
  expect(labels).not.toContain('Running')
  expect(labels).not.toContain('Queued')
})
