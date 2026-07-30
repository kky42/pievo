import { beforeAll, expect, test, vi } from 'vitest'

vi.mock('@tanstack/react-start/server', () => ({
  getRequest: () => { throw new Error('open-mode scope must not read a session') },
}))

let authMod: typeof import('./auth.js')

beforeAll(async () => {
  process.env.PIEVO_LOG_LEVEL = 'silent'
  delete process.env.GITHUB_CLIENT_ID
  delete process.env.GITHUB_CLIENT_SECRET
  delete process.env.PIEVO_AUTH_SECRET
  authMod = await import('./auth.js')
})

test('open mode creates an unscoped request without querying a session', async () => {
  expect(authMod.authEnabled).toBe(false)
  await expect(authMod.requestScope()).resolves.toEqual({ enforce: false, userId: null })
})
