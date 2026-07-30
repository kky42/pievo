import { describe, expect, test } from 'vitest'

import { machineInScope, tokenVisibleTo } from './machineScope.js'

const machine = { userId: 'user-a' }

describe('machine owner scope', () => {
  test('auth mode permits only the signed-in owner', () => {
    expect(machineInScope(machine, { enforce: true, userId: 'user-a' })).toBe(true)
    expect(machineInScope(machine, { enforce: true, userId: 'user-b' })).toBe(false)
    expect(machineInScope(machine, { enforce: true, userId: null })).toBe(false)
  })

  test('open mode shares machines regardless of stored owner', () => {
    expect(machineInScope(machine, { enforce: false, userId: null })).toBe(true)
  })
})

describe('plaintext token visibility', () => {
  test('auth mode keeps tokens owner-only', () => {
    expect(tokenVisibleTo(machine, { enforce: true, userId: 'user-a' })).toBe(true)
    expect(tokenVisibleTo(machine, { enforce: true, userId: 'user-b' })).toBe(false)
    expect(tokenVisibleTo(machine, { enforce: true, userId: null })).toBe(false)
  })

  test('open mode preserves shared token visibility', () => {
    expect(tokenVisibleTo(machine, { enforce: false, userId: null })).toBe(true)
  })
})
