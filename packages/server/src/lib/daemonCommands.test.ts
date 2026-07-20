import { describe, expect, test } from 'vitest'
import { daemonConnectCommand, daemonUpgradeCommand } from './daemonCommands'

describe('public daemon command UX', () => {
  test('first connection installs globally then uses nested daemon start', () => {
    expect(daemonConnectCommand('https://pievo.test', 'dk_one', 'pievo', false)).toBe(
      'npm install -g @kky42/pievo@latest && pievo daemon start --server-url https://pievo.test --connect-key dk_one',
    )
  })

  test('upgrade is npm install followed by nested restart', () => {
    expect(daemonUpgradeCommand('pievo', false)).toBe(
      'npm install -g @kky42/pievo@latest && pievo daemon restart',
    )
  })

  test('custom dev CLI never adds a global install', () => {
    const cli = 'tsx /repo/packages/daemon/src/cli.ts'
    expect(daemonConnectCommand('http://127.0.0.1:3000', 'dk_dev', cli, true)).toBe(
      `${cli} daemon start --server-url http://127.0.0.1:3000 --connect-key dk_dev`,
    )
    expect(daemonUpgradeCommand(cli, true)).toBe(`${cli} daemon restart`)
  })
})
