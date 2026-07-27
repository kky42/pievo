import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";

import type { Loop, Run } from "../db/schema.js";
import { testStore, type TestStore } from "../../test/store.js";

let tmp: string;
let db: typeof import("../db/index.js");
let store: TestStore;
let sched: typeof import("./index.js");
let tokens: typeof import("../gateway/tokens.js");

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-schedule-facts-"));
  process.env.PIEVO_DATA_DIR = tmp;
  process.env.PIEVO_DB_PATH = path.join(tmp, "test.db");
  process.env.PIEVO_LOG_LEVEL = "silent";
  db = await import("../db/index.js");
  await db.runMigrations();
  store = testStore(await import("../db/store.js"));
  sched = await import("./index.js");
  tokens = await import("../gateway/tokens.js");
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

beforeEach(async () => {
  await (db.client as { exec(q: string): Promise<unknown> }).exec(
    "DELETE FROM run_leases; DELETE FROM runs; DELETE FROM loops; DELETE FROM machines;",
  );
});

async function makeLoop(
  suffix: string,
  patch: Partial<{
    enabled: boolean;
    scheduleMode: "cron" | "continuous";
    continuousDelayMinutes: number;
  }> = {},
): Promise<Loop> {
  const machine = await store.createMachine({
    id: `m-${suffix}`,
    userId: "u1",
    name: "M",
    tokenHash: `h-${suffix}`,
    online: true,
  });
  return store.createLoop({ workdir: "/work",
    userId: "u1",
    machineId: machine.id,
    name: suffix,
    cron: "*/5 * * * *",
    enabled: true,
    ...patch,
  });
}

function scheduler() {
  return new sched.Scheduler({ dispatch(): void {} });
}

async function pending(loopId: string): Promise<Run[]> {
  return (await store.openRunsForLoop(loopId)).filter((r) => r.phase === "pending");
}

async function claim(loop: Loop) {
  const claimed = await store.claimReadyRunForMachine(loop.machineId);
  if (!claimed) throw new Error("expected claim");
  return claimed;
}

test("cron overlap skip consumes an occurrence without queueing behind an open run", async () => {
  const loop = await makeLoop("overlap-skip");
  await store.updateLoop(loop.id, { cronOverlap: "skip" });
  await store.addRun({
    loopId: loop.id, machineId: loop.machineId,
    phase: "running", requestedBy: "system", ts: new Date().toISOString(),
  });
  const due = new Date(Date.now() - 1_000).toISOString();
  await store.updateLoop(loop.id, { nextCadenceAt: due });

  const [advanced] = await store.advanceDueSchedules();
  expect(advanced).toMatchObject({ state: "skipped" });
  expect(await pending(loop.id)).toHaveLength(0);
  expect(Date.parse((await store.getLoop(loop.id))!.nextCadenceAt!)).toBeGreaterThan(Date.now());
});

test("cron overlap queue-one retains one coalesced follow-up", async () => {
  const loop = await makeLoop("overlap-queue");
  await store.updateLoop(loop.id, { cronOverlap: "queue-one" });
  await store.addRun({
    loopId: loop.id, machineId: loop.machineId,
    phase: "running", requestedBy: "system", ts: new Date().toISOString(),
  });
  await store.updateLoop(loop.id, { nextCadenceAt: new Date(Date.now() - 1_000).toISOString() });
  expect((await store.advanceDueSchedules())[0]).toMatchObject({ state: "queued" });
  expect(await pending(loop.id)).toHaveLength(1);

  await store.updateLoop(loop.id, { nextCadenceAt: new Date(Date.now() - 1_000).toISOString() });
  expect((await store.advanceDueSchedules())[0]).toMatchObject({ state: "coalesced" });
  expect(await pending(loop.id)).toHaveLength(1);
});

test("an ordinary terminal does not enqueue hidden follow-up work", async () => {
  const loop = await makeLoop("ordinary-only");
  const running = await store.addRun({
    loopId: loop.id, machineId: loop.machineId,
    phase: "running", requestedBy: "system", ts: new Date().toISOString(),
  });
  await store.finalizeRunningRun(loop.id, running.id, { phase: "done", status: "keep", ts: new Date().toISOString() });
  expect(await pending(loop.id)).toHaveLength(0);
});

test("claim and cancel race cannot leave a canceled run with a live lease", async () => {
  const loop = await makeLoop("claim-cancel");
  const queued = await store.enqueueRun(loop.id, { requestedBy: "owner" });
  if (!("run" in queued)) throw new Error("expected run");

  const [claimed, canceled] = await Promise.all([
    store.claimReadyRunForMachine(loop.machineId),
    store.requestRunCancel(loop.id, queued.run.id),
  ]);
  const final = (await store.getRun(queued.run.id))!;
  expect(["running", "canceled"]).toContain(final.phase);
  expect(canceled).toBeTruthy();
  if (final.phase === "canceled") {
    expect(claimed).toBeUndefined();
  } else {
    expect(final.cancelRequestedAt).toBeTruthy();
    expect((await tokens.resolveLease(claimed!.runToken))?.runId).toBe(final.id);
  }
});

test("due cadence and one-shot facts coalesce into one exec and are consumed together", async () => {
  const loop = await makeLoop("both-due");
  const past = new Date(Date.now() - 60_000).toISOString();
  await store.updateLoop(loop.id, { nextCadenceAt: past, nextRunAt: past });

  const [advanced] = await store.advanceDueSchedules();
  expect(advanced).toBeTruthy();
  expect(await pending(loop.id)).toHaveLength(1);
  const fresh = (await store.getLoop(loop.id))!;
  expect(fresh.nextRunAt).toBeNull();
  expect(Date.parse(fresh.nextCadenceAt!)).toBeGreaterThan(Date.now());
});

test("a due fact coalesces with owner exec without downgrading it", async () => {
  const loop = await makeLoop("due-owner");
  const owner = await scheduler().runNow(loop.id);
  if (!("run" in owner)) throw new Error("expected owner run");
  await store.updateLoop(loop.id, { nextCadenceAt: new Date(Date.now() - 1_000).toISOString() });

  await store.advanceDueSchedules();
  const [run] = await pending(loop.id);
  expect(run).toMatchObject({ id: owner.run.id, requestedBy: "owner" });
});

test("continuous activation, claim, terminal, and due transitions use nextCadenceAt", async () => {
  const loop = await makeLoop("continuous", { scheduleMode: "continuous", continuousDelayMinutes: 2 });
  expect((await store.getLoop(loop.id))!.nextCadenceAt).toBeTruthy();
  await store.advanceDueSchedules();
  expect((await store.getLoop(loop.id))!.nextCadenceAt).toBeNull();

  const item = await claim(loop);
  const terminalAt = new Date().toISOString();
  const terminal = await store.finalizeRunningRun(
    loop.id,
    item.run.id,
    { phase: "done", ts: terminalAt },
    {},
    tokens.sha256(item.runToken),
  );
  expect(terminal?.loop.nextCadenceAt).toBe(new Date(Date.parse(terminalAt) + 2 * 60_000).toISOString());

  await store.advanceDueSchedules(new Date(Date.parse(terminalAt) + 3 * 60_000).toISOString());
  expect((await store.getLoop(loop.id))!.nextCadenceAt).toBeNull();
  expect(await pending(loop.id)).toHaveLength(1);
});

test("canceled exec does not restart continuous cadence", async () => {
  const loop = await makeLoop("cancel-chain", { scheduleMode: "continuous" });
  await store.enqueueRun(loop.id, { requestedBy: "owner" });
  const item = await claim(loop);
  expect((await store.getLoop(loop.id))!.nextCadenceAt).toBeNull();
  await store.requestRunCancel(loop.id, item.run.id);
  expect((await store.getLoop(loop.id))!.nextCadenceAt).toBeNull();
});

test("mode switches preserve the single ordinary pending row", async () => {
  const loop = await makeLoop("switch");
  await store.enqueueRun(loop.id, { requestedBy: "system" });

  const continuous = await store.updateLoop(loop.id, { scheduleMode: "continuous" });
  expect(continuous!.nextCadenceAt).toBeNull();
  expect(await pending(loop.id)).toHaveLength(1);
  const cron = await store.updateLoop(loop.id, { scheduleMode: "cron" });
  expect(Date.parse(cron!.nextCadenceAt!)).toBeGreaterThan(Date.now());
  expect(await pending(loop.id)).toHaveLength(1);
});
test("continuous delay edits retime the durable fact without run-history inference", async () => {
  const loop = await makeLoop("retime", { scheduleMode: "continuous", continuousDelayMinutes: 2 });
  const terminalAt = new Date(Date.now() - 30_000).toISOString();
  const oldTarget = new Date(Date.parse(terminalAt) + 2 * 60_000).toISOString();
  await store.updateLoop(loop.id, { nextCadenceAt: oldTarget });
  const updated = await store.updateLoop(loop.id, { continuousDelayMinutes: 7 });
  expect(updated!.nextCadenceAt).toBe(new Date(Date.parse(terminalAt) + 7 * 60_000).toISOString());

  const alreadyDue = new Date(Date.now() - 1_000).toISOString();
  await store.updateLoop(loop.id, { nextCadenceAt: alreadyDue });
  const dueEdit = await store.updateLoop(loop.id, { continuousDelayMinutes: 20 });
  expect(dueEdit!.nextCadenceAt).toBe(alreadyDue);
});

test("pause clears facts, cancels system work, and preserves owner Run-once work", async () => {
  const loop = await makeLoop("pause");
  await store.enqueueRun(loop.id, { requestedBy: "system" });
  await store.enqueueRun(loop.id, { requestedBy: "owner" });
  await store.updateLoop(loop.id, { nextRunAt: new Date(Date.now() + 60_000).toISOString() });

  const paused = await store.updateLoop(loop.id, { enabled: false });
  expect(paused).toMatchObject({ nextCadenceAt: null, nextRunAt: null });
  expect(await pending(loop.id)).toHaveLength(1);
  expect((await pending(loop.id))[0]).toMatchObject({ requestedBy: "owner" });
});
test("boot initializes missing cron facts to the future, idempotently and without catch-up", async () => {
  const loop = await makeLoop("boot-init");
  await store.updateLoop(loop.id, { nextCadenceAt: null });
  const at = new Date().toISOString();
  const first = await store.initializeCronCadence(at);
  const target = (await store.getLoop(loop.id))!.nextCadenceAt;
  const second = await store.initializeCronCadence(new Date(Date.parse(at) + 1_000).toISOString());

  expect(first.map((l) => l.id)).toContain(loop.id);
  expect(Date.parse(target!)).toBeGreaterThan(Date.parse(at));
  expect(second).toHaveLength(0);
  expect(await pending(loop.id)).toHaveLength(0);
});

test("coalescing mutates updatedAt but never the pending row's immutable createdAt", async () => {
  const loop = await makeLoop("age-anchor");
  const first = await store.enqueueRun(loop.id, { requestedBy: "system" });
  if (!("run" in first)) throw new Error("expected run");
  const createdAt = first.run.createdAt;
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await store.enqueueRun(loop.id, { requestedBy: "owner" });
  if (!("run" in second)) throw new Error("expected run");

  expect(second.run.createdAt).toBe(createdAt);
  expect(Date.parse(second.run.updatedAt)).toBeGreaterThan(Date.parse(createdAt));
});

test("terminal failure auto-pauses and cancels system work in the terminal transaction", async () => {
  const loop = await makeLoop("atomic-breaker", { scheduleMode: "continuous", continuousDelayMinutes: 5 });
  const base = Date.now() - 10_000;
  for (let i = 0; i < 2; i++) {
    await store.addRun({
      loopId: loop.id, machineId: loop.machineId,
      phase: "error", requestedBy: "system",
      ts: new Date(base + i).toISOString(),
    });
  }
  const running = await store.addRun({
    loopId: loop.id, machineId: loop.machineId,
    phase: "running", requestedBy: "system", ts: new Date().toISOString(),
  });
  await store.enqueueRun(loop.id, { requestedBy: "system" });
  await store.enqueueRun(loop.id, { requestedBy: "system" });

  const terminal = await store.finalizeRunningRun(
    loop.id,
    running.id,
    { phase: "error", error: "third", ts: new Date().toISOString() },
    {},
    undefined,
    3,
  );
  expect(terminal).toMatchObject({ autoPaused: true, failureStreak: 3 });
  expect(terminal?.loop).toMatchObject({ enabled: false, nextCadenceAt: null, nextRunAt: null });
  expect(await pending(loop.id)).toHaveLength(0);
  expect(await store.claimReadyRunForMachine(loop.machineId)).toBeUndefined();
});

test("failure streak ordering uses runIndex rather than timestamps", async () => {
  const loop = await makeLoop("indexed-breaker", { scheduleMode: "continuous", continuousDelayMinutes: 5 });
  await store.addRun({
    loopId: loop.id, machineId: loop.machineId,
    phase: "error", requestedBy: "system", ts: "2030-01-01T00:00:00Z",
  });
  await store.addRun({
    loopId: loop.id, machineId: loop.machineId,
    phase: "done", requestedBy: "system", ts: "2020-01-01T00:00:00Z",
  });
  const running = await store.addRun({
    loopId: loop.id, machineId: loop.machineId,
    phase: "running", requestedBy: "system", ts: "2010-01-01T00:00:00Z",
  });
  const terminal = await store.finalizeRunningRun(
    loop.id,
    running.id,
    { phase: "error", error: "new failure", ts: "2000-01-01T00:00:00Z" },
    {},
    undefined,
    2,
  );
  expect(terminal).toMatchObject({ failureStreak: 1, autoPaused: false });
  expect(terminal?.loop.enabled).toBe(true);
});

test("terminal-grace fences due cadence until one late reconcile retimes it", async () => {
  const loop = await makeLoop("late", { scheduleMode: "continuous", continuousDelayMinutes: 5 });
  const running = await store.addRun({
    loopId: loop.id,
    machineId: loop.machineId,
    phase: "running",
    requestedBy: "system",
    ts: new Date(Date.now() - 30 * 60_000).toISOString(),
  });
  const token = await tokens.registerRunLease({ runId: running.id, loopId: loop.id, machineId: loop.machineId });
  const reclaimedAt = new Date(Date.now() - 10 * 60_000).toISOString();
  await store.reclaimRun(running.id, "running", "timeout", reclaimedAt);
  expect((await store.getLoop(loop.id))!.nextCadenceAt).toBe(new Date(Date.parse(reclaimedAt) + 5 * 60_000).toISOString());
  expect(await store.advanceDueSchedules()).toHaveLength(0);

  const actualAt = new Date().toISOString();
  const reconciled = await store.reconcileReclaimedRun(
    loop.id,
    running.id,
    tokens.sha256(token),
    { phase: "done", error: null, ts: actualAt },
  );
  expect(reconciled?.loop.nextCadenceAt).toBe(new Date(Date.parse(actualAt) + 5 * 60_000).toISOString());
  expect(await tokens.resolveLease(token)).toBeUndefined();
  expect(await pending(loop.id)).toHaveLength(0);
});

test("expired terminal-grace cannot reconcile after a successor claim", async () => {
  const loop = await makeLoop("expired-late", { scheduleMode: "continuous" });
  const old = await store.addRun({
    loopId: loop.id, machineId: loop.machineId,
    phase: "running", requestedBy: "system", ts: new Date(Date.now() - 60_000).toISOString(),
  });
  const token = await tokens.registerRunLease({ runId: old.id, loopId: loop.id, machineId: loop.machineId });
  await store.reclaimRun(old.id, "running", "timeout", new Date(Date.now() - 2_000).toISOString(), 1);
  await store.enqueueRun(loop.id, { requestedBy: "owner" });
  const successor = await store.claimReadyRunForMachine(loop.machineId);
  expect(successor?.run.id).not.toBe(old.id);

  const reconciled = await store.reconcileReclaimedRun(
    loop.id,
    old.id,
    tokens.sha256(token),
    { phase: "done", error: null, ts: new Date().toISOString() },
  );
  expect(reconciled).toBeUndefined();
  expect((await store.getRun(old.id))?.phase).toBe("error");
  expect((await store.getRun(successor!.run.id))?.phase).toBe("running");
});
