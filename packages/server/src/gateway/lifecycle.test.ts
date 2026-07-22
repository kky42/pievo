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
  await (db.client as any).exec("DELETE FROM terminal_report_incidents; DELETE FROM run_report_receipts; DELETE FROM run_leases; DELETE FROM runs; DELETE FROM loops; DELETE FROM machines;");
});

function gateway(notify?: (loop: any, message: string) => Promise<void>) {
  return new gatewayMod.MachineGateway({
    advanceDueSchedules(): never[] { return []; }, enqueueInitialExec(): void {}, addLoop(): void {}, removeLoop(): void {}, runNow(): void {},
  } as any, undefined, notify);
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

test("pause leaves a running run and lease intact, preserving its queued owner follow-up", async () => {
  const machine = await seedMachine();
  const loop = await seedLoop(machine.id);
  const running = await store.addRun({ loopId: loop.id, userId: "u1", machineId: machine.id, phase: "running", role: "exec", ts: new Date().toISOString() });
  const token = await tokens.registerRunLease({ runId: running.id, loopId: loop.id, machineId: machine.id, role: "exec", allowControl: false });
  await store.enqueueRun(loop.id, { role: "edit", requestedBy: "owner", requestText: "later" });

  const paused = await store.pauseLoop(loop.id);
  const again = await store.pauseLoop(loop.id);

  expect(paused).toMatchObject({ enabled: false, pauseCause: { kind: "owner" } });
  expect(again).toMatchObject({ enabled: false, pauseCause: { kind: "owner" } });
  expect((await store.getRun(running.id))?.phase).toBe("running");
  expect((await tokens.resolveLease(token))?.state).toBe("active");
  expect(await store.claimReadyRunForMachine(machine.id)).toBeUndefined();
});

test("start clears an owner pause cause and completion clears pause annotations", async () => {
  const machine = await seedMachine();
  const loop = await seedLoop(machine.id);
  await store.pauseLoop(loop.id);
  expect((await store.getLoop(loop.id))?.pauseCause).toMatchObject({ kind: "owner" });
  await store.startLoop(loop.id);
  expect((await store.getLoop(loop.id))?.pauseCause).toBeNull();
  await store.updateLoop(loop.id, { goal: "done", completedAt: new Date().toISOString(), completionReason: "done" });
  expect(await store.getLoop(loop.id)).toMatchObject({ enabled: false, pauseCause: null });
});

test("paused loops claim owner work by role priority, stay paused after exec, and block system work", async () => {
  const machine = await seedMachine();
  const loop = await store.createLoop({
    userId: "u1", machineId: machine.id, name: "paused continuous", cron: "0 0 1 1 *",
    scheduleMode: "continuous", continuousDelayMinutes: 5, enabled: false,
  });
  await store.enqueueRun(loop.id, { role: "exec", requestedBy: "owner" });
  await store.enqueueRun(loop.id, { role: "evolve", requestedBy: "owner" });
  await store.enqueueRun(loop.id, { role: "edit", requestedBy: "owner", requestText: "owner edit" });

  const edit = await store.claimReadyRunForMachine(machine.id);
  expect(edit?.run).toMatchObject({ role: "edit", requestedBy: "owner" });
  await store.finalizeRunningRun(loop.id, edit!.run.id, { phase: "done", ts: new Date().toISOString() }, {}, tokens.sha256(edit!.runToken));
  const evolve = await store.claimReadyRunForMachine(machine.id);
  expect(evolve?.run.role).toBe("evolve");
  await store.finalizeRunningRun(loop.id, evolve!.run.id, { phase: "done", ts: new Date().toISOString() }, {}, tokens.sha256(evolve!.runToken));
  const exec = await store.claimReadyRunForMachine(machine.id);
  expect(exec?.run.role).toBe("exec");
  await store.finalizeRunningRun(loop.id, exec!.run.id, { phase: "done", ts: new Date().toISOString() }, {}, tokens.sha256(exec!.runToken));
  expect(await store.getLoop(loop.id)).toMatchObject({ enabled: false, nextCadenceAt: null, nextRunAt: null });

  const systemLoop = await seedLoop(machine.id, false);
  await store.addRun({ loopId: systemLoop.id, userId: "u1", machineId: machine.id, phase: "pending", role: "exec", requestedBy: "system", ts: new Date().toISOString() });
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

  expect(stopped?.loop).toMatchObject({ enabled: false, pauseCause: { kind: "owner" } });
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

test("report authentication precedes invalid handling; uncorrelatable ids stay nonterminal", async () => {
  const machine = await seedMachine();
  const loop = await seedLoop(machine.id);
  const run = await store.addRun({ loopId: loop.id, userId: "u1", machineId: machine.id, phase: "running", role: "exec", ts: new Date().toISOString() });
  const token = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId: machine.id, role: "exec", allowControl: false });
  const gw = gateway();

  expect((await gw.report("rk_forged", { reportId: "not-a-uuid", runId: run.id, result: "success" })).status).toBe(401);
  for (const body of [
    { runId: run.id, result: "success" },
    { reportId: 42, runId: run.id, result: "success" },
    { reportId: `x${"a".repeat(200)}`, runId: run.id, result: "success" },
    { reportId: "bad\0id", runId: run.id, result: "success" },
  ]) expect((await gw.report(token, body as any)).status).toBe(400);

  expect((await store.getRun(run.id))?.phase).toBe("running");
  expect((await tokens.resolveLease(token))?.state).toBe("active");
  expect(await store.countTerminalReportIncidents()).toBe(0);
});


test.each([
  ["missing runId", { result: "success" }, "runId is required"],
  ["mismatched runId", { runId: "another-run", result: "success" }, "runId does not match"],
  ["invalid result", { result: "bogus" }, "result must be"],
  ["invalid duration", { result: "success", durationMs: -1 }, "durationMs must be"],
  ["invalid exit code", { result: "success", exitCode: 1.5 }, "exitCode must be"],
] as const)("semantic invalid: %s is terminally acknowledged", async (_label, invalid, issue) => {
  const machine = await seedMachine(`m-${_label.replaceAll(" ", "-")}`);
  const loop = await seedLoop(machine.id);
  const run = await store.addRun({ loopId: loop.id, userId: "u1", machineId: machine.id, phase: "running", role: "exec", ts: new Date().toISOString() });
  const token = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId: machine.id, role: "exec", allowControl: false });
  const reportId = `018f47a2-9c2b-7d11-8f52-${tokens.sha256(_label).slice(0, 12)}`;
  const result = await gateway().report(token, { reportId, ...invalid } as any);
  expect(result).toMatchObject({ status: 200, body: { accepted: false, terminal: true, code: "REPORT_INVALID", disposition: "run-error" } });
  expect((result.body as any).issues.join(" ")).toContain(issue);
  expect((await store.getRun(run.id))?.phase).toBe("error");
  expect(await tokens.resolveLease(token)).toBeUndefined();
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
  expect(await gateway().report("rk_no-longer-needed", { ...payload, result: "different" } as any)).toEqual({ status: 200, body: { ok: true, reportId } });
});

test("a live lease cannot replay another run's receipt by lying about body.runId", async () => {
  const aMachine = await seedMachine("m-evidence-a");
  const bMachine = await seedMachine("m-evidence-b");
  const aLoop = await seedLoop(aMachine.id);
  const bLoop = await seedLoop(bMachine.id);
  const a = await store.addRun({ loopId: aLoop.id, userId: "u1", machineId: aMachine.id, phase: "running", role: "exec", ts: new Date().toISOString() });
  const b = await store.addRun({ loopId: bLoop.id, userId: "u1", machineId: bMachine.id, phase: "running", role: "exec", ts: new Date().toISOString() });
  const aToken = await tokens.registerRunLease({ runId: a.id, loopId: aLoop.id, machineId: aMachine.id, role: "exec", allowControl: false });
  const bToken = await tokens.registerRunLease({ runId: b.id, loopId: bLoop.id, machineId: bMachine.id, role: "exec", allowControl: false });
  const reportId = "018f47a2-9c2b-7d11-8f52-123456789b09";
  expect((await gateway().report(aToken, { reportId, runId: a.id, result: "success" })).status).toBe(200);

  const response = await gateway().report(bToken, { reportId, runId: a.id, result: "success" });
  expect(response).toMatchObject({ status: 200, body: { accepted: false, code: "REPORT_CONFLICT", disposition: "run-error" } });
  expect(await store.getRun(b.id)).toMatchObject({ phase: "error", reportIncident: { code: "REPORT_CONFLICT" } });
  expect(await tokens.resolveLease(bToken)).toBeUndefined();
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
  expect(conflict).toEqual(first);
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
  expect(responses.map((response) => response.status).sort()).toEqual([200, 200]);
  const conflict = responses.find((response) => (response.body as any).code === "REPORT_CONFLICT");
  expect(conflict).toMatchObject({ body: { accepted: false, terminal: true, disposition: "run-error" } });
  const finalRuns = await Promise.all([store.getRun(a.id), store.getRun(b.id)]);
  expect(finalRuns.filter((run) => run?.phase === "done")).toHaveLength(1);
  expect(finalRuns.filter((run) => run?.phase === "error" && run.reportIncident?.code === "REPORT_CONFLICT")).toHaveLength(1);
  expect(await store.countReportReceipts()).toBe(1);
  expect(await store.countTerminalReportIncidents()).toBe(1);
  expect(await tokens.resolveLease(aToken)).toBeUndefined();
  expect(await tokens.resolveLease(bToken)).toBeUndefined();
});

test("semantic-invalid terminal-grace telemetry preserves the completed result", async () => {
  const machine = await seedMachine();
  const loop = await store.createLoop({ userId: "u1", machineId: machine.id, name: "closed", cron: "0 0 1 1 *", goal: "done", enabled: true });
  const run = await store.addRun({ loopId: loop.id, userId: "u1", machineId: machine.id, phase: "running", role: "exec", ts: new Date().toISOString() });
  const token = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId: machine.id, role: "exec", allowControl: false, canFinish: true });
  const finished = await store.finishLoopRun(loop.id, run.id, tokens.sha256(token), { ts: new Date().toISOString(), reason: "goal met" });
  expect(finished.state).toBe("finished");
  const completedAt = (await store.getLoop(loop.id))!.completedAt;

  const result = await gateway().report(token, {
    reportId: "018f47a2-9c2b-7d11-8f52-123456789b01",
    runId: run.id,
    result: "success",
    durationMs: -1,
  });
  expect(result).toMatchObject({ status: 200, body: { accepted: false, disposition: "telemetry-rejected" } });
  expect(await store.getRun(run.id)).toMatchObject({ phase: "done", reportIncident: { code: "REPORT_INVALID" } });
  expect((await store.getLoop(loop.id))?.completedAt).toBe(completedAt);
  expect((await store.getLoop(loop.id))?.completionReason).toBe("goal met");
  expect(await tokens.resolveLease(token)).toBeUndefined();
});

test("invalid terminal-grace telemetry preserves a canceled result", async () => {
  const machine = await seedMachine("m-canceled-telemetry");
  const loop = await seedLoop(machine.id);
  const run = await store.addRun({ loopId: loop.id, userId: "u1", machineId: machine.id, phase: "canceled", role: "exec", ts: new Date().toISOString() });
  const token = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId: machine.id, role: "exec", allowControl: false });
  await tokens.terminalizeLease(run.id);

  const response = await gateway().report(token, {
    reportId: "018f47a2-9c2b-7d11-8f52-123456789b11",
    runId: run.id,
    result: "success",
    durationMs: -1,
  });
  expect(response).toMatchObject({ status: 200, body: { accepted: false, disposition: "telemetry-rejected" } });
  expect(await store.getRun(run.id)).toMatchObject({ phase: "canceled", reportIncident: { code: "REPORT_INVALID" } });
  expect(await tokens.resolveLease(token)).toBeUndefined();
});

test("invalid exec participates in streak/autopause, preserves owner queue, and notifies only on first handling", async () => {
  const machine = await seedMachine();
  const loop = await seedLoop(machine.id);
  const base = Date.now() - 60_000;
  for (let i = 0; i < 2; i++) await store.addRun({
    loopId: loop.id, userId: "u1", machineId: machine.id, phase: "error", role: "exec", ts: new Date(base + i).toISOString(),
  });
  const run = await store.addRun({ loopId: loop.id, userId: "u1", machineId: machine.id, phase: "running", role: "exec", ts: new Date().toISOString() });
  await store.enqueueRun(loop.id, { role: "exec", requestedBy: "system" });
  await store.enqueueRun(loop.id, { role: "edit", requestedBy: "owner", requestText: "keep me" });
  const token = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId: machine.id, role: "exec", allowControl: false });
  const sent: string[] = [];
  const gw = gateway(async (_loop, message) => { sent.push(message); });
  const payload = { reportId: "018f47a2-9c2b-7d11-8f52-123456789b02", runId: run.id, result: "bogus" as any };

  const first = await gw.report(token, payload);
  await Promise.resolve();
  expect(first.status).toBe(200);
  expect(await store.getLoop(loop.id)).toMatchObject({ enabled: false, pauseCause: { kind: "failure-streak", runId: run.id, count: 3 } });
  await store.updateLoop(loop.id, { enabled: false });
  expect(await store.getLoop(loop.id)).toMatchObject({ pauseCause: { kind: "failure-streak", runId: run.id, count: 3 } });
  const queued = await store.openRunsForLoop(loop.id);
  expect(queued.find((item) => item.role === "exec")).toBeUndefined();
  expect(queued.find((item) => item.role === "edit" && item.requestedBy === "owner")).toBeTruthy();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatch(/paused automatically/i);

  expect(await gw.report(token, payload)).toEqual(first);
  await Promise.resolve();
  expect(sent).toHaveLength(1);
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

test("a retired lease with a foreign reportId gets a stable incident ACK", async () => {
  const aMachine = await seedMachine("m-retired-conflict-a");
  const bMachine = await seedMachine("m-retired-conflict-b");
  const aLoop = await seedLoop(aMachine.id);
  const bLoop = await seedLoop(bMachine.id);
  const a = await store.addRun({ loopId: aLoop.id, userId: "u1", machineId: aMachine.id, phase: "running", role: "exec", ts: new Date().toISOString() });
  const b = await store.addRun({ loopId: bLoop.id, userId: "u1", machineId: bMachine.id, phase: "running", role: "exec", ts: new Date().toISOString() });
  const aToken = await tokens.registerRunLease({ runId: a.id, loopId: aLoop.id, machineId: aMachine.id, role: "exec", allowControl: false });
  const bToken = await tokens.registerRunLease({ runId: b.id, loopId: bLoop.id, machineId: bMachine.id, role: "exec", allowControl: false });
  const reportId = "018f47a2-9c2b-7d11-8f52-123456789b10";
  expect((await gateway().report(aToken, { reportId, runId: a.id, result: "success" })).status).toBe(200);
  expect(await store.forceDeleteLoop(bLoop.id)).toBe(true);
  const payload = { reportId, runId: b.id, result: "success" as const };

  const first = await gateway().report(bToken, payload);
  expect(first).toMatchObject({ status: 200, body: { accepted: false, code: "REPORT_CONFLICT", disposition: "telemetry-rejected" } });
  expect(await tokens.resolveLease(bToken)).toBeUndefined();
  expect(await gateway().report(bToken, payload)).toEqual(first);
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
