/**
 * Server functions backing the dashboard. They run server-side (createServerFn
 * → RPC) and call the IN-PROCESS scheduler + store directly — the scheduler
 * lives in this same TanStack process (booted on first call via ensureServer).
 * The machine-facing poll, CLI, report, and artifact-sync endpoints are sibling
 * server routes in this same process, so one process owns the single scheduler.
 *
 * Reads and writes are scoped through requestScope/ownedLoop so auth-mode users
 * can access only their own loops. Open mode intentionally shares all loops.
 */
import { createServerFn } from '@tanstack/react-start'

import type {
  ArtifactContent,
  ArtifactSummary,
  LoopDetail,
  LoopPayload,
  LoopSummary,
  MutationResult,
  RunDiffResult,
  RunSummary,
} from '../types'
import * as store from '../db/store.js'
import { canAccessLoop, requestScope } from '../auth.js'
import { ensureServer } from './boot.js'
import { sortLoopSummariesByRecentRun, toLoopDetail, toLoopSummaries, toRunSummaries } from './loopProjection.js'
import { validateLoopEdit } from '../gateway/loopConfig.js'
import { machinePresence } from '../lib/machinePresence.js'
import { DAEMON_PROTOCOL_VERSION } from '../gateway/protocol.js'

function backend() {
  return ensureServer()
}

/**
 * Resolve a loop and authorize the request against its owner. Returns the loop,
 * or undefined when it's missing OR (gate on) owned by a different user — callers
 * treat both as "not found" so existence never leaks across users.
 */
async function ownedLoop(id: string) {
  const loop = await store.getLoop(id)
  if (!loop) return undefined
  const scope = await requestScope()
  if (!canAccessLoop(loop.userId, scope)) return undefined
  return { loop }
}

export const getAuthState = createServerFn({ method: 'GET' }).handler(async () => {
  const { authEnabled } = await import('../auth.js')
  return { enabled: authEnabled }
})

/**
 * Client config. `pievoCli` is the CLI invocation prefix the skill + connect
 * dialog use for every verb (`daemon start`, `new`, …) — defaults to the globally
 * installed `pievo`. Set PIEVO_CLI locally to a runnable command that points at the in-repo
 * daemon, e.g. `tsx /abs/packages/daemon/src/cli.ts` or
 * `node /abs/packages/daemon/dist/cli.js`, so loops created from THIS server tell
 * Claude Code to run your local code instead of the registry build.
 */
export const getConfig = createServerFn({ method: 'GET' }).handler(() => {
  const custom = process.env.PIEVO_CLI?.trim()
  return {
    pievoCli: custom || 'pievo',
    /** True when a non-default (dev) CLI is configured — the New-loop paste then
     *  carries an explicit `pievo-cli:` line so Claude Code uses it verbatim. */
    customCli: !!custom,
  }
})

/** GET — visible loops as compact summaries, most recently run first. */
export const listLoops = createServerFn({ method: 'GET' })
  .handler(async () => {
    await backend()
    const scope = await requestScope()
    if (scope.enforce && !scope.userId) return [] as LoopSummary[]
    const [loopRows, machines] = await Promise.all([
      scope.enforce ? store.listLoopsForUser(scope.userId!) : store.listLoops(),
      scope.enforce ? store.listMachinesForUser(scope.userId!) : store.listMachines(),
    ])
    const loops = loopRows.sort((a, b) => a.createdAt < b.createdAt ? 1 : -1)
    return sortLoopSummariesByRecentRun(await toLoopSummaries(loops, machines))
  })

export const getLoopDetail = createServerFn({ method: 'GET' })
  .validator((id: string) => id)
  .handler(async ({ data: id }): Promise<LoopDetail> => {
    await backend()
    const owned = await ownedLoop(id)
    // A missing loop and another user's loop return the same message.
    if (!owned) throw new Error('This loop does not exist, or you do not have access to it.')
    return toLoopDetail(owned.loop)
  })

export const loadOlderRuns = createServerFn({ method: 'GET' })
  .validator((d: { loopId: string; beforeTs: string; limit?: number }) => d)
  .handler(async ({ data }): Promise<RunSummary[]> => {
    await backend()
    if (!(await ownedLoop(data.loopId))) return []
    const limit = Math.min(Math.max(data.limit ?? 16, 1), 100)
    return toRunSummaries(data.loopId, await store.listRunsBefore(data.loopId, data.beforeTs, limit))
  })

export const getArtifacts = createServerFn({ method: 'GET' })
  .validator((d: { loopId: string }) => d)
  .handler(async ({ data }): Promise<ArtifactSummary[]> => {
    await backend()
    if (!(await ownedLoop(data.loopId))) return []
    const { listLoopArtifacts } = await import('./artifactFiles.js')
    return listLoopArtifacts(data.loopId)
  })

export const getArtifact = createServerFn({ method: 'GET' })
  .validator((d: { loopId: string; path: string }) => d)
  .handler(async ({ data }): Promise<ArtifactContent> => {
    await backend()
    if (!(await ownedLoop(data.loopId))) return { error: 'file not found' }
    const { readLoopArtifact } = await import('./artifactFiles.js')
    return readLoopArtifact(data.loopId, data.path)
  })

/** GET — a run's per-file diff vs the previous run. Lazy by runId like
 *  computed on the server at read time (no stored diffs). Old runs
 *  with no snapshot return `hasSnapshot: false` for the degrade copy. */
export const getRunDiff = createServerFn({ method: 'GET' })
  .validator((d: { runId: string }) => d)
  .handler(async ({ data }): Promise<RunDiffResult> => {
    await backend()
    const run = await store.getRun(data.runId)
    if (!run) return { hasSnapshot: false, files: [] }
    if (!(await ownedLoop(run.loopId))) return { hasSnapshot: false, files: [] }
    const { computeRunDiff } = await import('./runDiff.js')
    return computeRunDiff(data.runId)
  })

export const patchLoop = createServerFn({ method: 'POST' })
  .validator((d: { id: string; patch: LoopPayload }) => d)
  .handler(async ({ data }): Promise<MutationResult> => {
    const { scheduler } = await backend()
    const owned = await ownedLoop(data.id)
    if (!owned) return { error: 'not found' }
    const p = data.patch
    {
      const validated = validateLoopEdit(owned.loop, p)
      if (!validated.ok) return { error: validated.detail }
      const loop = await store.updateLoop(data.id, validated.value)
      if (!loop) return { error: 'not found' }
      if (loop.enabled) scheduler.addLoop(loop)
      else scheduler.removeLoop(loop.id)
      return { ok: true }
    }
  })

/** Dedicated lifecycle operations. Dashboard callers never synthesize these
 * transitions with patchLoop: each delegates to the loop-locked store operation. */
export const pauseLoop = createServerFn({ method: 'POST' })
  .validator((id: string) => id)
  .handler(async ({ data: id }): Promise<MutationResult> => {
    const { scheduler } = await backend()
    if (!(await ownedLoop(id))) return { error: 'not found' }
    const loop = await store.pauseLoop(id)
    if (!loop) return { error: 'not found' }
    scheduler.removeLoop(id)
    return { ok: true }
  })

export const startLoop = createServerFn({ method: 'POST' })
  .validator((id: string) => id)
  .handler(async ({ data: id }): Promise<MutationResult> => {
    const { scheduler } = await backend()
    const owned = await ownedLoop(id)
    if (!owned) return { error: 'not found' }
    if (owned.loop.deleteRequestedAt) return { error: 'loop is being deleted' }
    const loop = await store.startLoop(id)
    if (!loop) return { error: 'not found' }
    scheduler.addLoop(loop)
    return { ok: true }
  })

export const stopLoop = createServerFn({ method: 'POST' })
  .validator((id: string) => id)
  .handler(async ({ data: id }): Promise<MutationResult> => {
    const { scheduler } = await backend()
    const owned = await ownedLoop(id)
    if (!owned) return { error: 'not found' }
    if (await store.hasRunningRun(id)) {
      const machine = await store.getMachine(owned.loop.machineId)
      if (machine?.daemonProtocol !== DAEMON_PROTOCOL_VERSION) return { error: 'Daemon upgrade required to stop a running process' }
    }
    const stopped = await store.stopLoop(id)
    if (!stopped) return { error: 'not found' }
    scheduler.removeLoop(id)
    return { ok: true, waiting: !!stopped.running }
  })

/** Delete is one confirmed operation. Reachable machines get the graceful
 * Stop-and-wait path; a machine already offline at click time cannot acknowledge
 * Stop, so retire its execution authority and remove server data immediately.
 * Local files are never touched by either path. */
export const deleteLoop = createServerFn({ method: 'POST' })
  .validator((id: string) => id)
  .handler(async ({ data: id }): Promise<MutationResult> => {
    const { scheduler } = await backend()
    const owned = await ownedLoop(id)
    if (!owned) return { error: 'not found' }
    const machine = await store.getMachine(owned.loop.machineId)
    const unreachable = machinePresence(machine?.online, machine?.lastSeen) !== 'online'
    if (!unreachable && await store.hasRunningRun(id) && machine?.daemonProtocol !== DAEMON_PROTOCOL_VERSION) {
      return { error: 'Daemon upgrade required to stop a running process' }
    }
    scheduler.removeLoop(id)
    const requested = await store.requestDeleteLoop(id)
    if (!requested) return { error: 'not found' }
    if (unreachable) {
      const deleted = await store.forceDeleteLoop(id)
      if (!deleted) return { error: 'delete failed; server data was not deleted' }
      const { logger } = await import('../logger.js')
      logger.child({ mod: 'loop-lifecycle' }).warn(
        { action: 'unreachable-delete', loopId: id, machineId: owned.loop.machineId },
        'unreachable-machine delete: retired execution authority and removed server data',
      )
      return { ok: true, deleted: true }
    }
    const deleted = await store.tryDeleteLoop(id)
    return { ok: true, deleted, waiting: !deleted }
  })

export const runLoop = createServerFn({ method: 'POST' })
  .validator((id: string) => id)
  .handler(async ({ data: id }): Promise<MutationResult> => {
    const { scheduler } = await backend()
    if (!(await ownedLoop(id))) return { error: 'not found' }
    const queued = await scheduler.runNow(id)
    if (!('run' in queued)) return { error: queued.reason }
    return { ok: true, runId: queued.run.id, queued: true, coalesced: queued.state === 'coalesced' }
  })

/** Dedicated Stop-run operation. Pending work cancels immediately; running work
 * records intent and stays Running until the daemon reports its actual result. */
export const stopRun = createServerFn({ method: 'POST' })
  .validator((id: string) => id)
  .handler(async ({ data: id }): Promise<MutationResult> => {
    await backend()
    const run = await store.getRun(id)
    const owned = run ? await ownedLoop(run.loopId) : undefined
    if (!run || !owned) return { error: 'run not found' }
    if (run.phase === 'running' && (await store.getMachine(owned.loop.machineId))?.daemonProtocol !== DAEMON_PROTOCOL_VERSION) {
      return { error: 'Daemon upgrade required to stop a running process' }
    }
    const result = await store.requestRunCancel(run.loopId, id)
    return result ? { ok: true, waiting: result.phase === 'running' } : { error: 'run not found' }
  })

/** Mint the key shown in the New-loop daemon connection command. */
export const mintConnectKey = createServerFn({ method: 'POST' })
  .handler(async (): Promise<{ token: string } | { error: string }> => {
    await backend()
    const scope = await requestScope()
    if (scope.enforce && !scope.userId) return { error: 'not signed in' }
    const { mintDeviceToken, rememberConnectKey } = await import('../gateway/tokens.js')
    const token = mintDeviceToken()
    await rememberConnectKey(token, { userId: scope.userId ?? 'shared' })
    return { token }
  })
