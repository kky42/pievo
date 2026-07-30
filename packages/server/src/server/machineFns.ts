/**
 * Machine-management server functions. In auth mode, the signed-in user is the
 * sole human authorization boundary. Open mode intentionally shares all machine
 * administration, including reconnect tokens.
 */
import { createServerFn } from '@tanstack/react-start'

import * as store from '../db/store.js'
import type { Machine } from '../db/schema.js'
import { requestScope, type RequestScope } from '../auth.js'
import { machineIdFromToken, mintDeviceToken, sha256 } from '../gateway/tokens.js'
import { machineInScope, tokenVisibleTo } from './machineScope.js'
import { latestDaemonVersion } from './daemonVersion.js'
import { MIN_DAEMON_VERSION, daemonNeedsUpdate } from '../gateway/protocol.js'
import { ensureServer } from './boot.js'
import type { MachineSummary } from '../types'

/** Missing and out-of-scope machines both resolve to undefined. */
async function scopedMachine(id: string): Promise<{ scope: RequestScope; machine?: Machine }> {
  const scope = await requestScope()
  if (scope.enforce && !scope.userId) return { scope }
  const candidate = await store.getMachine(id)
  return { scope, machine: candidate && machineInScope(candidate, scope) ? candidate : undefined }
}

async function toSummary(machine: Machine, scope: RequestScope): Promise<MachineSummary> {
  return {
    id: machine.id,
    name: machine.name,
    online: !!machine.online,
    lastSeen: machine.lastSeen ?? null,
    hostname: machine.hostname ?? null,
    platform: machine.platform ?? null,
    arch: machine.arch ?? null,
    daemonVersion: machine.daemonVersion ?? null,
    daemonProtocol: machine.daemonProtocol ?? null,
    latestDaemonVersion: latestDaemonVersion.get(),
    needsUpdate: daemonNeedsUpdate(machine.daemonVersion),
    requiredDaemonVersion: MIN_DAEMON_VERSION,
    token: tokenVisibleTo(machine, scope) ? (machine.token ?? null) : null,
    loopCount: (await store.loopsForMachine(machine.id)).length,
  }
}

export const listMachines = createServerFn({ method: 'GET' })
  .handler(async () => {
    await ensureServer()
    const scope = await requestScope()
    if (scope.enforce && !scope.userId) return []
    const machines = scope.enforce
      ? await store.listMachinesForUser(scope.userId!)
      : await store.listMachines()
    return Promise.all(machines.filter((machine) => machine.name.trim()).map((machine) => toSummary(machine, scope)))
  })

export const createMachine = createServerFn({ method: 'POST' })
  .handler(async (): Promise<{ id: string; token: string } | { error: string }> => {
    await ensureServer()
    const scope = await requestScope()
    if (scope.enforce && !scope.userId) return { error: 'not signed in' }
    const token = mintDeviceToken()
    const id = machineIdFromToken(token)
    const owner = scope.userId ?? 'shared'
    await store.createMachine({
      id,
      userId: owner,
      name: '',
      tokenHash: sha256(token),
      token,
      online: false,
    })
    return { id, token }
  })

export const machineStatus = createServerFn({ method: 'GET' })
  .validator((id: string) => id)
  .handler(async ({ data: id }): Promise<MachineSummary | null> => {
    await ensureServer()
    const { scope, machine } = await scopedMachine(id)
    return machine ? toSummary(machine, scope) : null
  })

export const finalizeMachine = createServerFn({ method: 'POST' })
  .validator((data: { id: string; name: string }) => data)
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    await ensureServer()
    const name = data.name?.trim()
    if (!name) return { ok: false }
    const { machine } = await scopedMachine(data.id)
    if (!machine) return { ok: false }
    return { ok: !!(await store.updateMachine(data.id, { name })) }
  })

/**
 * Delete server-owned machine data without touching local project files. The
 * store rechecks ownership under the deletion lock in auth mode.
 */
export const deleteMachine = createServerFn({ method: 'POST' })
  .validator((id: string) => id)
  .handler(async ({ data: id }): Promise<{ ok: boolean; error?: string }> => {
    const { scheduler } = await ensureServer()
    const { scope, machine } = await scopedMachine(id)
    if (scope.enforce && !scope.userId) return { ok: false, error: 'unauthorized' }
    if (!machine) return { ok: false, error: 'machine not found' }
    const deleted = scope.enforce
      ? await store.forceDeleteMachine(id, scope.userId!)
      : await store.forceDeleteMachine(id)
    if (deleted.state === 'forbidden' || deleted.state === 'not-found') {
      return { ok: false, error: 'machine not found' }
    }
    for (const loopId of deleted.loopIds) scheduler.removeLoop(loopId)
    return { ok: true }
  })
