import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { testStore, type TestStore } from "../../test/store.js";

let tmp: string;
let db: typeof import("../db/index.js");
let store: TestStore;
let tokens: typeof import("./tokens.js");
let gatewayMod: typeof import("./index.js");

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-lifecycle-"));
  process.env.PIEVO_DATA_DIR = tmp;
  process.env.PIEVO_LOG_LEVEL = "silent";
  db = await import("../db/index.js");
  await db.runMigrations();
  store = testStore(await import("../db/store.js"));
  tokens = await import("./tokens.js");
  gatewayMod = await import("./index.js");
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

beforeEach(async () => {
  await (db.client as any).exec("DELETE FROM terminal_report_incidents; DELETE FROM run_report_receipts; DELETE FROM run_leases; DELETE FROM runs; DELETE FROM loops; DELETE FROM machines;");
});

function gateway() {
  return new gatewayMod.MachineGateway({
    advanceDueSchedules(): never[] { return []; }, enqueueInitialExec(): void {}, addLoop(): void {}, removeLoop(): void {}, runNow(): void {},
  } as any);
}

test("machine terminal payload has one exact top-level allowlist", () => {
  expect(gatewayMod.MACHINE_REPORT_FIELDS).toEqual([
    "reportId", "runId", "result", "exitCode", "durationMs",
    "sessionId", "usage", "error", "finalText",
  ]);
});

async function seedMachine(id = "m-life") {
  return store.createMachine({ id, userId: "u1", name: id, tokenHash: id, online: true });
}

async function seedLoop(machineId: string, enabled = true) {
  return store.createLoop({ workdir: "/work", userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled });
}


test("pause leaves a running run and lease intact, preserving its queued owner follow-up", async () => {
  const machine = await seedMachine();
  const loop = await seedLoop(machine.id);
  const running = await store.addRun({ loopId: loop.id, machineId: machine.id, phase: "running", ts: new Date().toISOString() });
  const token = await tokens.registerRunLease({ runId: running.id, loopId: loop.id, machineId: machine.id });
  await store.enqueueRun(loop.id, { requestedBy: "owner" });

  const paused = await store.pauseLoop(loop.id);
  const again = await store.pauseLoop(loop.id);

  expect(paused).toMatchObject({ enabled: false, pauseCause: { kind: "owner" } });
  expect(again).toMatchObject({ enabled: false, pauseCause: { kind: "owner" } });
  expect((await store.getRun(running.id))?.phase).toBe("running");
  expect((await tokens.resolveLease(token))?.state).toBe("active");
  expect(await store.claimReadyRunForMachine(machine.id)).toBeUndefined();
});

test("start clears an owner pause cause", async () => {
  const machine = await seedMachine();
  const loop = await seedLoop(machine.id);
  await store.pauseLoop(loop.id);
  expect((await store.getLoop(loop.id))?.pauseCause).toMatchObject({ kind: "owner" });
  await store.startLoop(loop.id);
  expect((await store.getLoop(loop.id))?.pauseCause).toBeNull();
});


test("stop atomically pauses, clears facts, cancels all pending work, and only requests running cancellation", async () => {
  const machine = await seedMachine();
  const loop = await seedLoop(machine.id);
  await store.updateLoop(loop.id, { nextRunAt: "2030-01-01T00:00:00.000Z" });
  const running = await store.addRun({ loopId: loop.id, machineId: machine.id, phase: "running", ts: new Date().toISOString() });
  const token = await tokens.registerRunLease({ runId: running.id, loopId: loop.id, machineId: machine.id });
  await store.enqueueRun(loop.id, { requestedBy: "owner" });
  await store.enqueueRun(loop.id, { requestedBy: "system" });

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
  const pending = await store.addRun({ loopId: loop.id, machineId: machine.id, phase: "pending", requestedBy: "owner", ts: new Date().toISOString() });
  expect((await store.requestRunCancel(loop.id, pending.id))?.phase).toBe("canceled");

  const running = await store.addRun({ loopId: loop.id, machineId: machine.id, phase: "running", ts: new Date().toISOString() });
  const token = await tokens.registerRunLease({ runId: running.id, loopId: loop.id, machineId: machine.id });
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
  const running = await store.addRun({ loopId: loop.id, machineId: machine.id, phase: "running", ts: new Date().toISOString() });
  const token = await tokens.registerRunLease({ runId: running.id, loopId: loop.id, machineId: machine.id });

  const requested = await store.requestDeleteLoop(loop.id);
  const repeated = await store.requestDeleteLoop(loop.id);
  expect(requested?.loop.deleteRequestedAt).toBeTruthy();
  expect(repeated?.loop.deleteRequestedAt).toBe(requested?.loop.deleteRequestedAt);
  expect(await store.tryDeleteLoop(loop.id)).toBe(false);
  expect(await store.forceDeleteLoop(loop.id)).toBe(true);
  expect(await store.getLoop(loop.id)).toBeUndefined();
  expect((await tokens.resolveLease(token))?.state).toBe("retired");
});

test("protocol v4 rejects old protocols and repeats per-run cancellation", async () => {
  const deviceToken = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(deviceToken);
  await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(deviceToken), online: true });
  const loop = await seedLoop(machineId);
  const run = await store.addRun({ loopId: loop.id, machineId, phase: "running", ts: new Date().toISOString() });
  await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId });
  await store.requestRunCancel(loop.id, run.id);
  const gw = gateway();

  expect((await gw.pollV4(deviceToken, { protocolVersion: 2, currentRuns: [] })).status).toBe(426);
  expect((await store.getMachine(machineId))?.daemonProtocol).toBe(2);
  const first = await gw.pollV4(deviceToken, { protocolVersion: 4, daemonInstanceId: "test-daemon", recoveryComplete: true, currentRuns: [{ runId: run.id, stage: "executing" }] });
  const second = await gw.pollV4(deviceToken, { protocolVersion: 4, daemonInstanceId: "test-daemon", recoveryComplete: true, currentRuns: [{ runId: run.id, stage: "reporting" }] });
  expect(first.body).toMatchObject({ delivery: null, cancelRunIds: [run.id] });
  expect(second.body).toMatchObject({ delivery: null, cancelRunIds: [run.id] });
});


test("a complete recovery snapshot keeps a reclaimed run blocking while it is executing or reporting", async () => {
  for (const stage of ["executing", "reporting"] as const) {
    const deviceToken = tokens.mintDeviceToken();
    const machineId = tokens.machineIdFromToken(deviceToken);
    await store.createMachine({ id: machineId, userId: "u1", name: stage, tokenHash: tokens.sha256(deviceToken), online: true });
    const loop = await seedLoop(machineId);
    const interrupted = await store.addRun({ loopId: loop.id, machineId, phase: "running", ts: new Date().toISOString() });
    const runToken = await tokens.registerRunLease({ runId: interrupted.id, loopId: loop.id, machineId });
    await store.reclaimRun(interrupted.id, "running", "machine timed out / disconnected");
    await store.enqueueRun(loop.id, { requestedBy: "owner" });

    const result = await gateway().pollV4(deviceToken, {
      protocolVersion: 4, daemonInstanceId: `daemon-${stage}`, recoveryComplete: true,
      currentRuns: [{ runId: interrupted.id, stage }], info: { version: "2.4.0" },
    });
    expect((result.body as any).delivery).toBeNull();
    expect((await tokens.resolveLease(runToken))?.state).toBe("terminal-grace");
  }
});

test("protocol v4 skips a local run's loop and returns one delivery per poll", async () => {
  const deviceToken = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(deviceToken);
  await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(deviceToken), online: true });
  const occupiedLoop = await seedLoop(machineId);
  const freeLoop = await seedLoop(machineId);
  const older = await store.addRun({
    loopId: occupiedLoop.id, machineId, phase: "error",
    ts: new Date().toISOString(), error: "server already reclaimed this run",
  });
  await store.enqueueRun(occupiedLoop.id, { requestedBy: "owner" });
  await store.enqueueRun(freeLoop.id, { requestedBy: "owner" });

  const result = await gateway().pollV4(deviceToken, {
    protocolVersion: 4,
    daemonInstanceId: "test-daemon",
    recoveryComplete: true,
    currentRuns: [{ runId: older.id, stage: "executing" }],
    info: { version: "2.4.0" },
  });
  expect((result.body as any).delivery.loop.id).toBe(freeLoop.id);
  expect((await store.listRuns(occupiedLoop.id)).some((run) => run.phase === "pending")).toBe(true);
});

test("repeated v4 polls accumulate cross-loop concurrency and target cancellations", async () => {
  const deviceToken = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(deviceToken);
  await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(deviceToken), online: true });
  const a = await seedLoop(machineId);
  const b = await seedLoop(machineId);
  await store.enqueueRun(a.id, { requestedBy: "owner" });
  await store.enqueueRun(b.id, { requestedBy: "owner" });
  const gw = gateway();

  const first = (await gw.pollV4(deviceToken, { protocolVersion: 4, daemonInstanceId: "test-daemon", recoveryComplete: true, currentRuns: [], info: { version: "2.4.0" } }).then((r) => (r.body as any).delivery));
  const second = (await gw.pollV4(deviceToken, {
    protocolVersion: 4,
    daemonInstanceId: "test-daemon",
    recoveryComplete: true,
    currentRuns: [{ runId: first.runId, stage: "executing" }],
    info: { version: "2.4.0" },
  }).then((r) => (r.body as any).delivery));
  expect(new Set([first.loop.id, second.loop.id])).toEqual(new Set([a.id, b.id]));

  for (const delivery of [first, second]) await store.requestRunCancel(delivery.loop.id, delivery.runId);
  const polled = await gw.pollV4(deviceToken, {
    protocolVersion: 4,
    daemonInstanceId: "test-daemon",
    recoveryComplete: true,
    currentRuns: [first, second].map((delivery) => ({ runId: delivery.runId, stage: "executing" as const })),
    info: { version: "2.4.0" },
  });
  expect(new Set((polled.body as any).cancelRunIds)).toEqual(new Set([first.runId, second.runId]));
  expect((polled.body as any).delivery).toBeNull();
});

test("an active v4 poll never enters the idle long-poll", async () => {
  const deviceToken = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(deviceToken);
  await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(deviceToken), online: true });
  const result = await Promise.race([
    gateway().pollV4Wait(deviceToken, {
      protocolVersion: 4,
      daemonInstanceId: "test-daemon",
      recoveryComplete: true,
      currentRuns: [{ runId: "local-run", stage: "executing" }],
      info: { version: "2.4.0" },
    }, 1_000).then(() => "returned"),
    new Promise<string>((resolve) => setTimeout(() => resolve("parked"), 100)),
  ]);
  expect(result).toBe("returned");
});

test("report authentication precedes invalid handling; uncorrelatable ids stay nonterminal", async () => {
  const machine = await seedMachine();
  const loop = await seedLoop(machine.id);
  const run = await store.addRun({ loopId: loop.id, machineId: machine.id, phase: "running", ts: new Date().toISOString() });
  const token = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId: machine.id });
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
  ["missing result", { runId: "filled-below", ok: true }, "result must be"],
  ["invalid duration", { result: "success", durationMs: -1 }, "durationMs must be"],
  ["invalid exit code", { result: "success", exitCode: 1.5 }, "exitCode must be"],
  ["invalid session id type", { result: "success", sessionId: 42 }, "sessionId must be a string"],
  ["invalid final text type", { result: "success", finalText: null }, "finalText must be a string"],
  ["invalid error type", { result: "failure", error: { message: "boom" } }, "error must be a string"],
  ["usage null", { result: "success", usage: null }, "usage must be an object"],
  ["usage array", { result: "success", usage: [] }, "usage must be an object"],
  ["fractional usage", { result: "success", usage: { inputTokens: 1.5 } }, "usage.inputTokens must be a non-negative integer"],
  ["negative usage", { result: "success", usage: { outputTokens: -1 } }, "usage.outputTokens must be a non-negative integer"],
  ["non-finite usage", { result: "success", usage: { cacheReadTokens: Number.POSITIVE_INFINITY } }, "usage.cacheReadTokens must be a non-negative integer"],
  ["excessive usage", { result: "success", usage: { cacheCreationTokens: 1_000_000_000_001 } }, "usage.cacheCreationTokens must be a non-negative integer"],
  ["unknown top-level fields", { runId: "filled-below", result: "success", metrics: {}, control: {} }, "unknown fields: control, metrics"],
  ["unknown usage field", { runId: "filled-below", result: "success", usage: { inputTokens: 1, costUsd: 2 } }, "unknown usage fields: costUsd"],
] as const)("semantic invalid: %s is terminally acknowledged", async (_label, invalid, issue) => {
  const machine = await seedMachine(`m-${_label.replaceAll(" ", "-")}`);
  const loop = await seedLoop(machine.id);
  const run = await store.addRun({ loopId: loop.id, machineId: machine.id, phase: "running", ts: new Date().toISOString() });
  const token = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId: machine.id });
  const reportId = `018f47a2-9c2b-7d11-8f52-${tokens.sha256(_label).slice(0, 12)}`;
  const result = await gateway().report(token, { reportId, ...invalid } as any);
  expect(result).toMatchObject({ status: 200, body: { accepted: false, terminal: true, code: "REPORT_INVALID", disposition: "run-error" } });
  expect((result.body as any).issues.join(" ")).toContain(issue);
  expect((await store.getRun(run.id))?.phase).toBe("error");
  expect(await tokens.resolveLease(token)).toBeUndefined();
});

test("a committed receipt remains authoritative before request validation", async () => {
  const reportId = "018f47a2-9c2b-7d11-8f52-123456789aaf";
  const runId = "already-finalized-run";
  const payload = { reportId, runId, result: "invalid-result" };
  const payloadDigest = tokens.sha256(JSON.stringify({ reportId, result: "invalid-result", runId }));
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
  const a = await store.addRun({ loopId: aLoop.id, machineId: aMachine.id, phase: "running", ts: new Date().toISOString() });
  const b = await store.addRun({ loopId: bLoop.id, machineId: bMachine.id, phase: "running", ts: new Date().toISOString() });
  const aToken = await tokens.registerRunLease({ runId: a.id, loopId: aLoop.id, machineId: aMachine.id });
  const bToken = await tokens.registerRunLease({ runId: b.id, loopId: bLoop.id, machineId: bMachine.id });
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
  const run = await store.addRun({ loopId: loop.id, machineId: machine.id, phase: "running", ts: new Date().toISOString() });
  const token = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId: machine.id });
  await store.updateRun(run.id, { status: "keep", message: "completed despite cancellation" });
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
  const a = await store.addRun({ loopId: aLoop.id, machineId: aMachine.id, phase: "running", ts: new Date().toISOString() });
  const b = await store.addRun({ loopId: bLoop.id, machineId: bMachine.id, phase: "running", ts: new Date().toISOString() });
  const aToken = await tokens.registerRunLease({ runId: a.id, loopId: aLoop.id, machineId: aMachine.id });
  const bToken = await tokens.registerRunLease({ runId: b.id, loopId: bLoop.id, machineId: bMachine.id });
  await store.updateRun(a.id, { status: "keep", message: "a complete" });
  await store.updateRun(b.id, { status: "keep", message: "b complete" });
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

test("invalid terminal-grace telemetry preserves a canceled result", async () => {
  const machine = await seedMachine("m-canceled-telemetry");
  const loop = await seedLoop(machine.id);
  const run = await store.addRun({ loopId: loop.id, machineId: machine.id, phase: "canceled", ts: new Date().toISOString() });
  const token = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId: machine.id });
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


test("delete completes after terminal report and leaves its durable receipt", async () => {
  const machine = await seedMachine();
  const loop = await seedLoop(machine.id);
  const run = await store.addRun({ loopId: loop.id, machineId: machine.id, phase: "running", ts: new Date().toISOString() });
  const token = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId: machine.id });
  await store.requestDeleteLoop(loop.id);
  const reportId = "018f47a2-9c2b-7d11-8f52-123456789abf";

  expect((await gateway().report(token, { reportId, runId: run.id, result: "success" })).status).toBe(200);
  expect(await store.getLoop(loop.id)).toBeUndefined();
  expect((await store.getReportReceipt(reportId))?.runId).toBe(run.id);
});

test("force-delete winning after report pre-resolution persists 410 and consumes retired lease", async () => {
  const machine = await seedMachine();
  const loop = await seedLoop(machine.id);
  const run = await store.addRun({ loopId: loop.id, machineId: machine.id, phase: "running", ts: new Date().toISOString() });
  const token = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId: machine.id });
  const realStore = await import("../db/store.js");
  const original = realStore.finalizeRunningRun;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => {
    vi.spyOn(realStore, "finalizeRunningRun").mockImplementationOnce(async (...args: Parameters<typeof original>) => {
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
  const a = await store.addRun({ loopId: aLoop.id, machineId: aMachine.id, phase: "running", ts: new Date().toISOString() });
  const b = await store.addRun({ loopId: bLoop.id, machineId: bMachine.id, phase: "running", ts: new Date().toISOString() });
  const aToken = await tokens.registerRunLease({ runId: a.id, loopId: aLoop.id, machineId: aMachine.id });
  const bToken = await tokens.registerRunLease({ runId: b.id, loopId: bLoop.id, machineId: bMachine.id });
  const reportId = "018f47a2-9c2b-7d11-8f52-123456789b10";
  expect((await gateway().report(aToken, { reportId, runId: a.id, result: "success" })).status).toBe(200);
  expect(await store.forceDeleteLoop(bLoop.id)).toBe(true);
  const payload = { reportId, runId: b.id, result: "success" as const };

  const first = await gateway().report(bToken, payload);
  expect(first).toMatchObject({ status: 200, body: { accepted: false, code: "REPORT_CONFLICT", disposition: "telemetry-rejected" } });
  expect(await tokens.resolveLease(bToken)).toBeUndefined();
  expect(await gateway().report(bToken, payload)).toEqual(first);
});

test("cancellation is terminal only when the daemon reports canceled", async () => {
  const machine = await seedMachine();
  const loop = await seedLoop(machine.id);
  const run = await store.addRun({ loopId: loop.id, machineId: machine.id, phase: "running", ts: new Date().toISOString() });
  const token = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId: machine.id });
  await store.requestRunCancel(loop.id, run.id);
  const res = await gateway().report(token, { reportId: "018f47a2-9c2b-7d11-8f52-123456789abd", runId: run.id, result: "canceled" });
  expect(res.status).toBe(200);
  expect((await store.getRun(run.id))?.phase).toBe("canceled");
});

test("continuous stop-run restores cadence while loop stop remains unscheduled", async () => {
  const machine = await seedMachine();
  const runOnlyLoop = await store.createLoop({ workdir: "/work", userId: "u1", machineId: machine.id, name: "run-only", cron: "0 0 1 1 *", scheduleMode: "continuous", continuousDelayMinutes: 5, enabled: true });
  const runOnly = await store.addRun({ loopId: runOnlyLoop.id, machineId: machine.id, phase: "running", ts: new Date().toISOString() });
  const runOnlyToken = await tokens.registerRunLease({ runId: runOnly.id, loopId: runOnlyLoop.id, machineId: machine.id });
  await store.requestRunCancel(runOnlyLoop.id, runOnly.id);
  await gateway().report(runOnlyToken, { reportId: "018f47a2-9c2b-7d11-8f52-123456789aa6", runId: runOnly.id, result: "canceled" });
  expect((await store.getLoop(runOnlyLoop.id))?.nextCadenceAt).toBeTruthy();

  const stoppedMachine = await seedMachine("m-continuous-stop");
  const stoppedLoop = await store.createLoop({ workdir: "/work", userId: "u1", machineId: stoppedMachine.id, name: "stopped", cron: "0 0 1 1 *", scheduleMode: "continuous", continuousDelayMinutes: 5, enabled: true });
  const stopped = await store.addRun({ loopId: stoppedLoop.id, machineId: stoppedMachine.id, phase: "running", ts: new Date().toISOString() });
  const stoppedToken = await tokens.registerRunLease({ runId: stopped.id, loopId: stoppedLoop.id, machineId: stoppedMachine.id });
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
  const run = await store.addRun({ loopId: retainedLoop.id, machineId: machine.id, phase: "running", ts: new Date().toISOString() });
  const token = await tokens.registerRunLease({ runId: run.id, loopId: retainedLoop.id, machineId: machine.id });
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
  const run = await store.addRun({ loopId: loop.id, machineId: machine.id, phase: "running", ts: new Date().toISOString() });
  const token = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId: machine.id });
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
