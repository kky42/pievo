// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { MachineSummary } from '../types'

const h = vi.hoisted(() => ({
  listMachines: vi.fn(),
  deleteMachine: vi.fn(async () => ({ ok: true })),
}))

const machine: MachineSummary = {
  id: 'machine-1',
  name: 'Workstation',
  online: false,
  lastSeen: '2025-01-01T00:00:00.000Z',
  hostname: 'workstation',
  platform: 'darwin',
  arch: 'arm64',
  daemonVersion: null,
  daemonProtocol: null,
  latestDaemonVersion: null,
  needsUpdate: false,
  requiredDaemonVersion: '2.0.0',
  token: null,
  loopCount: 2,
}

vi.mock('../server/loopApi', () => ({ getConfig: vi.fn(async () => ({ pievoCli: 'pievo', customCli: false })) }))
vi.mock('../server/machineFns', () => ({
  listMachines: h.listMachines,
  createMachine: vi.fn(),
  machineStatus: vi.fn(),
  finalizeMachine: vi.fn(),
  deleteMachine: h.deleteMachine,
}))

import { MachinesModal } from './MachinesModal'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.clearAllMocks()
  h.listMachines.mockReset().mockResolvedValue([machine])
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  document.body.querySelectorAll('[role="dialog"]').forEach((node) => node.remove())
})

async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

const bodyText = () => document.body.textContent ?? ''
const button = (label: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement

describe('MachinesModal list UX', () => {
  test('keeps machine order stable when polling returns rows in a different order', async () => {
    vi.useFakeTimers()
    const alpha = { ...machine, id: 'machine-a', name: 'Alpha' }
    const zulu = { ...machine, id: 'machine-z', name: 'Zulu' }
    h.listMachines
      .mockResolvedValueOnce([zulu, alpha])
      .mockResolvedValueOnce([alpha, zulu])

    try {
      await act(async () => root.render(createElement(MachinesModal, { open: true, onClose: () => {} })))
      await settle()

      const names = () => [...document.body.querySelectorAll('ul > li')].map((node) => node.textContent)
      expect(names()).toEqual([
        expect.stringContaining('Alpha'),
        expect.stringContaining('Zulu'),
      ])

      await act(async () => { vi.advanceTimersByTime(3000); await Promise.resolve() })
      expect(names()).toEqual([
        expect.stringContaining('Alpha'),
        expect.stringContaining('Zulu'),
      ])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('MachinesModal deletion UX', () => {
  test('permits machines with loops to be deleted only after a count-specific warning', async () => {
    await act(async () => root.render(createElement(MachinesModal, { open: true, onClose: () => {} })))
    await settle()

    expect(button('Delete').disabled).toBe(false)
    expect(bodyText()).toContain('2 loops')
    expect(bodyText()).toContain('It may be stopped or connected elsewhere. Its data remains on this server.')

    await act(async () => button('Delete').click())
    expect(h.deleteMachine).not.toHaveBeenCalled()
    expect(bodyText()).toContain('Delete Workstation and 2 loops?')
    expect(bodyText()).toContain('permanently deletes the machine, 2 loops, and their server history and artifact metadata')
    expect(bodyText()).toContain('Local project files are not deleted')
    expect(bodyText()).toContain('an unreachable local agent may continue running')

    await act(async () => { button('Delete machine').click(); await Promise.resolve() })
    expect(h.deleteMachine).toHaveBeenCalledWith({ data: 'machine-1' })
  })
})
