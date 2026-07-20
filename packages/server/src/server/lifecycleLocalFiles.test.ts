import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'

let tmp: string
let workdir: string
let sentinel: string
let db: typeof import('../db/index.js')
let store: typeof import('../db/store.js')

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pievo-lifecycle-local-files-'))
  workdir = path.join(tmp, 'local-project')
  sentinel = path.join(workdir, 'DO-NOT-DELETE.txt')
  fs.mkdirSync(workdir)
  fs.writeFileSync(sentinel, 'local project data stays local\n')
  process.env.PIEVO_DATA_DIR = path.join(tmp, 'server-data')
  process.env.PIEVO_DB_PATH = path.join(tmp, 'server.db')
  process.env.PIEVO_LOG_LEVEL = 'silent'
  db = await import('../db/index.js')
  await db.runMigrations()
  store = await import('../db/store.js')
})

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

async function loop(id: string, machineId: string) {
  await store.createMachine({ id: machineId, userId: 'owner', name: machineId, tokenHash: `hash-${machineId}`, online: true, daemonProtocol: 2 })
  return store.createLoop({ id, userId: 'owner', machineId, name: id, cron: '0 6 * * *', workdir, enabled: true, notify: 'auto' })
}

function expectSentinel() {
  expect(fs.readFileSync(sentinel, 'utf8')).toBe('local project data stays local\n')
}

test('Pause, Stop, Delete, and Force-delete only mutate server state and never remove local project files', async () => {
  const paused = await loop('pause-loop', 'pause-machine')
  await store.pauseLoop(paused.id)
  expectSentinel()

  const stopped = await loop('stop-loop', 'stop-machine')
  await store.enqueueRun(stopped.id, { role: 'exec', requestedBy: 'owner' })
  expect(await store.claimReadyRunForMachine(stopped.machineId)).toBeTruthy()
  await store.stopLoop(stopped.id)
  expectSentinel()

  const deleted = await loop('delete-loop', 'delete-machine')
  await store.requestDeleteLoop(deleted.id)
  expect(await store.tryDeleteLoop(deleted.id)).toBe(true)
  expect(await store.getLoop(deleted.id)).toBeUndefined()
  expectSentinel()

  const forced = await loop('force-loop', 'force-machine')
  await store.enqueueRun(forced.id, { role: 'exec', requestedBy: 'owner' })
  expect(await store.claimReadyRunForMachine(forced.machineId)).toBeTruthy()
  await store.requestDeleteLoop(forced.id)
  expect(await store.forceDeleteLoop(forced.id)).toBe(true)
  expect(await store.getLoop(forced.id)).toBeUndefined()
  expectSentinel()
})
