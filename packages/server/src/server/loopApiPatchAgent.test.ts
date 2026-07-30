import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'

import { CODING_AGENTS, coerceCodingAgent } from '../types.js'
import { validateLoopEdit } from '../gateway/loopConfig.js'
import { testStore, type TestStore } from '../../test/store.js'

let tmp: string
let store: TestStore

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pievo-patchagent-'))
  process.env.PIEVO_DATA_DIR = tmp
  process.env.PIEVO_LOG_LEVEL = 'silent'
  const db = await import('../db/index.js')
  await db.runMigrations()
  store = testStore(await import('../db/store.js'))
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('coerceCodingAgent accepts every known enum value and rejects the rest', () => {
  for (const a of CODING_AGENTS) expect(coerceCodingAgent(a)).toBe(a)
  for (const bad of ['emacs', 'CLAUDE-CODE', '', ' codex', 42, null, undefined, {}]) {
    expect(coerceCodingAgent(bad)).toBeNull()
  }
})

test('canonical edit validation persists known agents and rejects unknown agents', async () => {
  await store.createMachine({ id: 'm1', userId: 'u1', name: 'M1', tokenHash: 'hash-m1' })
  const created = await store.createLoop({ workdir: "/work", userId: 'u1', machineId: 'm1', name: 'A', cron: '0 6 * * *' })
  expect(created.agent).toBe('claude-code')

  const accepted = validateLoopEdit(created, { agent: 'pi', reasoningEffort: 'medium' })
  expect(accepted.ok).toBe(true)
  if (!accepted.ok) throw new Error(accepted.detail)
  const updated = await store.updateLoop(created.id, accepted.value)
  expect(updated!.agent).toBe('pi')

  const absent = validateLoopEdit(updated!, { name: 'B' })
  expect(absent.ok).toBe(true)
  if (!absent.ok) throw new Error(absent.detail)
  const renamed = await store.updateLoop(created.id, absent.value)
  expect(renamed!.agent).toBe('pi')

  expect(validateLoopEdit(renamed!, { agent: 'emacs' })).toMatchObject({ ok: false })
  expect((await store.getLoop(created.id))!.agent).toBe('pi')
})
