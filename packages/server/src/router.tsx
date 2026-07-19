import { createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

// The TanStack Start vite plugin resolves the router entry by calling
// `getRouter()` — this export name is the contract (>=1.169).
export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: 'intent',
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
