/** Canonical loop/run projection coverage for the dashboard boundary. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";

import { testStore, type TestStore } from "../../test/store.js";
import type { LoopSummary } from "../types.js";

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
  await store.createMachine({ id: "m-a", userId: "u1", name: "M", tokenHash: "h", online: true });
  return store.createLoop({
    userId: "u1",
    machineId: "m-a",
    name: "L",
    cron: "0 8 * * *",
    workdir: "/tmp/p",
    agent,
    enabled: true,
  });
}

test("dashboard summaries put recently run loops first and preserve never-run order", () => {
  const summaries = [
    { id: "never-new", lastRunTs: null },
    { id: "older-run", lastRunTs: "2026-01-01T00:00:00.000Z" },
    { id: "newer-run", lastRunTs: "2026-02-01T00:00:00.000Z" },
    { id: "never-old", lastRunTs: null },
  ] as LoopSummary[];

  expect(projection.sortLoopSummariesByRecentRun(summaries).map((loop) => loop.id)).toEqual([
    "newer-run",
    "older-run",
    "never-new",
    "never-old",
  ]);
  expect(summaries.map((loop) => loop.id)).toEqual(["never-new", "older-run", "newer-run", "never-old"]);
});

test("dashboard summaries include the loop's machine presentation", async () => {
  const summary = await projection.toLoopSummary(await seed("codex"));
  expect(summary.machine).toMatchObject({ id: "m-a", name: "M", online: false, presence: "offline" });
});

test("summaries aggregate run count and input plus output tokens from the last seven days", async () => {
  const loop = await seed("codex");
  const machineId = loop.machineId;
  const recentTs = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const oldTs = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

  await store.addRun({ loopId: loop.id, machineId, phase: "done", ts: recentTs, usage: { inputTokens: 1_200, outputTokens: 34, cacheReadTokens: 999 } });
  await store.addRun({ loopId: loop.id, machineId, phase: "error", ts: recentTs, usage: { outputTokens: 6 } });
  await store.addRun({ loopId: loop.id, machineId, phase: "done", ts: oldTs, usage: { inputTokens: 50_000, outputTokens: 50_000 } });

  const summary = await projection.toLoopSummary(loop);
  expect(summary.recentUsage).toEqual({ runCount: 2, tokenCount: 1_240 });
});

test("a loop's recorded agent maps onto detail and summary", async () => {
  const loop = await seed("codex");
  const detail = await projection.toLoopDetail(loop);
  expect(detail.loop.agent).toBe("codex");
  expect(detail.summary.agent).toBe("codex");
});

test("execution model and reasoning effort map to dashboard detail without defaults", async () => {
  const loop = await seed("codex");
  await store.updateLoop(loop.id, { model: "gpt-custom", reasoningEffort: "custom-high" });
  const configured = await projection.toLoopDetail((await store.getLoop(loop.id))!);
  expect(configured.loop.model).toBe("gpt-custom");
  expect(configured.loop.reasoningEffort).toBe("custom-high");

  await store.updateLoop(loop.id, { model: null, reasoningEffort: null });
  const defaults = await projection.toLoopDetail((await store.getLoop(loop.id))!);
  expect(defaults.loop.model).toBeNull();
  expect(defaults.loop.reasoningEffort).toBeNull();
});

test("a claude-code loop maps directly to the current UI shape", async () => {
  const detail = await projection.toLoopDetail(await seed("claude-code"));
  expect(detail.loop.agent).toBe("claude-code");
  expect(detail.summary.agent).toBe("claude-code");
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

test("lifecycle request markers and daemon protocol surface at the Dashboard boundary", async () => {
  const loop = await seed("claude-code");
  await store.enqueueRun(loop.id, { requestedBy: "owner" });
  const claimed = await store.claimReadyRunForMachine(loop.machineId);
  await store.requestRunCancel(loop.id, claimed!.run.id);
  await store.requestDeleteLoop(loop.id);
  await store.updateMachine(loop.machineId, { daemonProtocol: 2 });

  const detail = await projection.toLoopDetail((await store.getLoop(loop.id))!);
  expect(detail.summary.deleteRequestedAt).toBeTruthy();
  expect(detail.runs.find((run) => run.id === claimed!.run.id)).toMatchObject({
    phase: "running",
    cancelRequested: true,
  });
  expect(detail.machine.daemonProtocol).toBe(2);
});

test("terminal reconciliation state crosses the dashboard boundary and explains queued blocking", async () => {
  const loop = await seed("claude-code");
  const interrupted = await store.addRun({ loopId: loop.id, machineId: loop.machineId, phase: "running", ts: new Date().toISOString() });
  await (await import("../gateway/tokens.js")).registerRunLease({ runId: interrupted.id, loopId: loop.id, machineId: loop.machineId });
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

test("report incidents and pause causes cross the client projection boundary", async () => {
  const loop = await seed("claude-code");
  const paused = await store.pauseLoop(loop.id);
  const incident = {
    at: "2026-08-01T00:00:00.000Z",
    code: "REPORT_INVALID" as const,
    reason: "Terminal report rejected.",
    issues: ["durationMs must be non-negative"],
    reportId: "report-1",
    payloadDigest: "digest",
    faultDomain: "protocol" as const,
    recommendedAction: "Upgrade and restart the daemon.",
  };
  const run = await store.addRun({ loopId: loop.id, machineId: loop.machineId, phase: "error", ts: incident.at, reportIncident: incident });

  const detail = await projection.toLoopDetail(paused!);
  expect(detail.summary.pauseCause).toMatchObject({ kind: "owner" });
  expect(detail.loop.pauseCause).toMatchObject({ kind: "owner" });
  expect(detail.runs.find((item) => item.id === run.id)?.reportIncident).toEqual(incident);
});
