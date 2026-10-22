/**
 * Machine-management server functions. Pievo is single-user: anyone who can
 * reach the dashboard administers every machine, including reconnect tokens.
 */
import { createServerFn } from '@tanstack/react-start'

import * as store from '../db/store.js'
import type { Machine } from '../db/schema.js'
import { machineIdFromToken, mintDeviceToken, sha256 } from '../gateway/tokens.js'
import { latestDaemonVersion } from './daemonVersion.js'
import { MIN_DAEMON_VERSION, daemonNeedsUpdate } from '../gateway/protocol.js'
import { ensureServer } from './boot.js'
import type { MachineSummary } from '../types'

async function toSummary(machine: Machine): Promise<MachineSummary> {
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
    token: machine.token ?? null,
    loopCount: (await store.loopsForMachine(machine.id)).length,
  }
}

export const listMachines = createServerFn({ method: 'GET' })
  .handler(async () => {
    await ensureServer()
    const machines = await store.listMachines()
    return Promise.all(machines.filter((machine) => machine.name.trim()).map(toSummary))
  })

export const createMachine = createServerFn({ method: 'POST' })
  .handler(async (): Promise<{ id: string; token: string }> => {
    await ensureServer()
    const token = mintDeviceToken()
    const id = machineIdFromToken(token)
    await store.createMachine({
      id,
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
    const machine = await store.getMachine(id)
    return machine ? toSummary(machine) : null
  })

export const finalizeMachine = createServerFn({ method: 'POST' })
  .validator((data: { id: string; name: string }) => data)
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    await ensureServer()
    const name = data.name?.trim()
    if (!name) return { ok: false }
    return { ok: !!(await store.updateMachine(data.id, { name })) }
  })

/** Delete server-owned machine data without touching local project files. */
export const deleteMachine = createServerFn({ method: 'POST' })
  .validator((id: string) => id)
  .handler(async ({ data: id }): Promise<{ ok: boolean; error?: string }> => {
    const { scheduler } = await ensureServer()
    const deleted = await store.forceDeleteMachine(id)
    if (deleted.state === 'not-found') return { ok: false, error: 'machine not found' }
    for (const loopId of deleted.loopIds) scheduler.removeLoop(loopId)
    return { ok: true }
  })
