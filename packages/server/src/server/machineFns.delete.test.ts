import { beforeEach, describe, expect, test, vi } from 'vitest'

const h = vi.hoisted(() => ({
  machines: [
    { id: 'machine-a', name: 'A', token: 'token-a', online: false },
    { id: 'machine-b', name: 'B', token: 'token-b', online: false },
  ],
  removeLoop: vi.fn(),
  getMachine: vi.fn(),
  updateMachine: vi.fn(),
  createMachineRow: vi.fn(),
  rememberConnectKey: vi.fn(),
  forceDeleteMachine: vi.fn(),
}))

vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => ({
    validator() { return this },
    handler(fn: (args: { data: any }) => unknown) { return (args?: { data: any }) => fn(args ?? { data: undefined }) },
  }),
}))
vi.mock('../db/store.js', () => ({
  getMachine: h.getMachine,
  listMachines: vi.fn(async () => h.machines),
  loopsForMachine: vi.fn(async () => []),
  updateMachine: h.updateMachine,
  createMachine: h.createMachineRow,
  forceDeleteMachine: h.forceDeleteMachine,
}))
vi.mock('../gateway/tokens.js', () => ({
  machineIdFromToken: vi.fn(() => 'machine-new'),
  mintDeviceToken: vi.fn(() => 'dk_000000000000000000000000000000'),
  rememberConnectKey: h.rememberConnectKey,
  sha256: vi.fn(() => 'token-hash'),
}))
vi.mock('./boot.js', () => ({ ensureServer: vi.fn(async () => ({ scheduler: { removeLoop: h.removeLoop } })) }))
vi.mock('./daemonVersion.js', () => ({ latestDaemonVersion: { get: () => null } }))

import {
  createMachine,
  deleteMachine,
  finalizeMachine,
  listMachines,
  machineStatus,
} from './machineFns.js'

beforeEach(() => {
  vi.clearAllMocks()
  h.getMachine.mockImplementation(async (id: string) => h.machines.find((machine) => machine.id === id))
  h.updateMachine.mockImplementation(async (id: string) => h.machines.find((machine) => machine.id === id))
  h.createMachineRow.mockResolvedValue({})
  h.forceDeleteMachine.mockResolvedValue({ state: 'deleted', loopIds: ['loop-a', 'loop-b'] })
})

describe('machine administration', () => {
  test('lists every machine with its reconnect token', async () => {
    const result = await listMachines()
    expect(result.map((machine: { id: string; token: string | null }) => [machine.id, machine.token])).toEqual([
      ['machine-a', 'token-a'],
      ['machine-b', 'token-b'],
    ])
  })

  test('inspects, renames, and creates machines', async () => {
    await expect(machineStatus({ data: 'machine-b' })).resolves.toMatchObject({ id: 'machine-b', token: 'token-b' })
    await expect(machineStatus({ data: 'missing' })).resolves.toBeNull()
    await expect(finalizeMachine({ data: { id: 'machine-b', name: 'Renamed' } })).resolves.toEqual({ ok: true })
    await expect(createMachine()).resolves.toEqual({
      id: 'machine-new',
      token: 'dk_000000000000000000000000000000',
    })
    expect(h.rememberConnectKey).not.toHaveBeenCalled()
    expect(h.createMachineRow).toHaveBeenCalledWith(expect.objectContaining({
      id: 'machine-new',
      tokenHash: 'token-hash',
    }))
  })

  test('a failed machine create leaves no unknown-machine enrollment capability', async () => {
    h.createMachineRow.mockRejectedValueOnce(new Error('insert failed'))

    await expect(createMachine()).rejects.toThrow('insert failed')
    expect(h.rememberConnectKey).not.toHaveBeenCalled()
  })

  test('deletion unschedules deleted loops', async () => {
    await expect(deleteMachine({ data: 'machine-a' })).resolves.toEqual({ ok: true })
    expect(h.forceDeleteMachine).toHaveBeenCalledWith('machine-a')
    expect(h.removeLoop.mock.calls).toEqual([['loop-a'], ['loop-b']])
  })

  test('deleting a missing machine reports not found', async () => {
    h.forceDeleteMachine.mockResolvedValueOnce({ state: 'not-found' })
    await expect(deleteMachine({ data: 'missing' })).resolves.toEqual({ ok: false, error: 'machine not found' })
    expect(h.removeLoop).not.toHaveBeenCalled()
  })
})
