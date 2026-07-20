import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";

let tmp: string;
let db: typeof import("../db/index.js");
let store: typeof import("../db/store.js");
let tokens: typeof import("./tokens.js");
let gatewayMod: typeof import("./index.js");

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-lifecycle-"));
  process.env.PIEVO_DATA_DIR = tmp;
  process.env.PIEVO_LOG_LEVEL = "silent";
  db = await import("../db/index.js");
  await db.runMigrations();
  store = await import("../db/store.js");
  tokens = await import("./tokens.js");
  gatewayMod = await import("./index.js");
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

beforeEach(async () => {
  await (db.client as any).exec("DELETE FROM run_report_receipts; DELETE FROM run_leases; DELETE FROM runs; DELETE FROM loops; DELETE FROM machines;");
});

function gateway() {
  return new gatewayMod.MachineGateway({
    advanceDueSchedules(): never[] { return []; }, enqueueInitialExec(): void {}, addLoop(): void {}, removeLoop(): void {}, runNow(): void {},
  } as any);
}

async function seedMachine(id = "m-life") {
  return store.createMachine({ id, userId: "u1", name: id, tokenHash: id, online: true });
}

async function seedLoop(machineId: string, enabled = true) {
  return store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled });
}

test("a machine claims only one running run across loops", async () => {
  const machine = await seedMachine();
  const a = await seedLoop(machine.id);
  const b = await seedLoop(machine.id);
  await store.enqueueRun(a.id, { role: "exec", requestedBy: "owner" });
  await store.enqueueRun(b.id, { role: "edit", requestedBy: "owner", requestText: "edit" });

  const claims = await Promise.all([
    store.claimReadyRunForMachine(machine.id),
    store.claimReadyRunForMachine(machine.id),
  ]);

  expect(claims.filter(Boolean)).toHaveLength(1);
  await expect(store.addRun({ loopId: b.id, userId: "u1", machineId: machine.id, phase: "running", role: "exec", ts: new Date().toISOString() })).rejects.toThrow();
  const running = (await Promise.all([store.listRuns(a.id), store.listRuns(b.id)])).flat().filter((r) => r.phase === "running");
  expect(running).toHaveLength(1);
});

test("pause blocks every queued authority and leaves a running run and lease intact", async () => {
  const machine = await seedMachine();
  const loop = await seedLoop(machine.id);
  const running = await store.addRun({ loopId: loop.id, userId: "u1", machineId: machine.id, phase: "running", role: "exec", ts: new Date().toISOString() });
  const token = await tokens.registerRunLease({ runId: running.id, loopId: loop.id, machineId: machine.id, role: "exec", allowControl: false });
  await store.enqueueRun(loop.id, { role: "edit", requestedBy: "owner", requestText: "later" });

  const paused = await store.pauseLoop(loop.id);
  const again = await store.pauseLoop(loop.id);

  expect(paused?.enabled).toBe(false);
  expect(again?.enabled).toBe(false);
  expect((await store.getRun(running.id))?.phase).toBe("running");
  expect((await tokens.resolveLease(token))?.state).toBe("active");
  expect(await store.claimReadyRunForMachine(machine.id)).toBeUndefined();
});

test("stop atomically pauses, clears facts, cancels all pending work, and only requests running cancellation", async () => {
  const machine = await seedMachine();
  const loop = await seedLoop(machine.id);
  await store.updateLoop(loop.id, { nextRunAt: "2030-01-01T00:00:00.000Z" });
  const running = await store.addRun({ loopId: loop.id, userId: "u1", machineId: machine.id, phase: "running", role: "exec", ts: new Date().toISOString() });
  const token = await tokens.registerRunLease({ runId: running.id, loopId: loop.id, machineId: machine.id, role: "exec", allowControl: false });
  await store.enqueueRun(loop.id, { role: "edit", requestedBy: "owner", requestText: "owner" });
  await store.enqueueRun(loop.id, { role: "evolve", requestedBy: "system" });

  const stopped = await store.stopLoop(loop.id);
  const repeated = await store.stopLoop(loop.id);
  const rows = await store.listRuns(loop.id);

  expect(stopped?.loop.enabled).toBe(false);
  expect(stopped?.loop.nextRunAt).toBeNull();
  expect(stopped?.loop.nextCadenceAt).toBeNull();
  expect(rows.filter((r) => r.phase === "pending")).toHaveLength(0);
  expect((await store.getRun(running.id))?.phase).toBe("running");
  expect((await store.getRun(running.id))?.cancelRequestedAt).toBeTruthy();
  expect(repeated?.running?.cancelRequestedAt).toBe(stopped?.running?.cancelRequestedAt);
  expect((await tokens.resolveLease(token))?.state).toBe("active");
});

test("stop-run cancels pending immediately but only marks running and does not pause", async () => {
  const machine = await seedMachine();
  const loop = await seedLoop(machine.id);
  const pending = await store.addRun({ loopId: loop.id, userId: "u1", machineId: machine.id, phase: "pending", role: "edit", requestedBy: "owner", ts: new Date().toISOString() });
  expect((await store.requestRunCancel(loop.id, pending.id))?.phase).toBe("canceled");

  const running = await store.addRun({ loopId: loop.id, userId: "u1", machineId: machine.id, phase: "running", role: "exec", ts: new Date().toISOString() });
  const token = await tokens.registerRunLease({ runId: running.id, loopId: loop.id, machineId: machine.id, role: "exec", allowControl: false });
  const requested = await store.requestRunCancel(loop.id, running.id);
  const repeated = await store.requestRunCancel(loop.id, running.id);

  expect(requested?.phase).toBe("running");
  expect(requested?.cancelRequestedAt).toBeTruthy();
  expect(repeated?.cancelRequestedAt).toBe(requested?.cancelRequestedAt);
  expect((await store.getLoop(loop.id))?.enabled).toBe(true);
  expect((await tokens.resolveLease(token))?.state).toBe("active");
});

test("delete waits for execution authority and force delete retires it", async () => {
  const machine = await seedMachine();
  const loop = await seedLoop(machine.id);
  const running = await store.addRun({ loopId: loop.id, userId: "u1", machineId: machine.id, phase: "running", role: "exec", ts: new Date().toISOString() });
  const token = await tokens.registerRunLease({ runId: running.id, loopId: loop.id, machineId: machine.id, role: "exec", allowControl: false });

  const requested = await store.requestDeleteLoop(loop.id);
  const repeated = await store.requestDeleteLoop(loop.id);
  expect(requested?.loop.deleteRequestedAt).toBeTruthy();
  expect(repeated?.loop.deleteRequestedAt).toBe(requested?.loop.deleteRequestedAt);
  expect(await store.tryDeleteLoop(loop.id)).toBe(false);
  expect(await store.forceDeleteLoop(loop.id)).toBe(true);
  expect(await store.getLoop(loop.id)).toBeUndefined();
  expect((await tokens.resolveLease(token))?.state).toBe("retired");
});

test("protocol v2 is explicit, single-flight, and repeats cancellation", async () => {
  const deviceToken = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(deviceToken);
  await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(deviceToken), online: true });
  const loop = await seedLoop(machineId);
  const run = await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: new Date().toISOString() });
  await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId, role: "exec", allowControl: false });
  await store.requestRunCancel(loop.id, run.id);
  const gw = gateway();

  await store.updateMachine(machineId, { daemonProtocol: 2 });
  expect((await gw.pollV2(deviceToken, { protocolVersion: 1 })).status).toBe(426);
  expect((await store.getMachine(machineId))?.daemonProtocol).toBe(1);
  const first = await gw.pollV2(deviceToken, { protocolVersion: 2, currentRun: { runId: run.id, stage: "executing" } });
  const second = await gw.pollV2(deviceToken, { protocolVersion: 2, currentRun: { runId: run.id, stage: "reporting" } });
  expect(first.body).toMatchObject({ delivery: null, cancelRunId: run.id });
  expect(second.body).toMatchObject({ delivery: null, cancelRunId: run.id });
  const conflict = await gw.pollV2(deviceToken, { protocolVersion: 2, currentRun: { runId: "daemon-run-a", stage: "executing" } });
  expect(conflict.body).toMatchObject({ delivery: null, runConflict: { daemonRunId: "daemon-run-a", serverRunId: run.id } });
  const blocked = await gw.pollV2(deviceToken, { protocolVersion: 2 });
  expect(blocked.body).toMatchObject({ delivery: null, blockedRunId: run.id });
});

test("protocol-v2 terminal reports require valid reportId and matching runId before mutation", async () => {
  const machine = await seedMachine();
  const loop = await seedLoop(machine.id);
  const run = await store.addRun({ loopId: loop.id, userId: "u1", machineId: machine.id, phase: "running", role: "exec", ts: new Date().toISOString() });
  const token = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId: machine.id, role: "exec", allowControl: false });
  const gw = gateway();

  expect((await gw.report(token, { runId: run.id, result: "success" })).status).toBe(400);
  expect(await gw.report(token, { reportId: "not-a-uuid", runId: run.id, result: "success" })).toMatchObject({ status: 422, body: { code: "REPORT_INVALID", reportId: "not-a-uuid" } });
  expect(await gw.report(token, { reportId: "018f47a2-9c2b-7d11-8f52-123456789aa1", result: "success" })).toMatchObject({ status: 422, body: { code: "REPORT_INVALID", reportId: "018f47a2-9c2b-7d11-8f52-123456789aa1" } });
  expect((await gw.report(token, { reportId: "018f47a2-9c2b-7d11-8f52-123456789aa2", runId: "other", result: "success" })).status).toBe(403);
  for (const [reportId, invalid] of [
    ["018f47a2-9c2b-7d11-8f52-123456789aa8", { result: "bogus" }],
    ["018f47a2-9c2b-7d11-8f52-123456789aa9", { result: "success", durationMs: -1 }],
    ["018f47a2-9c2b-7d11-8f52-123456789aaa", { result: "success", exitCode: 1.5 }],
  ] as const) {
    expect(await gw.report(token, { reportId, runId: run.id, ...invalid } as any)).toMatchObject({
      status: 422,
      body: { code: "REPORT_INVALID", reportId },
    });
  }
  expect((await store.getRun(run.id))?.phase).toBe("running");
  expect((await tokens.resolveLease(token))?.state).toBe("active");
  expect(await store.countReportReceipts()).toBe(0);
});

test("a committed receipt replays before newer semantic validation", async () => {
  const reportId = "018f47a2-9c2b-7d11-8f52-123456789aaf";
  const runId = "run-from-older-server";
  const payload = { reportId, runId, result: "legacy-result" };
  const payloadDigest = tokens.sha256(JSON.stringify({ reportId, result: "legacy-result", runId }));
  await store.insertReportReceipt({
    reportId,
    runId,
    payloadDigest,
    ackStatus: 200,
    ackBody: { ok: true, reportId },
    createdAt: new Date().toISOString(),
  });

  expect(await gateway().report("rk_no-longer-needed", payload as any)).toEqual({ status: 200, body: { ok: true, reportId } });
  expect(await gateway().report("rk_no-longer-needed", { ...payload, result: "different" } as any)).toMatchObject({ status: 409, body: { code: "REPORT_CONFLICT", reportId } });
});

test("terminal reports are idempotent, conflict-safe, and preserve actual post-cancel result", async () => {
  const machine = await seedMachine();
  const loop = await seedLoop(machine.id);
  const run = await store.addRun({ loopId: loop.id, userId: "u1", machineId: machine.id, phase: "running", role: "exec", ts: new Date().toISOString() });
  const token = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId: machine.id, role: "exec", allowControl: false });
  await store.requestRunCancel(loop.id, run.id);
  const reportId = "018f47a2-9c2b-7d11-8f52-123456789abc";
  const payload = { reportId, runId: run.id, result: "success" as const, durationMs: 12 };
  const gw = gateway();

  const first = await gw.report(token, payload);
  const duplicate = await gateway().report(token, payload);
  const conflict = await gw.report(token, { ...payload, result: "failure", error: "different" });

  expect(first.status).toBe(200);
  expect(duplicate).toEqual(first);
  expect(conflict).toMatchObject({ status: 409, body: { code: "REPORT_CONFLICT", reportId } });
  expect((await store.getRun(run.id))?.phase).toBe("done");
  expect(await store.countReportReceipts()).toBe(1);
});

test("same reportId is bound to runId and concurrent cross-loop reports finalize exactly one run", async () => {
  const aMachine = await seedMachine("m-report-a");
  const bMachine = await seedMachine("m-report-b");
  const aLoop = await seedLoop(aMachine.id);
  const bLoop = await seedLoop(bMachine.id);
  const a = await store.addRun({ loopId: aLoop.id, userId: "u1", machineId: aMachine.id, phase: "running", role: "exec", ts: new Date().toISOString() });
  const b = await store.addRun({ loopId: bLoop.id, userId: "u1", machineId: bMachine.id, phase: "running", role: "exec", ts: new Date().toISOString() });
  const aToken = await tokens.registerRunLease({ runId: a.id, loopId: aLoop.id, machineId: aMachine.id, role: "exec", allowControl: false });
  const bToken = await tokens.registerRunLease({ runId: b.id, loopId: bLoop.id, machineId: bMachine.id, role: "exec", allowControl: false });
  const reportId = "018f47a2-9c2b-7d11-8f52-123456789aa3";

  const settled = await Promise.allSettled([
    gateway().report(aToken, { reportId, runId: a.id, result: "success" }),
    gateway().report(bToken, { reportId, runId: b.id, result: "success" }),
  ]);
  expect(settled.every((result) => result.status === "fulfilled")).toBe(true);
  const responses = settled.map((result) => (result as PromiseFulfilledResult<any>).value);
  expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
  const finalRuns = await Promise.all([store.getRun(a.id), store.getRun(b.id)]);
  expect(finalRuns.filter((run) => run?.phase === "done")).toHaveLength(1);
  expect(finalRuns.filter((run) => run?.phase === "running")).toHaveLength(1);
  expect(await store.countReportReceipts()).toBe(1);
  const receipt = await store.getReportReceipt(reportId);
  expect([a.id, b.id]).toContain(receipt?.runId);
  const losingToken = receipt?.runId === a.id ? bToken : aToken;
  expect((await tokens.resolveLease(losingToken))?.state).toBe("active");
});

test("delete completes after terminal report and leaves its durable receipt", async () => {
  const machine = await seedMachine();
  const loop = await seedLoop(machine.id);
  const run = await store.addRun({ loopId: loop.id, userId: "u1", machineId: machine.id, phase: "running", role: "exec", ts: new Date().toISOString() });
  const token = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId: machine.id, role: "exec", allowControl: false });
  await store.requestDeleteLoop(loop.id);
  const reportId = "018f47a2-9c2b-7d11-8f52-123456789abf";

  expect((await gateway().report(token, { reportId, runId: run.id, result: "success" })).status).toBe(200);
  expect(await store.getLoop(loop.id)).toBeUndefined();
  expect((await store.getReportReceipt(reportId))?.runId).toBe(run.id);
});

test("finished-run enrichment completes a pending delete", async () => {
  const machine = await seedMachine();
  const loop = await seedLoop(machine.id);
  const run = await store.addRun({ loopId: loop.id, userId: "u1", machineId: machine.id, phase: "done", role: "exec", ts: new Date().toISOString() });
  const token = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId: machine.id, role: "exec", allowControl: false });
  await tokens.terminalizeLease(run.id);
  await store.requestDeleteLoop(loop.id);

  const response = await gateway().report(token, { reportId: "018f47a2-9c2b-7d11-8f52-123456789aa4", runId: run.id, result: "success", durationMs: 7 });
  expect(response.status).toBe(200);
  expect(await store.getLoop(loop.id)).toBeUndefined();
});

test("force-delete winning after report pre-resolution persists 410 and consumes retired lease", async () => {
  const machine = await seedMachine();
  const loop = await seedLoop(machine.id);
  const run = await store.addRun({ loopId: loop.id, userId: "u1", machineId: machine.id, phase: "running", role: "exec", ts: new Date().toISOString() });
  const token = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId: machine.id, role: "exec", allowControl: false });
  const original = store.finalizeRunningRun;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => {
    vi.spyOn(store, "finalizeRunningRun").mockImplementationOnce(async (...args: Parameters<typeof original>) => {
      resolve();
      await held;
      return original(...args);
    });
  });
  const reportId = "018f47a2-9c2b-7d11-8f52-123456789aa5";
  const reporting = gateway().report(token, { reportId, runId: run.id, result: "success" });
  await entered;
  await store.forceDeleteLoop(loop.id);
  release();

  const response = await reporting;
  expect(response).toMatchObject({ status: 410, body: { code: "RETIRED", reportId } });
  expect(await tokens.resolveLease(token)).toBeUndefined();
  expect((await store.getReportReceipt(reportId))?.ackStatus).toBe(410);
  vi.restoreAllMocks();
});

test("finish crash leaves bounded grace, then unblocks the machine and rejects late enrichment definitively", async () => {
  const machine = await seedMachine();
  const loop = await store.createLoop({ userId: "u1", machineId: machine.id, name: "closed", cron: "0 0 1 1 *", enabled: true, goal: "done" });
  const run = await store.addRun({ loopId: loop.id, userId: "u1", machineId: machine.id, phase: "running", role: "exec", ts: new Date().toISOString() });
  const token = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId: machine.id, role: "exec", allowControl: false, canFinish: true });
  const at = Date.now();
  expect((await store.finishLoopRun(loop.id, run.id, tokens.sha256(token), { ts: new Date(at).toISOString(), reason: "met" })).state).toBe("finished");
  expect((await tokens.resolveLease(token, at))?.state).toBe("terminal-grace");

  const other = await seedLoop(machine.id);
  const queued = await store.enqueueRun(other.id, { role: "exec", requestedBy: "owner" });
  expect(await store.claimReadyRunForMachine(machine.id)).toBeUndefined();
  await tokens.pruneExpiredLeases(at + store.FINISH_REPORT_GRACE_MS + 1);
  expect((await tokens.resolveLease(token))?.state).toBe("retired");
  expect((await store.claimReadyRunForMachine(machine.id))?.run.id).toBe("run" in queued ? queued.run.id : "missing");

  const reportId = "018f47a2-9c2b-7d11-8f52-123456789aab";
  expect(await gateway().report(token, { reportId, runId: run.id, result: "success", durationMs: 99 })).toMatchObject({ status: 410, body: { code: "RETIRED", reportId } });
  expect((await store.getRun(run.id))?.durationMs).not.toBe(99);
});

test("ordinary delete preserves expired finish authority until late report receives durable 410", async () => {
  const machine = await seedMachine();
  const loop = await store.createLoop({ userId: "u1", machineId: machine.id, name: "closed", cron: "0 0 1 1 *", enabled: true, goal: "done" });
  const run = await store.addRun({ loopId: loop.id, userId: "u1", machineId: machine.id, phase: "running", role: "exec", ts: new Date().toISOString() });
  const token = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId: machine.id, role: "exec", allowControl: false, canFinish: true });
  const at = Date.now();
  expect((await store.finishLoopRun(loop.id, run.id, tokens.sha256(token), { ts: new Date(at).toISOString(), reason: "met" })).state).toBe("finished");
  await store.requestDeleteLoop(loop.id);
  expect(await store.tryDeleteLoop(loop.id)).toBe(false);

  await tokens.pruneExpiredLeases(at + store.FINISH_REPORT_GRACE_MS + 1);
  expect((await tokens.resolveLease(token))?.state).toBe("retired");
  expect(await store.tryDeleteLoop(loop.id)).toBe(true);
  expect(await store.getLoop(loop.id)).toBeUndefined();
  expect((await tokens.resolveLease(token))?.state).toBe("retired");

  const reportId = "018f47a2-9c2b-7d11-8f52-123456789aac";
  const payload = { reportId, runId: run.id, result: "success" as const, durationMs: 99 };
  const first = await gateway().report(token, payload);
  expect(first).toMatchObject({ status: 410, body: { code: "RETIRED", reportId } });
  expect(await tokens.resolveLease(token)).toBeUndefined();
  expect((await store.getReportReceipt(reportId))?.ackStatus).toBe(410);
  expect(await gateway().report(token, payload)).toEqual(first);
});

test("ordinary delete and retired report remain definitive in both concurrent winner orders", async () => {
  async function seeded(suffix: string) {
    const machine = await seedMachine(`m-delete-race-${suffix}`);
    const loop = await store.createLoop({ userId: "u1", machineId: machine.id, name: "closed", cron: "0 0 1 1 *", enabled: true, goal: "done" });
    const run = await store.addRun({ loopId: loop.id, userId: "u1", machineId: machine.id, phase: "running", role: "exec", ts: new Date().toISOString() });
    const token = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId: machine.id, role: "exec", allowControl: false, canFinish: true });
    const at = Date.now();
    await store.finishLoopRun(loop.id, run.id, tokens.sha256(token), { ts: new Date(at).toISOString(), reason: "met" });
    await store.requestDeleteLoop(loop.id);
    await tokens.pruneExpiredLeases(at + store.FINISH_REPORT_GRACE_MS + 1);
    return { loop, run, token };
  }

  // Delete commits while report is paused immediately before its 410 transaction.
  const deleteFirst = await seeded("delete-first");
  const originalAck = store.acknowledgeRetiredReport;
  let releaseAck!: () => void;
  const ackHeld = new Promise<void>((resolve) => { releaseAck = resolve; });
  const ackEntered = new Promise<void>((resolve) => {
    vi.spyOn(store, "acknowledgeRetiredReport").mockImplementationOnce(async (...args: Parameters<typeof originalAck>) => {
      resolve();
      await ackHeld;
      return originalAck(...args);
    });
  });
  const reporting = gateway().report(deleteFirst.token, { reportId: "018f47a2-9c2b-7d11-8f52-123456789aad", runId: deleteFirst.run.id, result: "success" });
  await ackEntered;
  expect(await store.tryDeleteLoop(deleteFirst.loop.id)).toBe(true);
  releaseAck();
  expect((await reporting).status).toBe(410);
  vi.restoreAllMocks();

  // Report commits its receipt/consume while delete is paused before its txn.
  const reportFirst = await seeded("report-first");
  const originalDelete = store.tryDeleteLoop;
  let releaseDelete!: () => void;
  const deleteHeld = new Promise<void>((resolve) => { releaseDelete = resolve; });
  const deleteEntered = new Promise<void>((resolve) => {
    vi.spyOn(store, "tryDeleteLoop").mockImplementationOnce(async (...args: Parameters<typeof originalDelete>) => {
      resolve();
      await deleteHeld;
      return originalDelete(...args);
    });
  });
  const deleting = store.tryDeleteLoop(reportFirst.loop.id);
  await deleteEntered;
  const response = await gateway().report(reportFirst.token, { reportId: "018f47a2-9c2b-7d11-8f52-123456789aae", runId: reportFirst.run.id, result: "success" });
  expect(response.status).toBe(410);
  releaseDelete();
  expect(await deleting).toBe(true);
  expect(await store.getLoop(reportFirst.loop.id)).toBeUndefined();
  expect(await store.getReportReceipt("018f47a2-9c2b-7d11-8f52-123456789aae")).toBeDefined();
  vi.restoreAllMocks();
});

test("startup repair terminalizes terminal-run active leases idempotently", async () => {
  const machine = await seedMachine();
  const loop = await seedLoop(machine.id);
  const run = await store.addRun({ loopId: loop.id, userId: "u1", machineId: machine.id, phase: "done", role: "exec", ts: new Date().toISOString() });
  const token = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId: machine.id, role: "exec", allowControl: false });
  const at = Date.now();
  expect(await store.repairTerminalRunLeases(at)).toBe(1);
  const first = await tokens.resolveLease(token, at);
  expect(first?.state).toBe("terminal-grace");
  expect(first?.expiresAt).toBe(at + store.FINISH_REPORT_GRACE_MS);
  expect(await store.repairTerminalRunLeases(at + 1000)).toBe(0);
  expect((await tokens.resolveLease(token, at))?.expiresAt).toBe(first?.expiresAt);
});

test("cancellation is terminal only when the daemon reports canceled", async () => {
  const machine = await seedMachine();
  const loop = await seedLoop(machine.id);
  const run = await store.addRun({ loopId: loop.id, userId: "u1", machineId: machine.id, phase: "running", role: "exec", ts: new Date().toISOString() });
  const token = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId: machine.id, role: "exec", allowControl: false });
  await store.requestRunCancel(loop.id, run.id);
  const res = await gateway().report(token, { reportId: "018f47a2-9c2b-7d11-8f52-123456789abd", runId: run.id, result: "canceled" });
  expect(res.status).toBe(200);
  expect((await store.getRun(run.id))?.phase).toBe("canceled");
});

test("continuous stop-run restores cadence while loop stop remains unscheduled", async () => {
  const machine = await seedMachine();
  const runOnlyLoop = await store.createLoop({ userId: "u1", machineId: machine.id, name: "run-only", cron: "0 0 1 1 *", scheduleMode: "continuous", continuousDelayMinutes: 5, enabled: true });
  const runOnly = await store.addRun({ loopId: runOnlyLoop.id, userId: "u1", machineId: machine.id, phase: "running", role: "exec", ts: new Date().toISOString() });
  const runOnlyToken = await tokens.registerRunLease({ runId: runOnly.id, loopId: runOnlyLoop.id, machineId: machine.id, role: "exec", allowControl: false });
  await store.requestRunCancel(runOnlyLoop.id, runOnly.id);
  await gateway().report(runOnlyToken, { reportId: "018f47a2-9c2b-7d11-8f52-123456789aa6", runId: runOnly.id, result: "canceled" });
  expect((await store.getLoop(runOnlyLoop.id))?.nextCadenceAt).toBeTruthy();

  const stoppedMachine = await seedMachine("m-continuous-stop");
  const stoppedLoop = await store.createLoop({ userId: "u1", machineId: stoppedMachine.id, name: "stopped", cron: "0 0 1 1 *", scheduleMode: "continuous", continuousDelayMinutes: 5, enabled: true });
  const stopped = await store.addRun({ loopId: stoppedLoop.id, userId: "u1", machineId: stoppedMachine.id, phase: "running", role: "exec", ts: new Date().toISOString() });
  const stoppedToken = await tokens.registerRunLease({ runId: stopped.id, loopId: stoppedLoop.id, machineId: stoppedMachine.id, role: "exec", allowControl: false });
  await store.stopLoop(stoppedLoop.id);
  await gateway().report(stoppedToken, { reportId: "018f47a2-9c2b-7d11-8f52-123456789aa7", runId: stopped.id, result: "canceled" });
  expect(await store.getLoop(stoppedLoop.id)).toMatchObject({ enabled: false, nextCadenceAt: null });
});

test("restart-style sweep resumes delete while preserving durable receipts and retired authority", async () => {
  const machine = await seedMachine();
  const loop = await seedLoop(machine.id);
  await store.requestDeleteLoop(loop.id);
  expect(await store.getLoop(loop.id)).toBeDefined();
  const restarted = gateway();
  await restarted.sweep();
  expect(await store.getLoop(loop.id)).toBeUndefined();

  const retainedLoop = await seedLoop(machine.id);
  const run = await store.addRun({ loopId: retainedLoop.id, userId: "u1", machineId: machine.id, phase: "running", role: "exec", ts: new Date().toISOString() });
  const token = await tokens.registerRunLease({ runId: run.id, loopId: retainedLoop.id, machineId: machine.id, role: "exec", allowControl: false });
  await store.forceDeleteLoop(retainedLoop.id);
  await store.insertReportReceipt({ reportId: "old-report", runId: run.id, payloadDigest: "d", ackStatus: 200, ackBody: { ok: true }, createdAt: "2000-01-01T00:00:00.000Z" });
  await restarted.sweep();
  await restarted.sweep();
  expect((await tokens.resolveLease(token))?.state).toBe("retired");
  expect(await store.getReportReceipt("old-report")).toBeDefined();
});

test("a retired credential gets definitive 410 and maintenance cleanup is bounded and idempotent", async () => {
  const machine = await seedMachine();
  const loop = await seedLoop(machine.id);
  const run = await store.addRun({ loopId: loop.id, userId: "u1", machineId: machine.id, phase: "running", role: "exec", ts: new Date().toISOString() });
  const token = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId: machine.id, role: "exec", allowControl: false });
  await store.forceDeleteLoop(loop.id);
  const reportId = "018f47a2-9c2b-7d11-8f52-123456789abe";
  const payload = { reportId, runId: run.id, result: "success" as const };
  expect(await gateway().report(token, payload)).toMatchObject({ status: 410, body: { code: "RETIRED", reportId } });
  expect((await store.getReportReceipt(reportId))?.ackStatus).toBe(410);
  // The 410 transaction consumes the tombstone; a lost HTTP ACK still replays
  // from the durable receipt without recreating server authority/data.
  expect(await tokens.resolveLease(token)).toBeUndefined();
  expect(await gateway().report(token, payload)).toMatchObject({ status: 410, body: { code: "RETIRED", reportId } });
  expect(await store.getLoop(loop.id)).toBeUndefined();
});
