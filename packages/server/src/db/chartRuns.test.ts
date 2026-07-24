import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'

let tmp: string
let store: typeof import('./store.js')

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pievo-chart-runs-'))
  process.env.PIEVO_DATA_DIR = tmp
  process.env.PIEVO_DB_PATH = path.join(tmp, 'test.db')
  process.env.PIEVO_LOG_LEVEL = 'silent'
  const db = await import('./index.js')
  await db.runMigrations()
  store = await import('./store.js')
})

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

test('listChartRuns filters successful exec rows before applying its limit', async () => {
  const loop = await store.createLoop({ userId: 'u1', teamId: 't1', machineId: 'm1', name: 'chart', cron: '0 6 * * *' })
  const add = (runIndex: number, role: 'exec' | 'evolve', phase: 'done' | 'error' | 'pending' = 'done') => store.addRun({
    loopId: loop.id, userId: 'u1', machineId: 'm1', runIndex, role, phase,
    requestedBy: 'system', ts: `2026-07-${String(runIndex).padStart(2, '0')}T00:00:00Z`,
    status: phase === 'done' ? 'kept' : undefined, metrics: phase === 'done' ? { score: runIndex } : undefined,
  })
  await add(1, 'exec')
  await add(2, 'evolve')
  await add(3, 'exec')
  await add(4, 'evolve')
  await add(5, 'exec', 'error')
  await add(6, 'exec', 'pending')

  const rows = await store.listChartRuns(loop.id, 2)
  expect(rows.map((row) => row.runIndex)).toEqual([1, 3])
  expect(rows.every((row) => Object.keys(row).sort().join(',') === 'metrics,runIndex,status,ts')).toBe(true)
})
