// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComposeModal } from './ComposeModal'
import { MachinesModal } from './MachinesModal'

type CliConfig = { pievoCli: string; customCli: boolean }
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const h = vi.hoisted(() => ({
  config: null as Deferred<CliConfig> | null,
}))

vi.mock('../server/loopApi', () => ({
  getConfig: vi.fn(() => h.config!.promise),
  mintClaim: vi.fn(async () => ({ token: 'dk_claim' })),
  claimStatus: vi.fn(async () => ({ done: false })),
}))
vi.mock('../server/machineFns', () => ({
  listMachines: vi.fn(async () => []),
  createMachine: vi.fn(async () => ({ id: 'machine-1', token: 'dk_machine' })),
  machineStatus: vi.fn(async () => null),
  finalizeMachine: vi.fn(async () => ({ ok: true })),
  deleteMachine: vi.fn(async () => ({ ok: true })),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  h.config = deferred<CliConfig>()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  document.body.querySelectorAll('[role="dialog"]').forEach((node) => node.remove())
})

const bodyText = () => document.body.textContent ?? ''

async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

describe('custom PIEVO_CLI config ordering', () => {
  it('ComposeModal never exposes a default prompt when the claim resolves before config', async () => {
    await act(async () => root.render(createElement(ComposeModal, {
      open: true,
      onClose: () => {},
      onCreated: () => {},
    })))
    await settle()

    expect(bodyText()).toContain('Loading CLI configuration…')
    expect(bodyText()).not.toContain('pievo-cli:')
    expect(bodyText()).not.toContain('npm install -g')
    const copy = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes('Copy prompt')) as HTMLButtonElement
    expect(copy.disabled).toBe(true)

    await act(async () => h.config!.resolve({ pievoCli: 'tsx /repo/packages/daemon/src/cli.ts', customCli: true }))
    expect(bodyText()).toContain('pievo-cli: tsx /repo/packages/daemon/src/cli.ts')
    expect(bodyText()).not.toContain('npm install -g')
    expect(copy.disabled).toBe(false)
  })

  it('MachinesModal waits for config after a machine claim and then preserves the custom command verbatim', async () => {
    await act(async () => root.render(createElement(MachinesModal, { open: true, onClose: () => {} })))
    await settle()
    const connect = [...document.body.querySelectorAll('button')].find((b) => b.textContent === '+ Connect computer') as HTMLButtonElement
    await act(async () => { connect.click(); await Promise.resolve() })

    expect(bodyText()).toContain('Loading connection command…')
    expect(bodyText()).not.toContain('npm install -g')
    expect(bodyText()).not.toContain('pievo daemon start')

    const custom = 'node /repo/packages/daemon/dist/cli.js'
    await act(async () => h.config!.resolve({ pievoCli: custom, customCli: true }))
    expect(bodyText()).toContain(`${custom} daemon start`)
    expect(bodyText()).not.toContain('npm install -g')
  })

  it('surfaces config failure without falling back to a copyable public command', async () => {
    await act(async () => root.render(createElement(ComposeModal, {
      open: true,
      onClose: () => {},
      onCreated: () => {},
    })))
    await settle()
    await act(async () => h.config!.reject(new Error('config unavailable')))

    expect(bodyText()).toContain('Could not load the CLI configuration')
    expect(bodyText()).not.toContain('npm install -g')
    expect(bodyText()).not.toContain('pievo-cli:')
    const copy = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes('Copy prompt')) as HTMLButtonElement
    expect(copy.disabled).toBe(true)
  })
})
