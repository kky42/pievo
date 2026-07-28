import { beforeEach, describe, expect, test, vi } from 'vitest'

const h = vi.hoisted(() => ({
  scope: { enforce: true, userId: 'u-actor', teamId: 'team-a' },
  machine: { id: 'machine-1', userId: 'u-machine', name: 'Workstation' },
  loops: [] as Array<{ id: string; teamId: string }>,
  removeLoop: vi.fn(),
  forceDeleteMachine: vi.fn(async () => ({ state: 'deleted' as const, loopIds: ['loop-a', 'loop-b'] })),
  getTeamMember: vi.fn(async (_teamId: string, _userId: string) => ({ role: 'owner' })),
}))

vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => ({
    validator() { return this },
    handler(fn: (args: { data: unknown }) => unknown) { return (args: { data: unknown }) => fn(args) },
  }),
}))
vi.mock('../auth.js', () => ({ requestScope: vi.fn(async () => h.scope) }))
vi.mock('../db/store.js', () => ({
  getMachine: vi.fn(async () => h.machine),
  listMachinesForTeam: vi.fn(async () => [h.machine]),
  loopsForMachine: vi.fn(async () => h.loops),
  getTeamMember: h.getTeamMember,
  forceDeleteMachine: h.forceDeleteMachine,
}))
vi.mock('../gateway/tokens.js', () => ({
  machineIdFromToken: vi.fn(),
  mintDeviceToken: vi.fn(),
  rememberConnectKey: vi.fn(),
  sha256: vi.fn(),
}))
vi.mock('./boot.js', () => ({ ensureServer: vi.fn(async () => ({ scheduler: { removeLoop: h.removeLoop } })) }))
vi.mock('./daemonVersion.js', () => ({ latestDaemonVersion: { get: () => null } }))

import { deleteMachine } from './machineFns.js'

beforeEach(() => {
  h.scope = { enforce: true, userId: 'u-actor', teamId: 'team-a' }
  h.loops = []
  vi.clearAllMocks()
  h.forceDeleteMachine.mockResolvedValue({ state: 'deleted', loopIds: ['loop-a', 'loop-b'] })
  h.getTeamMember.mockResolvedValue({ role: 'owner' })
})

describe('dashboard machine deletion', () => {
  test('atomically deletes every loop and machine, then removes scheduler entries', async () => {
    h.loops = [{ id: 'loop-a', teamId: 'team-a' }, { id: 'loop-b', teamId: 'team-b' }]

    await expect(deleteMachine({ data: 'machine-1' })).resolves.toEqual({ ok: true })

    expect(h.getTeamMember).toHaveBeenCalledTimes(2)
    expect(h.forceDeleteMachine).toHaveBeenCalledWith('machine-1', ['team-a', 'team-b'])
    expect(h.removeLoop.mock.calls).toEqual([['loop-a'], ['loop-b']])
  })

  test('does not cascade when the caller is not an owner of every affected team', async () => {
    h.loops = [{ id: 'loop-a', teamId: 'team-a' }, { id: 'loop-b', teamId: 'team-b' }]
    h.getTeamMember.mockImplementation(async (teamId: string, _userId: string) => ({ role: teamId === 'team-a' ? 'owner' : 'member' }))

    const result = await deleteMachine({ data: 'machine-1' })

    expect(result).toEqual({ ok: false, error: 'Only an owner of every affected team can delete this machine and its loops.' })
    expect(h.forceDeleteMachine).not.toHaveBeenCalled()
  })

  test('preserves existing scoped authority for deleting an empty machine', async () => {
    await expect(deleteMachine({ data: 'machine-1' })).resolves.toEqual({ ok: true })
    expect(h.getTeamMember).not.toHaveBeenCalled()
    expect(h.forceDeleteMachine).toHaveBeenCalledWith('machine-1', [])
  })
})
