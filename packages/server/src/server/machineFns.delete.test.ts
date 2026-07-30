import { beforeEach, describe, expect, test, vi } from 'vitest'

const h = vi.hoisted(() => ({
  scope: { enforce: true, userId: 'user-a' as string | null },
  machines: [
    { id: 'machine-a', userId: 'user-a', name: 'A', token: 'token-a', online: false },
    { id: 'machine-b', userId: 'user-b', name: 'B', token: 'token-b', online: false },
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
vi.mock('../auth.js', () => ({ requestScope: vi.fn(async () => h.scope) }))
vi.mock('../db/store.js', () => ({
  getMachine: h.getMachine,
  listMachines: vi.fn(async () => h.machines),
  listMachinesForUser: vi.fn(async (userId: string) => h.machines.filter((machine) => machine.userId === userId)),
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
  h.scope = { enforce: true, userId: 'user-a' }
  vi.clearAllMocks()
  h.getMachine.mockImplementation(async (id: string) => h.machines.find((machine) => machine.id === id))
  h.updateMachine.mockImplementation(async (id: string) => h.machines.find((machine) => machine.id === id))
  h.createMachineRow.mockResolvedValue({})
  h.forceDeleteMachine.mockResolvedValue({ state: 'deleted', loopIds: ['loop-a', 'loop-b'] })
})

describe('auth-mode machine isolation', () => {
  test('lists only the owner machines and exposes only their tokens', async () => {
    const result = await listMachines()
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ id: 'machine-a', token: 'token-a' })
  })

  test('the owner can inspect, finalize, and create machines only for themselves', async () => {
    await expect(machineStatus({ data: 'machine-a' })).resolves.toMatchObject({ id: 'machine-a', token: 'token-a' })
    await expect(finalizeMachine({ data: { id: 'machine-a', name: 'Renamed' } })).resolves.toEqual({ ok: true })
    await expect(createMachine()).resolves.toEqual({
      id: 'machine-new',
      token: 'dk_000000000000000000000000000000',
    })
    expect(h.rememberConnectKey).not.toHaveBeenCalled()
    expect(h.createMachineRow).toHaveBeenCalledWith(expect.objectContaining({
      id: 'machine-new',
      userId: 'user-a',
      tokenHash: 'token-hash',
    }))
    expect(h.createMachineRow.mock.calls[0]?.[0]).not.toHaveProperty('teamId')
  })

  test('a failed machine create leaves no unknown-machine enrollment capability', async () => {
    h.createMachineRow.mockRejectedValueOnce(new Error('insert failed'))

    await expect(createMachine()).rejects.toThrow('insert failed')
    expect(h.rememberConnectKey).not.toHaveBeenCalled()
  })

  test('known cross-user and missing ids have the same detail and mutation results', async () => {
    await expect(machineStatus({ data: 'machine-b' })).resolves.toBeNull()
    await expect(machineStatus({ data: 'missing' })).resolves.toBeNull()

    const rename = { name: 'Renamed' }
    await expect(finalizeMachine({ data: { id: 'machine-b', ...rename } })).resolves.toEqual({ ok: false })
    await expect(finalizeMachine({ data: { id: 'missing', ...rename } })).resolves.toEqual({ ok: false })

    await expect(deleteMachine({ data: 'machine-b' })).resolves.toEqual({ ok: false, error: 'machine not found' })
    await expect(deleteMachine({ data: 'missing' })).resolves.toEqual({ ok: false, error: 'machine not found' })
    expect(h.updateMachine).not.toHaveBeenCalled()
    expect(h.forceDeleteMachine).not.toHaveBeenCalled()
  })

  test('owner deletion is atomically owner-fenced and unschedules deleted loops', async () => {
    await expect(deleteMachine({ data: 'machine-a' })).resolves.toEqual({ ok: true })
    expect(h.forceDeleteMachine).toHaveBeenCalledWith('machine-a', 'user-a')
    expect(h.removeLoop.mock.calls).toEqual([['loop-a'], ['loop-b']])
  })

  test('signed-out requests cannot list, inspect, create, finalize, or delete machines', async () => {
    h.scope = { enforce: true, userId: null }
    await expect(listMachines()).resolves.toEqual([])
    await expect(machineStatus({ data: 'machine-a' })).resolves.toBeNull()
    await expect(createMachine()).resolves.toEqual({ error: 'not signed in' })
    await expect(finalizeMachine({ data: { id: 'machine-a', name: 'Renamed' } })).resolves.toEqual({ ok: false })
    await expect(deleteMachine({ data: 'machine-a' })).resolves.toEqual({ ok: false, error: 'unauthorized' })
    expect(h.getMachine).not.toHaveBeenCalled()
    expect(h.updateMachine).not.toHaveBeenCalled()
    expect(h.forceDeleteMachine).not.toHaveBeenCalled()
    expect(h.rememberConnectKey).not.toHaveBeenCalled()
    expect(h.createMachineRow).not.toHaveBeenCalled()
  })
})

describe('open-mode machine administration', () => {
  test('lists tokens and manages machines regardless of stored owner', async () => {
    h.scope = { enforce: false, userId: null }
    const result = await listMachines()
    expect(result.map((machine: { id: string; token: string | null }) => [machine.id, machine.token])).toEqual([
      ['machine-a', 'token-a'],
      ['machine-b', 'token-b'],
    ])
    await expect(machineStatus({ data: 'machine-b' })).resolves.toMatchObject({ id: 'machine-b', token: 'token-b' })
    await expect(finalizeMachine({ data: { id: 'machine-b', name: 'Renamed' } })).resolves.toEqual({ ok: true })
    await expect(deleteMachine({ data: 'machine-b' })).resolves.toEqual({ ok: true })
    expect(h.forceDeleteMachine).toHaveBeenCalledWith('machine-b')

    await expect(createMachine()).resolves.toMatchObject({ id: 'machine-new' })
    expect(h.rememberConnectKey).not.toHaveBeenCalled()
    expect(h.createMachineRow).toHaveBeenCalledWith(expect.objectContaining({ userId: 'shared' }))
  })
})
