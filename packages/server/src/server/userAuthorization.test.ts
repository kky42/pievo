import { beforeEach, describe, expect, test, vi } from 'vitest'

const h = vi.hoisted(() => ({
  scope: { enforce: true, userId: 'user-a' as string | null },
  loops: [
    { id: 'loop-a', userId: 'user-a', machineId: 'machine-a', name: 'A', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'loop-b', userId: 'user-b', machineId: 'machine-b', name: 'B', createdAt: '2026-01-02T00:00:00.000Z' },
  ],
  updateLoop: vi.fn(),
  pauseLoopRow: vi.fn(),
  startLoopRow: vi.fn(),
  stopLoopRow: vi.fn(),
  requestRunCancel: vi.fn(),
  listRunsBefore: vi.fn(),
  requestDeleteLoop: vi.fn(),
  forceDeleteLoop: vi.fn(),
  runNow: vi.fn(),
  listArtifacts: vi.fn(),
  readArtifact: vi.fn(),
  computeRunDiff: vi.fn(),
  mintDeviceToken: vi.fn(),
  rememberConnectKey: vi.fn(),
  removeLoop: vi.fn(),
}))

vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => ({
    validator() { return this },
    handler(fn: (args: { data: any }) => unknown) { return (args?: { data: any }) => fn(args ?? { data: undefined }) },
  }),
}))
vi.mock('../auth.js', () => ({
  requestScope: vi.fn(async () => h.scope),
  canAccessLoop: (loopUserId: string | null | undefined, scope: typeof h.scope) =>
    !scope.enforce || (!!scope.userId && loopUserId === scope.userId),
}))
vi.mock('../db/store.js', () => ({
  getLoop: vi.fn(async (id: string) => h.loops.find((loop) => loop.id === id)),
  listLoops: vi.fn(async () => [...h.loops]),
  listLoopsForUser: vi.fn(async (userId: string) => h.loops.filter((loop) => loop.userId === userId)),
  listMachines: vi.fn(async () => []),
  listMachinesForUser: vi.fn(async () => []),
  updateLoop: h.updateLoop,
  pauseLoop: h.pauseLoopRow,
  startLoop: h.startLoopRow,
  stopLoop: h.stopLoopRow,
  requestDeleteLoop: h.requestDeleteLoop,
  forceDeleteLoop: h.forceDeleteLoop,
  tryDeleteLoop: vi.fn(async () => true),
  hasRunningRun: vi.fn(async () => false),
  getMachine: vi.fn(async () => undefined),
  getRun: vi.fn(async (id: string) => {
    if (id === 'run-a') return { id, loopId: 'loop-a', phase: 'pending' }
    if (id === 'run-b') return { id, loopId: 'loop-b', phase: 'pending' }
    return undefined
  }),
  requestRunCancel: h.requestRunCancel,
  listRunsBefore: h.listRunsBefore,
}))
vi.mock('./boot.js', () => ({
  ensureServer: vi.fn(async () => ({
    scheduler: {
      addLoop: vi.fn(),
      removeLoop: h.removeLoop,
      runNow: h.runNow,
    },
  })),
}))
vi.mock('./loopProjection.js', () => ({
  sortLoopSummariesByRecentRun: (loops: unknown[]) => loops,
  toLoopSummaries: vi.fn(async (loops: Array<{ id: string; name: string }>) => loops.map(({ id, name }) => ({ id, name }))),
  toLoopDetail: vi.fn(async (loop: { id: string; name: string }) => ({ id: loop.id, name: loop.name })),
  toRunSummaries: vi.fn(async () => []),
}))
vi.mock('../gateway/loopConfig.js', () => ({ validateLoopEdit: (_loop: unknown, patch: unknown) => ({ ok: true, value: patch }) }))
vi.mock('./artifactFiles.js', () => ({
  listLoopArtifacts: h.listArtifacts,
  readLoopArtifact: h.readArtifact,
}))
vi.mock('./runDiff.js', () => ({ computeRunDiff: h.computeRunDiff }))
vi.mock('../gateway/tokens.js', () => ({
  mintDeviceToken: h.mintDeviceToken,
  rememberConnectKey: h.rememberConnectKey,
}))
vi.mock('../logger.js', () => ({ logger: { child: () => ({ warn: vi.fn() }) } }))

import {
  deleteLoop,
  getArtifact,
  getArtifacts,
  getLoopDetail,
  getRunDiff,
  listLoops,
  loadOlderRuns,
  mintConnectKey,
  patchLoop,
  pauseLoop,
  runLoop,
  startLoop,
  stopLoop,
  stopRun,
} from './loopApi.js'

beforeEach(() => {
  h.scope = { enforce: true, userId: 'user-a' }
  vi.clearAllMocks()
  h.updateLoop.mockImplementation(async (id: string) => h.loops.find((loop) => loop.id === id))
  h.pauseLoopRow.mockImplementation(async (id: string) => h.loops.find((loop) => loop.id === id))
  h.startLoopRow.mockImplementation(async (id: string) => h.loops.find((loop) => loop.id === id))
  h.stopLoopRow.mockImplementation(async (id: string) => h.loops.some((loop) => loop.id === id) ? { running: null } : undefined)
  h.requestRunCancel.mockImplementation(async (_loopId: string, id: string) => id === 'run-a' || id === 'run-b' ? { phase: 'pending' } : undefined)
  h.listRunsBefore.mockResolvedValue([])
  h.requestDeleteLoop.mockImplementation(async (id: string) => h.loops.find((loop) => loop.id === id))
  h.forceDeleteLoop.mockResolvedValue(true)
  h.runNow.mockResolvedValue({ state: 'created', run: { id: 'run-new' } })
  h.listArtifacts.mockResolvedValue([{ path: 'report.md' }])
  h.readArtifact.mockResolvedValue({ path: 'report.md', content: 'ok' })
  h.computeRunDiff.mockResolvedValue({ hasSnapshot: true, files: [] })
  h.mintDeviceToken.mockReturnValue('dk_000000000000000000000000000000')
})

describe('auth-mode loop isolation', () => {
  test('user A cannot list user B loops', async () => {
    await expect(listLoops()).resolves.toEqual([{ id: 'loop-a', name: 'A' }])
  })

  test('the matching owner can access loop detail and artifacts', async () => {
    await expect(getLoopDetail({ data: 'loop-a' })).resolves.toEqual({ id: 'loop-a', name: 'A' })
    await expect(getArtifacts({ data: { loopId: 'loop-a' } })).resolves.toEqual([{ path: 'report.md' }])
  })

  test('known cross-user and missing ids have the same detail result', async () => {
    const message = 'This loop does not exist, or you do not have access to it.'
    await expect(getLoopDetail({ data: 'loop-b' })).rejects.toThrow(message)
    await expect(getLoopDetail({ data: 'missing' })).rejects.toThrow(message)
  })

  test('the loop owner may retire authority when its machine is unreachable', async () => {
    await expect(deleteLoop({ data: 'loop-a' })).resolves.toEqual({ ok: true, deleted: true })
    expect(h.requestDeleteLoop).toHaveBeenCalledWith('loop-a')
    expect(h.forceDeleteLoop).toHaveBeenCalledWith('loop-a')
    expect(h.removeLoop).toHaveBeenCalledWith('loop-a')
  })

  test('known cross-user and missing ids have the same mutate, delete, and run results', async () => {
    const patch = { name: 'Changed' } as any
    await expect(patchLoop({ data: { id: 'loop-b', patch } })).resolves.toEqual({ error: 'not found' })
    await expect(patchLoop({ data: { id: 'missing', patch } })).resolves.toEqual({ error: 'not found' })
    await expect(deleteLoop({ data: 'loop-b' })).resolves.toEqual({ error: 'not found' })
    await expect(deleteLoop({ data: 'missing' })).resolves.toEqual({ error: 'not found' })
    await expect(runLoop({ data: 'loop-b' })).resolves.toEqual({ error: 'not found' })
    await expect(runLoop({ data: 'missing' })).resolves.toEqual({ error: 'not found' })
    expect(h.updateLoop).not.toHaveBeenCalled()
    expect(h.requestDeleteLoop).not.toHaveBeenCalled()
    expect(h.runNow).not.toHaveBeenCalled()
  })

  test('known cross-user and missing ids have the same pagination and lifecycle results', async () => {
    const older = (loopId: string) => loadOlderRuns({ data: { loopId, beforeTs: '2026-01-01T00:00:00.000Z' } })
    await expect(older('loop-b')).resolves.toEqual([])
    await expect(older('missing')).resolves.toEqual([])

    for (const action of [pauseLoop, startLoop, stopLoop]) {
      await expect(action({ data: 'loop-b' })).resolves.toEqual({ error: 'not found' })
      await expect(action({ data: 'missing' })).resolves.toEqual({ error: 'not found' })
    }
    await expect(stopRun({ data: 'run-b' })).resolves.toEqual({ error: 'run not found' })
    await expect(stopRun({ data: 'missing' })).resolves.toEqual({ error: 'run not found' })
    expect(h.listRunsBefore).not.toHaveBeenCalled()
    expect(h.pauseLoopRow).not.toHaveBeenCalled()
    expect(h.startLoopRow).not.toHaveBeenCalled()
    expect(h.stopLoopRow).not.toHaveBeenCalled()
    expect(h.requestRunCancel).not.toHaveBeenCalled()
  })

  test('artifacts and snapshots authorize through the parent loop', async () => {
    await expect(getArtifacts({ data: { loopId: 'loop-b' } })).resolves.toEqual([])
    await expect(getArtifacts({ data: { loopId: 'missing' } })).resolves.toEqual([])
    await expect(getArtifact({ data: { loopId: 'loop-b', path: 'report.md' } })).resolves.toEqual({ error: 'file not found' })
    await expect(getArtifact({ data: { loopId: 'missing', path: 'report.md' } })).resolves.toEqual({ error: 'file not found' })
    await expect(getRunDiff({ data: { runId: 'run-b' } })).resolves.toEqual({ hasSnapshot: false, files: [] })
    await expect(getRunDiff({ data: { runId: 'missing' } })).resolves.toEqual({ hasSnapshot: false, files: [] })
    expect(h.listArtifacts).not.toHaveBeenCalled()
    expect(h.readArtifact).not.toHaveBeenCalled()
    expect(h.computeRunDiff).not.toHaveBeenCalled()
  })

  test('connect keys bind only the signed-in user', async () => {
    await expect(mintConnectKey()).resolves.toEqual({ token: 'dk_000000000000000000000000000000' })
    expect(h.rememberConnectKey).toHaveBeenCalledWith('dk_000000000000000000000000000000', { userId: 'user-a' })
  })

  test('signed-out requests cannot read or mutate any loop-owned resource', async () => {
    h.scope = { enforce: true, userId: null }
    await expect(listLoops()).resolves.toEqual([])
    await expect(getLoopDetail({ data: 'loop-a' })).rejects.toThrow('This loop does not exist, or you do not have access to it.')
    await expect(loadOlderRuns({ data: { loopId: 'loop-a', beforeTs: '2026-01-01T00:00:00.000Z' } })).resolves.toEqual([])
    await expect(getArtifacts({ data: { loopId: 'loop-a' } })).resolves.toEqual([])
    await expect(getArtifact({ data: { loopId: 'loop-a', path: 'report.md' } })).resolves.toEqual({ error: 'file not found' })
    await expect(getRunDiff({ data: { runId: 'run-a' } })).resolves.toEqual({ hasSnapshot: false, files: [] })
    await expect(patchLoop({ data: { id: 'loop-a', patch: { name: 'Changed' } as any } })).resolves.toEqual({ error: 'not found' })
    for (const action of [pauseLoop, startLoop, stopLoop, deleteLoop, runLoop]) {
      await expect(action({ data: 'loop-a' })).resolves.toEqual({ error: 'not found' })
    }
    await expect(stopRun({ data: 'run-a' })).resolves.toEqual({ error: 'run not found' })
    await expect(mintConnectKey()).resolves.toEqual({ error: 'not signed in' })
    expect(h.listRunsBefore).not.toHaveBeenCalled()
    expect(h.listArtifacts).not.toHaveBeenCalled()
    expect(h.readArtifact).not.toHaveBeenCalled()
    expect(h.computeRunDiff).not.toHaveBeenCalled()
    expect(h.updateLoop).not.toHaveBeenCalled()
    expect(h.pauseLoopRow).not.toHaveBeenCalled()
    expect(h.startLoopRow).not.toHaveBeenCalled()
    expect(h.stopLoopRow).not.toHaveBeenCalled()
    expect(h.requestDeleteLoop).not.toHaveBeenCalled()
    expect(h.runNow).not.toHaveBeenCalled()
    expect(h.requestRunCancel).not.toHaveBeenCalled()
    expect(h.mintDeviceToken).not.toHaveBeenCalled()
    expect(h.rememberConnectKey).not.toHaveBeenCalled()
  })
})

describe('open-mode shared loop administration', () => {
  test('lists and manages resources regardless of stored user id', async () => {
    h.scope = { enforce: false, userId: null }
    await expect(listLoops()).resolves.toEqual([
      { id: 'loop-b', name: 'B' },
      { id: 'loop-a', name: 'A' },
    ])
    await expect(getLoopDetail({ data: 'loop-b' })).resolves.toEqual({ id: 'loop-b', name: 'B' })
    await expect(loadOlderRuns({ data: { loopId: 'loop-b', beforeTs: '2026-01-01T00:00:00.000Z' } })).resolves.toEqual([])
    expect(h.listRunsBefore).toHaveBeenCalledWith('loop-b', '2026-01-01T00:00:00.000Z', 16)
    await expect(getArtifacts({ data: { loopId: 'loop-b' } })).resolves.toEqual([{ path: 'report.md' }])
    await expect(getArtifact({ data: { loopId: 'loop-b', path: 'report.md' } })).resolves.toEqual({ path: 'report.md', content: 'ok' })
    await expect(getRunDiff({ data: { runId: 'run-b' } })).resolves.toEqual({ hasSnapshot: true, files: [] })
    await expect(patchLoop({ data: { id: 'loop-b', patch: { name: 'Changed' } as any } })).resolves.toEqual({ ok: true })
    await expect(pauseLoop({ data: 'loop-b' })).resolves.toEqual({ ok: true })
    await expect(startLoop({ data: 'loop-b' })).resolves.toEqual({ ok: true })
    await expect(stopLoop({ data: 'loop-b' })).resolves.toEqual({ ok: true, waiting: false })
    await expect(deleteLoop({ data: 'loop-b' })).resolves.toMatchObject({ ok: true })
    await expect(runLoop({ data: 'loop-b' })).resolves.toMatchObject({ ok: true, runId: 'run-new' })
    await expect(stopRun({ data: 'run-b' })).resolves.toEqual({ ok: true, waiting: false })
  })

  test('mints open-mode connect keys for the shared owner sentinel', async () => {
    h.scope = { enforce: false, userId: null }
    await expect(mintConnectKey()).resolves.toEqual({ token: 'dk_000000000000000000000000000000' })
    expect(h.rememberConnectKey).toHaveBeenCalledWith('dk_000000000000000000000000000000', { userId: 'shared' })
  })
})
