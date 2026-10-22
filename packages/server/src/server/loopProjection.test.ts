import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";

import { registerRunLease, testStore, type TestStore } from "../../test/store.js";

let tmp: string;
let db: typeof import("../db/index.js");
let store: TestStore;
let projection: typeof import("./loopProjection.js");

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-loop-projection-"));
  process.env.PIEVO_DATA_DIR = tmp;
  process.env.PIEVO_LOG_LEVEL = "silent";
  db = await import("../db/index.js");
  await db.runMigrations();
  store = testStore(await import("../db/store.js"));
  projection = await import("./loopProjection.js");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  await (db.client as { exec(q: string): Promise<unknown> }).exec("DELETE FROM run_leases; DELETE FROM runs; DELETE FROM loops; DELETE FROM machines;");
});

async function seed(agent: "claude-code" | "codex" | "pi") {
  await store.createMachine({ id: "m-a", name: "M", tokenHash: "h", online: true });
  return store.createLoop({
    machineId: "m-a",
    name: "L",
    cron: "0 8 * * *",
    workdir: "/tmp/p",
    agent,
    enabled: true,
  });
}

test("summaries aggregate run count and input plus output tokens from the last seven days", async () => {
  const loop = await seed("codex");
  const machineId = loop.machineId;
  const recentTs = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const oldTs = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

  await store.addRun({ loopId: loop.id, machineId, phase: "done", ts: recentTs, usage: { inputTokens: 1_200, outputTokens: 34, cacheReadTokens: 999 } });
  await store.addRun({ loopId: loop.id, machineId, phase: "error", ts: recentTs, usage: { outputTokens: 6 } });
  await store.addRun({ loopId: loop.id, machineId, phase: "done", ts: oldTs, usage: { inputTokens: 50_000, outputTokens: 50_000 } });

  const summary = (await projection.toLoopSummaries([loop], [(await store.getMachine(loop.machineId))!]))[0]!;
  expect(summary.recentUsage).toEqual({ runCount: 2, tokenCount: 1_240 });
});

test("a claimed run keeps its actual agent after the loop agent changes", async () => {
  const loop = await seed("codex");
  await store.enqueueRun(loop.id, { requestedBy: "owner" });
  const claimed = await store.claimReadyRunForMachine(loop.machineId);
  expect(claimed?.run.agent).toBe("codex");

  await store.updateLoop(loop.id, { agent: "claude-code" });
  const detail = await projection.toLoopDetail((await store.getLoop(loop.id))!);
  expect(detail.loop.agent).toBe("claude-code");
  expect(detail.runs.find((run) => run.id === claimed!.run.id)?.agent).toBe("codex");
});

test("terminal reconciliation state crosses the dashboard boundary and explains queued blocking", async () => {
  const loop = await seed("claude-code");
  const interrupted = await store.addRun({ loopId: loop.id, machineId: loop.machineId, phase: "running", ts: new Date().toISOString() });
  await registerRunLease({ runId: interrupted.id, loopId: loop.id, machineId: loop.machineId });
  await store.reclaimRun(interrupted.id, "running", "machine timed out / disconnected");
  await store.enqueueRun(loop.id, { requestedBy: "owner" });

  const blocked = await projection.toLoopDetail((await store.getLoop(loop.id))!);
  expect(blocked.summary.reconciliationBlocking).toBe(true);
  expect(blocked.runs.find((run) => run.id === interrupted.id)?.reconciliation).toBe("blocking");

  await store.releaseAbsentReconciliations(loop.machineId, []);
  const released = await projection.toLoopDetail((await store.getLoop(loop.id))!);
  expect(released.summary.reconciliationBlocking).toBe(false);
  expect(released.runs.find((run) => run.id === interrupted.id)?.reconciliation).toBe("report-only");
});
