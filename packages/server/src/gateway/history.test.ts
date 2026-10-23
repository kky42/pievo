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
  const machine = await store.createMachine({ id: "m-history", name: "M", tokenHash: "h", online: true });
  const loop = await store.createLoop({ workdir: "/work", machineId: machine.id, name: "History", cron: "0 0 * * *", enabled: true });
  return { machine, loop };
}

test("detail selector is loop-scoped", async () => {
  const { machine, loop } = await seeded();
  const other = await store.createLoop({ workdir: "/work", machineId: machine.id, name: "Other", cron: "0 0 * * *", enabled: true });
  const foreign = await store.addRun({ loopId: other.id, machineId: machine.id, phase: "done", status: "ok", ts: "2026-01-04T00:00:00Z" });
  expect((await history.readLoopHistory(loop, { run: foreign.id, json: true })).status).toBe(404);
});
