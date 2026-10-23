import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";

import { testStore, type TestStore } from "../../test/store.js";

let tmp: string;
let db: typeof import("../db/index.js");
let store: TestStore;
let history: typeof import("./history.js");

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-history-"));
  process.env.PIEVO_DATA_DIR = tmp;
  process.env.PIEVO_LOG_LEVEL = "silent";
  db = await import("../db/index.js");
  await db.runMigrations();
  store = testStore(await import("../db/store.js"));
  history = await import("./history.js");
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

beforeEach(async () => {
  await (db.client as any).exec("DELETE FROM run_leases; DELETE FROM runs; DELETE FROM loops; DELETE FROM machines;");
});

async function seeded() {
  const machine = await store.createMachine({ id: "m-history", name: "M", tokenHash: "h", online: true });
  const loop = await store.createLoop({ workdir: "/work", machineId: machine.id, name: "History", cron: "0 0 * * *", enabled: true });
  return { machine, loop };
}

test("attention history ignores a block run's legacy attention", async () => {
  const { machine, loop } = await seeded();
  const block = await store.addRun({ loopId: loop.id, machineId: machine.id, phase: "done", status: "block", attention: "legacy block reason", ts: "2026-01-01T00:00:00.000Z" });
  const ok = await store.addRun({ loopId: loop.id, machineId: machine.id, phase: "done", status: "ok", attention: "new item", ts: "2026-01-02T00:00:00.000Z" });
  const list = JSON.parse(String(((await history.readLoopHistory(loop, { attention: true, json: true })).body as { text: string }).text)) as { runs: Array<{ runIndex: number; attention: string | null }> };
  expect(list.runs.map((run) => run.runIndex)).toEqual([ok.runIndex]);
  expect(list.runs[0]!.attention).toBe("new item");
  const detail = JSON.parse(String(((await history.readLoopHistory(loop, { run: String(block.runIndex), json: true })).body as { text: string }).text)) as { attention: string | null };
  expect(detail.attention).toBeNull();
});

test("detail selector is loop-scoped", async () => {
  const { machine, loop } = await seeded();
  const other = await store.createLoop({ workdir: "/work", machineId: machine.id, name: "Other", cron: "0 0 * * *", enabled: true });
  const foreign = await store.addRun({ loopId: other.id, machineId: machine.id, phase: "done", status: "ok", ts: "2026-01-04T00:00:00Z" });
  expect((await history.readLoopHistory(loop, { run: foreign.id, json: true })).status).toBe(404);
});

test("time windows and the attention filter select the runs an agent asks for", async () => {
  const { machine, loop } = await seeded();
  await store.addRun({ loopId: loop.id, machineId: machine.id, phase: "done", status: "ok", ts: "2026-01-01T00:00:00.000Z" });
  await store.addRun({ loopId: loop.id, machineId: machine.id, phase: "done", status: "ok", attention: "new item", ts: "2026-01-02T00:00:00.000Z" });
  await store.addRun({ loopId: loop.id, machineId: machine.id, phase: "error", error: "boom", ts: "2026-01-03T00:00:00.000Z" });
  const indexes = async (flags: Record<string, string | boolean>) =>
    (JSON.parse(String(((await history.readLoopHistory(loop, { ...flags, json: true })).body as { text: string }).text)) as { runs: Array<{ runIndex: number }> }).runs.map((run) => run.runIndex);
  expect(await indexes({ since: "2026-01-02T00:00:00Z" })).toEqual([3, 2]);
  expect(await indexes({ until: "2026-01-02T00:00:00Z" })).toEqual([2, 1]);
  expect(await indexes({ attention: true })).toEqual([2]);
  expect((await history.readLoopHistory(loop, { run: "2", attention: true })).status).toBe(400);
});
