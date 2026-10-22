import { describe, expect, test } from 'vitest'
import { connectServerUrl, daemonConnectCommand, daemonUpgradeCommand } from './daemonCommands'

describe('public daemon command UX', () => {
  test('first connection installs globally then uses nested daemon connect', () => {
    expect(daemonConnectCommand('https://pievo.test', 'dk_one', 'pievo', false)).toBe(
      'npm install -g @kky42/pievo@latest && pievo daemon connect --server-url https://pievo.test --connect-key dk_one',
    )
  })

  test('a loopback dashboard hands out the published network URL', () => {
    expect(connectServerUrl('http://127.0.0.1:3000', 'https://box.tail1.ts.net')).toBe('https://box.tail1.ts.net')
    expect(connectServerUrl('http://localhost:3000', 'http://192.168.1.5:3000')).toBe('http://192.168.1.5:3000')
    expect(connectServerUrl('http://192.168.1.5:3000', 'https://box.tail1.ts.net')).toBe('http://192.168.1.5:3000')
    expect(connectServerUrl('http://127.0.0.1:3001', null)).toBe('http://127.0.0.1:3001')
  })

  test('upgrade is npm install followed by nested restart', () => {
    expect(daemonUpgradeCommand('pievo', false)).toBe(
      'npm install -g @kky42/pievo@latest && pievo daemon restart',
    )
  })

  test('custom dev CLI never adds a global install', () => {
    const cli = 'tsx /repo/packages/daemon/src/cli.ts'
    expect(daemonConnectCommand('http://127.0.0.1:3000', 'dk_dev', cli, true)).toBe(
      `${cli} daemon connect --server-url http://127.0.0.1:3000 --connect-key dk_dev`,
    )
    expect(daemonUpgradeCommand(cli, true)).toBe(`${cli} daemon restart`)
  })
})
