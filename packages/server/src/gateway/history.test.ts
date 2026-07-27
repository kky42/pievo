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
  await (db.client as any).exec("DELETE FROM run_snapshots; DELETE FROM artifact_files; DELETE FROM blobs; DELETE FROM run_leases; DELETE FROM runs; DELETE FROM loops; DELETE FROM machines;");
});

async function seeded() {
  const machine = await store.createMachine({ id: "m-history", userId: "u1", name: "M", tokenHash: "h", online: true });
  const loop = await store.createLoop({ workdir: "/work", userId: "u1", machineId: machine.id, name: "History", cron: "0 0 * * *", enabled: true });
  return { machine, loop };
}

test("history grammar rejects unknown filters", () => {
  expect(history.parseHistoryFlags({ unknown: true })).toMatchObject({ ok: false });

  expect(history.parseHistoryFlags({ since: "2026-01-01T00:00:00Z", status: "keep", limit: "5", json: true })).toMatchObject({
    ok: true,
    value: { mode: "list", status: "keep", limit: 5, json: true },
  });
  expect(history.parseHistoryFlags({ run: "3", diff: true })).toMatchObject({ ok: true, value: { mode: "detail", run: 3, diff: true } });
});

test("list history returns the canonical bounded summary", async () => {
  const { machine, loop } = await seeded();
  await store.addRun({
    loopId: loop.id,
    machineId: machine.id,
    phase: "done",
    requestedBy: "owner",
    status: "keep",
    message: "ordinary result",
    durationMs: 120,
    usage: { inputTokens: 10, outputTokens: 2 },
    finalText: "provider output",
    ts: "2026-01-02T00:00:00Z",
  });

  const result = await history.readLoopHistory(loop, { json: true });
  expect(result.status).toBe(200);
  const data = JSON.parse(String((result.body as any).text));
  expect(data).toMatchObject({ count: 1, total: 1, runs: [{ phase: "done", status: "keep", message: "ordinary result", tokenUsage: 12 }] });
  expect(Object.keys(data.runs[0]).sort()).toEqual([
    "durationMs", "finalTextAvailable", "message", "messageTruncated", "phase", "runIndex", "status", "terminalAt", "tokenUsage",
  ]);
});

test("detail history keeps diagnostics and diff availability", async () => {
  const { machine, loop } = await seeded();
  const run = await store.addRun({
    loopId: loop.id,
    machineId: machine.id,
    phase: "error",
    error: "provider failed",
    message: "agent summary",
    finalText: "provider final",
    durationMs: 50,
    usage: { inputTokens: 3, outputTokens: 4 },
    ts: "2026-01-03T00:00:00Z",
  });
  const result = await history.readLoopHistory(loop, { run: String(run.runIndex), json: true });
  expect(result.status).toBe(200);
  const detail = JSON.parse(String((result.body as any).text));
  expect(detail).toMatchObject({
    runIndex: run.runIndex,
    phase: "error",
    error: "provider failed",
    message: "agent summary",
    finalText: "provider final",
    tokenUsage: 7,
    diffAvailable: false,
  });
});

test("detail selector is loop-scoped", async () => {
  const { machine, loop } = await seeded();
  const other = await store.createLoop({ workdir: "/work", userId: "u1", machineId: machine.id, name: "Other", cron: "0 0 * * *", enabled: true });
  const foreign = await store.addRun({ loopId: other.id, machineId: machine.id, phase: "done", ts: "2026-01-04T00:00:00Z" });
  expect((await history.readLoopHistory(loop, { run: foreign.id, json: true })).status).toBe(404);
});
