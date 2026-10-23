/**
 * Server functions backing the dashboard. They run server-side (createServerFn
 * → RPC) and call the IN-PROCESS scheduler + store directly — the scheduler
 * lives in this same TanStack process (booted on first call via ensureServer).
 * The machine-facing poll, CLI, and report endpoints are sibling server
 * routes in this same process, so one process owns the single scheduler.
 */
import { createServerFn } from '@tanstack/react-start'

import type {
  LoopDetail,
  LoopPayload,
  LoopSummary,
  MutationResult,
  RunSummary,
} from '../types'
import * as store from '../db/store.js'
import { ensureServer } from './boot.js'
import { sortLoopSummariesByRecentRun, toLoopDetail, toLoopSummaries, toRunSummaries } from './loopProjection.js'
import { validateLoopEdit } from '../gateway/loopConfig.js'
import { machinePresence } from '../lib/machinePresence.js'
import { DAEMON_PROTOCOL_VERSION } from '../gateway/protocol.js'

function backend() {
  return ensureServer()
}

async function findLoop(id: string) {
  const loop = await store.getLoop(id)
  return loop ? { loop } : undefined
}

/** `pievoCli` prefixes every command the dashboard shows. PIEVO_CLI points it at an
 *  in-repo daemon (e.g. `node /abs/packages/daemon/dist/cli.js`) so loops created
 *  from this server run local code instead of the registry build. */
export const getConfig = createServerFn({ method: 'GET' }).handler(() => {
  const custom = process.env.PIEVO_CLI?.trim()
  return {
    pievoCli: custom || 'pievo',
    /** A custom CLI is shown verbatim, without the global npm install step. */
    customCli: !!custom,
    /** Best URL for other devices, published by the launcher (HTTPS, Tailscale, then LAN). */
    publicUrl: process.env.PIEVO_PUBLIC_URL?.trim() || null,
  }
})

export const listLoops = createServerFn({ method: 'GET' })
  .handler(async () => {
    await backend()
    const [loopRows, machines] = await Promise.all([store.listLoops(), store.listMachines()])
    const loops = loopRows.sort((a, b) => a.createdAt < b.createdAt ? 1 : -1)
    return sortLoopSummariesByRecentRun(await toLoopSummaries(loops, machines))
  })

export const getLoopDetail = createServerFn({ method: 'GET' })
  .validator((id: string) => id)
  .handler(async ({ data: id }): Promise<LoopDetail> => {
    await backend()
    const found = await findLoop(id)
    if (!found) throw new Error('This loop does not exist.')
    return toLoopDetail(found.loop)
  })

export const loadOlderRuns = createServerFn({ method: 'GET' })
  .validator((d: { loopId: string; beforeTs: string; limit?: number }) => d)
  .handler(async ({ data }): Promise<RunSummary[]> => {
    await backend()
    if (!(await findLoop(data.loopId))) return []
    const limit = Math.min(Math.max(data.limit ?? 16, 1), 100)
    return toRunSummaries(data.loopId, await store.listRunsBefore(data.loopId, data.beforeTs, limit))
  })

export const setLoopMemory = createServerFn({ method: 'POST' })
  .validator((d: { id: string; memory: string }) => d)
  .handler(async ({ data }): Promise<MutationResult> => {
    await backend()
    if (!(await findLoop(data.id))) return { error: 'This loop does not exist.' }
    if (typeof data.memory !== 'string') return { error: 'memory must be text' }
    const { memoryIssue } = await import('../gateway/memory.js')
    const issue = memoryIssue(data.memory)
    if (issue) return { error: issue }
    return (await store.writeLoopMemory(data.id, data.memory)) ? { ok: true } : { error: 'This loop does not exist.' }
  })

export const patchLoop = createServerFn({ method: 'POST' })
  .validator((d: { id: string; patch: LoopPayload }) => d)
  .handler(async ({ data }): Promise<MutationResult> => {
    const { scheduler } = await backend()
    const found = await findLoop(data.id)
    if (!found) return { error: 'not found' }
    const p = data.patch
    {
      const validated = validateLoopEdit(found.loop, p)
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
    if (!(await findLoop(id))) return { error: 'not found' }
    const loop = await store.pauseLoop(id)
    if (!loop) return { error: 'not found' }
    scheduler.removeLoop(id)
    return { ok: true }
  })

export const startLoop = createServerFn({ method: 'POST' })
  .validator((id: string) => id)
  .handler(async ({ data: id }): Promise<MutationResult> => {
    const { scheduler } = await backend()
    const found = await findLoop(id)
    if (!found) return { error: 'not found' }
    if (found.loop.deleteRequestedAt) return { error: 'loop is being deleted' }
    const loop = await store.startLoop(id)
    if (!loop) return { error: 'not found' }
    scheduler.addLoop(loop)
    return { ok: true }
  })

export const stopLoop = createServerFn({ method: 'POST' })
  .validator((id: string) => id)
  .handler(async ({ data: id }): Promise<MutationResult> => {
    const { scheduler } = await backend()
    const found = await findLoop(id)
    if (!found) return { error: 'not found' }
    if (await store.hasRunningRun(id)) {
      const machine = await store.getMachine(found.loop.machineId)
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
    const found = await findLoop(id)
    if (!found) return { error: 'not found' }
    const machine = await store.getMachine(found.loop.machineId)
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
        { action: 'unreachable-delete', loopId: id, machineId: found.loop.machineId },
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
    if (!(await findLoop(id))) return { error: 'not found' }
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
    const found = run ? await findLoop(run.loopId) : undefined
    if (!run || !found) return { error: 'run not found' }
    if (run.phase === 'running' && (await store.getMachine(found.loop.machineId))?.daemonProtocol !== DAEMON_PROTOCOL_VERSION) {
      return { error: 'Daemon upgrade required to stop a running process' }
    }
    const result = await store.requestRunCancel(run.loopId, id)
    return result ? { ok: true, waiting: result.phase === 'running' } : { error: 'run not found' }
  })

/** Mint the key shown in the New-loop daemon connection command. */
export const mintConnectKey = createServerFn({ method: 'POST' })
  .handler(async (): Promise<{ token: string }> => {
    await backend()
    const { mintDeviceToken, rememberConnectKey } = await import('../gateway/tokens.js')
    const token = mintDeviceToken()
    await rememberConnectKey(token)
    return { token }
  })
