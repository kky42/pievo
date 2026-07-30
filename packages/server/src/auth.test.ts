import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

const request = { headers: new Headers() }
vi.mock('@tanstack/react-start/server', () => ({
  getRequest: () => request,
}))

let authMod: typeof import('./auth.js')

function signInAs(id: string | null, email = 'alice@example.com') {
  vi.spyOn(authMod.auth.api, 'getSession').mockResolvedValue(
    id ? ({ user: { id, email } } as unknown as Awaited<ReturnType<typeof authMod.auth.api.getSession>>) : null,
  )
}

beforeAll(async () => {
  process.env.PIEVO_LOG_LEVEL = 'silent'
  process.env.GITHUB_CLIENT_ID = 'gh-id'
  process.env.GITHUB_CLIENT_SECRET = 'gh-secret'
  process.env.PIEVO_AUTH_SECRET = 'test-secret'
  process.env.PIEVO_ALLOWED_LOGINS = 'alice@example.com,@trusted.test,*@wild.test'
  authMod = await import('./auth.js')
})

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('requestScope', () => {
  test('auth mode scopes a signed-in request to its user id', async () => {
    signInAs('user-a')
    await expect(authMod.requestScope()).resolves.toEqual({ enforce: true, userId: 'user-a' })
  })

  test('auth mode leaves a signed-out request unauthorized', async () => {
    signInAs(null)
    await expect(authMod.requestScope()).resolves.toEqual({ enforce: true, userId: null })
  })

  test('an established Better Auth session remains the request identity', async () => {
    signInAs('existing-user', 'blocked@example.com')
    expect(authMod.emailAllowed('blocked@example.com')).toBe(false)
    await expect(authMod.currentUser()).resolves.toEqual({ id: 'existing-user', email: 'blocked@example.com' })
    await expect(authMod.requestScope()).resolves.toEqual({ enforce: true, userId: 'existing-user' })
  })
})

describe('loop ownership authorization', () => {
  test('auth mode permits only the matching owner', () => {
    const scope = { enforce: true, userId: 'user-a' }
    expect(authMod.canAccessLoop('user-a', scope)).toBe(true)
    expect(authMod.canAccessLoop('user-b', scope)).toBe(false)
    expect(authMod.canAccessLoop(undefined, scope)).toBe(false)
  })

  test('signed-out auth mode denies every owner', () => {
    expect(authMod.canAccessLoop('user-a', { enforce: true, userId: null })).toBe(false)
  })

  test('open mode deliberately ignores stored ownership', () => {
    expect(authMod.canAccessLoop('user-b', { enforce: false, userId: null })).toBe(true)
  })
})

test('login allowlist keeps exact and domain matching', () => {
  expect(authMod.emailAllowed('ALICE@example.com')).toBe(true)
  expect(authMod.emailAllowed('person@trusted.test')).toBe(true)
  expect(authMod.emailAllowed('person@wild.test')).toBe(true)
  expect(authMod.emailAllowed('person@other.test')).toBe(false)
  expect(authMod.emailAllowed(null)).toBe(false)
})
