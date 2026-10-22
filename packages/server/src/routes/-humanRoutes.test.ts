// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const h = vi.hoisted(() => ({
  fetchLiveData: vi.fn(async () => ({ loops: [], machines: [] })),
  dashboard: vi.fn(() => null),
  loopDetail: vi.fn(() => null),
  runDetail: vi.fn(() => null),
}))

vi.mock('./__root', async () => {
  const { createRootRoute, Outlet } = await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router')
  const { createElement } = await vi.importActual<typeof import('react')>('react')
  return { Route: createRootRoute({ component: () => createElement(Outlet) }) }
})
vi.mock('../components/DashboardView', () => ({
  fetchLiveData: h.fetchLiveData,
  DashboardView: h.dashboard,
}))
vi.mock('../components/LoopDetailView', () => ({ LoopDetailView: h.loopDetail }))
vi.mock('../components/RunView', () => ({ RunDetailView: h.runDetail }))

import { routeTree } from '../routeTree.gen'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
window.scrollTo = vi.fn()

let host: HTMLDivElement | null = null
let root: Root | null = null

async function renderPath(path: string) {
  const history = createMemoryHistory({ initialEntries: [path] })
  const router = createRouter({ routeTree, history })
  await act(async () => {
    await router.load()
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(createElement(RouterProvider, { router }))
    await Promise.resolve()
  })
  return router
}

beforeEach(() => {
  h.fetchLiveData.mockClear()
  h.fetchLiveData.mockResolvedValue({ loops: [], machines: [] })
  h.dashboard.mockClear()
  h.loopDetail.mockClear()
  h.runDetail.mockClear()
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  host = null
  root = null
})

test('the dashboard route loads live data and renders the dashboard', async () => {
  await renderPath('/')
  expect(h.fetchLiveData).toHaveBeenCalled()
  expect(h.dashboard).toHaveBeenCalled()
})

test('direct loop and run links render their views', async () => {
  await renderPath('/loops/loop-1')
  expect(h.loopDetail).toHaveBeenCalledWith(expect.objectContaining({ id: 'loop-1' }), undefined)
  await act(async () => root!.unmount())
  host!.remove()
  root = null
  host = null

  await renderPath('/loops/loop-1/runs/run-2')
  expect(h.runDetail).toHaveBeenCalledWith(expect.objectContaining({ loopId: 'loop-1', runId: 'run-2' }), undefined)
  expect(host!.querySelectorAll('main')).toHaveLength(1)
})
