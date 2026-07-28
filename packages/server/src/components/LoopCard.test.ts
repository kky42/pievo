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

test('shows Active beside the name for an idle enabled loop', async () => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(createElement(LoopCard, { loop, onOpen: () => {}, onPickRun: () => {} }))
  })

  expect(host.textContent).toContain('Active loop')
  expect([...host.querySelectorAll('span')].some((element) => element.textContent === 'Active')).toBe(true)
})
