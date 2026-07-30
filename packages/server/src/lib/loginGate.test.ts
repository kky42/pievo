import { afterEach, describe, expect, test } from 'vitest'

import { loginGateEnabled } from './loginGate.js'

const originalClientId = process.env.GITHUB_CLIENT_ID
const originalClientSecret = process.env.GITHUB_CLIENT_SECRET

afterEach(() => {
  if (originalClientId === undefined) delete process.env.GITHUB_CLIENT_ID
  else process.env.GITHUB_CLIENT_ID = originalClientId
  if (originalClientSecret === undefined) delete process.env.GITHUB_CLIENT_SECRET
  else process.env.GITHUB_CLIENT_SECRET = originalClientSecret
})

describe('GitHub login gate configuration', () => {
  test('open mode requires both credentials to be absent', () => {
    delete process.env.GITHUB_CLIENT_ID
    delete process.env.GITHUB_CLIENT_SECRET
    expect(loginGateEnabled()).toBe(false)
  })

  test('auth mode requires both credentials', () => {
    process.env.GITHUB_CLIENT_ID = 'client-id'
    process.env.GITHUB_CLIENT_SECRET = 'client-secret'
    expect(loginGateEnabled()).toBe(true)
  })

  test('a client id without a client secret fails closed', () => {
    process.env.GITHUB_CLIENT_ID = 'client-id'
    delete process.env.GITHUB_CLIENT_SECRET
    expect(() => loginGateEnabled()).toThrow(/incomplete GitHub auth configuration/)
  })

  test('a client secret without a client id fails closed', () => {
    delete process.env.GITHUB_CLIENT_ID
    process.env.GITHUB_CLIENT_SECRET = 'client-secret'
    expect(() => loginGateEnabled()).toThrow(/incomplete GitHub auth configuration/)
  })
})
