import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";

import type { Loop, Run, RunRole } from "../db/schema.js";

let tmp: string;
let db: typeof import("../db/index.js");
let store: typeof import("../db/store.js");
let sched: typeof import("./index.js");
let tokens: typeof import("../gateway/tokens.js");

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-schedule-facts-"));
  process.env.PIEVO_DATA_DIR = tmp;
  process.env.PIEVO_DB_PATH = path.join(tmp, "test.db");
  process.env.PIEVO_LOG_LEVEL = "silent";
  db = await import("../db/index.js");
  await db.runMigrations();
  store = await import("../db/store.js");
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
    goal: string | null;
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
  return store.createLoop({
    userId: "u1",
    machineId: machine.id,
    name: suffix,
    cron: "*/5 * * * *",
    enabled: true,
    notify: "auto",
    ...patch,
  });
}

function scheduler() {
  return new sched.Scheduler({ dispatch(): void {} });
}

async function pending(loopId: string, role?: RunRole): Promise<Run[]> {
  return (await store.openRunsForLoop(loopId)).filter((r) => r.phase === "pending" && (!role || r.role === role));
}

async function claim(loop: Loop) {
  const claimed = await store.claimReadyRunForMachine(loop.machineId);
  if (!claimed) throw new Error("expected claim");
  return claimed;
}

test("queue authority only promotes and latest owner edit wins", async () => {
  const loop = await makeLoop("authority");
  const system = await store.enqueueRun(loop.id, { role: "edit", requestedBy: "system", requestText: "system" });
  const owner = await store.enqueueRun(loop.id, { role: "edit", requestedBy: "owner", requestText: "owner A" });
  const weaker = await store.enqueueRun(loop.id, { role: "edit", requestedBy: "system", requestText: "ignored" });
  const latest = await store.enqueueRun(loop.id, { role: "edit", requestedBy: "owner", requestText: "owner B" });

  expect("run" in system && "run" in owner && owner.run.id).toBe("run" in system ? system.run.id : "");
  expect("run" in weaker && weaker.run).toMatchObject({ requestedBy: "owner", requestText: "owner A" });
  expect("run" in latest && latest.run).toMatchObject({ requestedBy: "owner", requestText: "owner B" });
  expect(await pending(loop.id, "edit")).toHaveLength(1);
});

test("a running role may retain one coalesced follow-up", async () => {
  const loop = await makeLoop("follow-up");
  await scheduler().requestEdit(loop.id, "A");
  const first = await claim(loop);
  expect(first.run.requestText).toBe("A");

  const b = await scheduler().requestEdit(loop.id, "B");
  const c = await scheduler().requestEdit(loop.id, "C");
  expect("run" in b && "run" in c && c.run.id).toBe("run" in b ? b.run.id : "");
  expect((await pending(loop.id, "edit"))[0]).toMatchObject({ requestedBy: "owner", requestText: "C" });
});

test("cross-role claims are edit > evolve > exec and claim inserts the lease atomically", async () => {
  const loop = await makeLoop("priority");
  await store.enqueueRun(loop.id, { role: "exec", requestedBy: "system" });
  await store.enqueueRun(loop.id, { role: "evolve", requestedBy: "owner" });
  await store.enqueueRun(loop.id, { role: "edit", requestedBy: "owner", requestText: "fix" });

  const roles: RunRole[] = [];
  for (let i = 0; i < 3; i++) {
    const item = await claim(loop);
    roles.push(item.run.role);
    expect((await tokens.resolveLease(item.runToken))?.runId).toBe(item.run.id);
    expect(await store.claimReadyRunForMachine(loop.machineId)).toBeUndefined();
    await store.updateRun(item.run.id, { phase: "canceled" });
    await tokens.retireLease(item.runToken);
  }
  expect(roles).toEqual(["edit", "evolve", "exec"]);
});

test("claim and cancel race cannot leave a canceled run with a live lease", async () => {
  const loop = await makeLoop("claim-cancel");
  const queued = await store.enqueueRun(loop.id, { role: "exec", requestedBy: "owner" });
  if (!("run" in queued)) throw new Error("expected run");

  const [claimed, canceled] = await Promise.all([
    store.claimReadyRunForMachine(loop.machineId),
    store.cancelRun(loop.id, queued.run.id),
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
  expect(await pending(loop.id, "exec")).toHaveLength(1);
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
  const [run] = await pending(loop.id, "exec");
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
  expect(await pending(loop.id, "exec")).toHaveLength(1);
});

test("edit/evolve claims and terminals never move continuous exec cadence", async () => {
  for (const role of ["edit", "evolve"] as const) {
    const loop = await makeLoop(`structural-${role}`, { scheduleMode: "continuous", continuousDelayMinutes: 7 });
    const cadence = (await store.getLoop(loop.id))!.nextCadenceAt;
    await store.enqueueRun(loop.id, {
      role,
      requestedBy: "owner",
      ...(role === "edit" ? { requestText: "keep cadence" } : {}),
    });
    const item = await claim(loop);
    expect(item.run.role).toBe(role);
    expect((await store.getLoop(loop.id))!.nextCadenceAt).toBe(cadence);
    const terminal = await store.finalizeRunningRun(
      loop.id,
      item.run.id,
      { phase: "done", ts: new Date().toISOString() },
      {},
      tokens.sha256(item.runToken),
    );
    expect(terminal?.loop.nextCadenceAt).toBe(cadence);
  }
});

test("canceled exec does not restart continuous cadence", async () => {
  const loop = await makeLoop("cancel-chain", { scheduleMode: "continuous" });
  await store.enqueueRun(loop.id, { role: "exec", requestedBy: "owner" });
  const item = await claim(loop);
  expect((await store.getLoop(loop.id))!.nextCadenceAt).toBeNull();
  await store.cancelRun(loop.id, item.run.id);
  expect((await store.getLoop(loop.id))!.nextCadenceAt).toBeNull();
});

test("mode switches change only cadence facts and never cancel pending rows", async () => {
  const loop = await makeLoop("switch");
  await store.enqueueRun(loop.id, { role: "exec", requestedBy: "system" });
  await store.enqueueRun(loop.id, { role: "edit", requestedBy: "owner", requestText: "keep" });

  const continuous = await store.updateLoop(loop.id, { scheduleMode: "continuous" });
  expect(continuous!.nextCadenceAt).toBeNull(); // open exec exists
  expect(await pending(loop.id)).toHaveLength(2);
  const cron = await store.updateLoop(loop.id, { scheduleMode: "cron" });
  expect(Date.parse(cron!.nextCadenceAt!)).toBeGreaterThan(Date.now());
  expect(await pending(loop.id)).toHaveLength(2);
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

test("pause clears both facts, cancels system rows, and preserves owner rows", async () => {
  const loop = await makeLoop("pause");
  await store.enqueueRun(loop.id, { role: "exec", requestedBy: "system" });
  await store.enqueueRun(loop.id, { role: "evolve", requestedBy: "owner" });
  await store.enqueueRun(loop.id, { role: "edit", requestedBy: "owner", requestText: "keep" });
  await store.updateLoop(loop.id, { nextRunAt: new Date(Date.now() + 60_000).toISOString() });

  const paused = await store.updateLoop(loop.id, { enabled: false });
  expect(paused).toMatchObject({ nextCadenceAt: null, nextRunAt: null });
  expect((await store.updateLoop(loop.id, { nextRunAt: new Date(Date.now() + 60_000).toISOString() }))!.nextRunAt).toBeNull();
  expect((await pending(loop.id)).map((r) => [r.role, r.requestedBy]).sort()).toEqual([
    ["edit", "owner"],
    ["evolve", "owner"],
  ]);
});

test("completion preserves only pending owner edit", async () => {
  const loop = await makeLoop("complete", { goal: "ship" });
  await store.enqueueRun(loop.id, { role: "exec", requestedBy: "owner" });
  await store.enqueueRun(loop.id, { role: "evolve", requestedBy: "owner" });
  await store.enqueueRun(loop.id, { role: "edit", requestedBy: "owner", requestText: "reopen later" });
  const at = new Date().toISOString();
  const done = await store.updateLoop(loop.id, { enabled: false, completedAt: at, completionReason: "done" });

  expect(done).toMatchObject({ nextCadenceAt: null, nextRunAt: null });
  expect((await pending(loop.id)).map((r) => r.role)).toEqual(["edit"]);
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
  expect(await pending(loop.id, "exec")).toHaveLength(0);
});

test("coalescing mutates updatedAt but never the pending row's immutable createdAt", async () => {
  const loop = await makeLoop("age-anchor");
  const first = await store.enqueueRun(loop.id, { role: "exec", requestedBy: "system" });
  if (!("run" in first)) throw new Error("expected run");
  const createdAt = first.run.createdAt;
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await store.enqueueRun(loop.id, { role: "exec", requestedBy: "owner" });
  if (!("run" in second)) throw new Error("expected run");

  expect(second.run.createdAt).toBe(createdAt);
  expect(Date.parse(second.run.updatedAt)).toBeGreaterThan(Date.parse(createdAt));
});

test("exec terminal lifecycle requests auto-evolve as system work", async () => {
  const loop = await makeLoop("auto-evolve");
  const running = await store.addRun({
    loopId: loop.id,
    userId: loop.userId,
    machineId: loop.machineId,
    phase: "running",
    role: "exec",
    requestedBy: "system",
    ts: new Date().toISOString(),
  });
  await store.finalizeRunningRun(loop.id, running.id, { phase: "done", ts: new Date().toISOString() });
  expect((await pending(loop.id, "evolve"))[0]).toMatchObject({ requestedBy: "system" });
});

test("terminal failure auto-pauses and cancels system work in the terminal transaction", async () => {
  const loop = await makeLoop("atomic-breaker", { scheduleMode: "continuous", continuousDelayMinutes: 5 });
  const base = Date.now() - 10_000;
  for (let i = 0; i < 2; i++) {
    await store.addRun({
      loopId: loop.id, userId: loop.userId, machineId: loop.machineId,
      phase: "error", role: "exec", requestedBy: "system",
      ts: new Date(base + i).toISOString(),
    });
  }
  const running = await store.addRun({
    loopId: loop.id, userId: loop.userId, machineId: loop.machineId,
    phase: "running", role: "exec", requestedBy: "system", ts: new Date().toISOString(),
  });
  await store.enqueueRun(loop.id, { role: "exec", requestedBy: "system" });
  await store.enqueueRun(loop.id, { role: "evolve", requestedBy: "system" });

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

test("terminal-grace fences due cadence until one late reconcile retimes it", async () => {
  const loop = await makeLoop("late", { scheduleMode: "continuous", continuousDelayMinutes: 5 });
  const running = await store.addRun({
    loopId: loop.id,
    userId: loop.userId,
    machineId: loop.machineId,
    phase: "running",
    role: "exec",
    requestedBy: "system",
    ts: new Date(Date.now() - 30 * 60_000).toISOString(),
  });
  const token = await tokens.registerRunLease({ runId: running.id, loopId: loop.id, machineId: loop.machineId, role: "exec", allowControl: true });
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
  expect(await pending(loop.id, "exec")).toHaveLength(0);
});

test("expired terminal-grace cannot reconcile after a successor claim", async () => {
  const loop = await makeLoop("expired-late", { scheduleMode: "continuous" });
  const old = await store.addRun({
    loopId: loop.id, userId: loop.userId, machineId: loop.machineId,
    phase: "running", role: "exec", requestedBy: "system", ts: new Date(Date.now() - 60_000).toISOString(),
  });
  const token = await tokens.registerRunLease({ runId: old.id, loopId: loop.id, machineId: loop.machineId, role: "exec", allowControl: true });
  await store.reclaimRun(old.id, "running", "timeout", new Date(Date.now() - 2_000).toISOString(), 1);
  await store.enqueueRun(loop.id, { role: "exec", requestedBy: "owner" });
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

test("run schedule constraints validate effective current cadence under the mutation lock", async () => {
  const loop = await makeLoop("floor-lock", { scheduleMode: "continuous", continuousDelayMinutes: 2 });
  const running = await store.addRun({
    loopId: loop.id, userId: loop.userId, machineId: loop.machineId,
    phase: "running", role: "edit", requestedBy: "owner", ts: new Date().toISOString(),
  });
  const token = await tokens.registerRunLease({
    runId: running.id, loopId: loop.id, machineId: loop.machineId, role: "edit", allowControl: true,
  });
  const result = await store.mutateForActiveRun({
    loopId: loop.id,
    runId: running.id,
    leaseTokenHash: tokens.sha256(token),
    capability: "control",
    loopPatch: { scheduleMode: "continuous" },
    constraints: { minCadenceMinutes: 5 },
  });
  expect(result).toMatchObject({ state: "constraint-failed" });
  expect((await store.getLoop(loop.id))?.continuousDelayMinutes).toBe(2);

  const retainedCron = await store.mutateForActiveRun({
    loopId: loop.id,
    runId: running.id,
    leaseTokenHash: tokens.sha256(token),
    capability: "control",
    loopPatch: { cron: "*/2 * * * *" },
    constraints: { minCronMinutes: 5 },
  });
  expect(retainedCron).toMatchObject({ state: "constraint-failed" });

  // Simulate owner state changing after a run-side precheck: the locked effective
  // cron is authoritative, not whatever the gateway observed earlier.
  await store.updateLoop(loop.id, { scheduleMode: "cron", cron: "*/2 * * * *" });
  const staleCronCheck = await store.mutateForActiveRun({
    loopId: loop.id,
    runId: running.id,
    leaseTokenHash: tokens.sha256(token),
    capability: "control",
    loopPatch: { scheduleMode: "cron" },
    constraints: { minCadenceMinutes: 5 },
  });
  expect(staleCronCheck).toMatchObject({ state: "constraint-failed" });
});

test("run-authorized mutation rechecks active lease and running phase inside its transaction", async () => {
  const loop = await makeLoop("mutation-fence");
  const running = await store.addRun({
    loopId: loop.id, userId: loop.userId, machineId: loop.machineId,
    phase: "running", role: "edit", requestedBy: "owner", ts: new Date().toISOString(),
  });
  const token = await tokens.registerRunLease({
    runId: running.id, loopId: loop.id, machineId: loop.machineId, role: "edit",
    allowControl: true, canSetUi: true,
  });
  await store.reclaimRun(running.id, "running", "timeout");
  const stale = await store.mutateForActiveRun({
    loopId: loop.id,
    runId: running.id,
    leaseTokenHash: tokens.sha256(token),
    capability: "set-ui",
    loopPatch: { ui: "<p>stale</p>" },
  });
  expect(stale.state).toBe("invalid-lease");
  expect((await store.getLoop(loop.id))?.ui).toBeNull();
});
