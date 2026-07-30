// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const h = vi.hoisted(() => ({
  auth: { enabled: false },
  session: null as null | { user: { name: string; email: string } },
  sessionPending: false,
  fetchLiveData: vi.fn(async () => ({ loops: [], machines: [] })),
  dashboard: vi.fn(() => null),
  signInSocial: vi.fn(),
}))

vi.mock('./__root', async () => {
  const { createRootRoute, Outlet } = await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router')
  const { createElement } = await vi.importActual<typeof import('react')>('react')
  return { Route: createRootRoute({ component: () => createElement(Outlet) }) }
})
vi.mock('../server/loopApi', () => ({
  getAuthState: vi.fn(async () => h.auth),
}))
vi.mock('../lib/auth-client', () => ({
  signIn: { social: h.signInSocial },
  signOut: vi.fn(),
  useSession: () => ({ data: h.session, isPending: h.sessionPending }),
}))
vi.mock('../components/DashboardView', () => ({
  fetchLiveData: h.fetchLiveData,
  DashboardView: h.dashboard,
}))
vi.mock('../components/LoopDetailView', () => ({ LoopDetailView: () => null }))
vi.mock('../components/RunView', () => ({ RunDetailView: () => null }))

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
  h.auth = { enabled: false }
  h.session = null
  h.sessionPending = false
  h.fetchLiveData.mockClear()
  h.fetchLiveData.mockResolvedValue({ loops: [], machines: [] })
  h.dashboard.mockClear()
  h.signInSocial.mockClear()
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  host = null
  root = null
})

function signInButton(): HTMLButtonElement {
  const button = [...host!.querySelectorAll('button')].find((candidate) => candidate.textContent === 'Continue with GitHub')
  expect(button).toBeDefined()
  return button!
}

async function clickSignIn() {
  await act(async () => {
    signInButton().click()
    await Promise.resolve()
  })
}

describe('dashboard route', () => {
  test('loads dashboard data in open mode and for an allowed signed-in session', async () => {
    await renderPath('/')
    expect(h.fetchLiveData).toHaveBeenCalled()

    await act(async () => root!.unmount())
    host!.remove()
    root = null
    host = null
    h.fetchLiveData.mockClear()
    h.auth = { enabled: true }
    h.session = { user: { name: 'Alice', email: 'alice@example.com' } }

    await renderPath('/')
    expect(h.fetchLiveData).toHaveBeenCalled()
  })

  test('gates signed-out auth mode and sends the dashboard callback URL', async () => {
    h.auth = { enabled: true }
    await renderPath('/')
    expect(h.fetchLiveData).toHaveBeenCalled()
    expect(h.dashboard).not.toHaveBeenCalled()
    expect(host!.textContent).toContain('Continue with GitHub')
    await clickSignIn()
    expect(h.signInSocial).toHaveBeenCalledWith({ provider: 'github', callbackURL: '/' })
  })

  test('waits for Better Auth session resolution before choosing a gated view', async () => {
    h.auth = { enabled: true }
    h.sessionPending = true
    await renderPath('/')
    expect(host!.textContent).toContain('Loading…')
    expect(host!.textContent).not.toContain('Continue with GitHub')
    expect(h.dashboard).not.toHaveBeenCalled()
  })
})

describe('direct loop and run routes', () => {
  test.each([
    ['/loops/loop-1', '/loops/loop-1'],
    ['/loops/loop-1/runs/run-2', '/loops/loop-1/runs/run-2'],
  ])('preserves %s as the signed-out OAuth callback', async (path, callbackURL) => {
    h.auth = { enabled: true }
    await renderPath(path)
    await clickSignIn()
    expect(h.signInSocial).toHaveBeenCalledWith({ provider: 'github', callbackURL })
  })

  test('the signed-out run route renders only the SignIn main landmark', async () => {
    h.auth = { enabled: true }
    await renderPath('/loops/loop-1/runs/run-2')
    expect(host!.querySelectorAll('main')).toHaveLength(1)
  })

  test.each(['/loops/loop-1', '/loops/loop-1/runs/run-2'])('shows the open-mode warning on %s', async (path) => {
    await renderPath(path)
    expect(host!.textContent).toContain('Open mode:')
    expect(host!.textContent).toContain('anyone who can reach this server')
  })

  test('auth-mode direct links do not show the open-mode warning', async () => {
    h.auth = { enabled: true }
    h.session = { user: { name: 'Alice', email: 'alice@example.com' } }
    await renderPath('/loops/loop-1')
    expect(host!.textContent).not.toContain('Open mode:')
  })
})

describe('removed routes', () => {
  test.each(['/t/stale', '/invite/stale'])('%s resolves as a global not-found', async (path) => {
    const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) })
    const matches = router.matchRoutes(path)
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({ routeId: '__root__', globalNotFound: true })
  })
})
