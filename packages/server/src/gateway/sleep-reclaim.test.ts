/**
 * Sleep/wake reclaim reconciliation (P0 correctness bug). Seeds the store the way
 * a laptop sleep would leave it — backdated `lastSeen` / `run.ts` / `heartbeatAt` —
 * then drives the REAL `gateway.sweep()` and `gateway.report()`. Models the
 * investigation's repro (report §3):
 *   (a) a running run reclaimed as timed-out, then a late SUCCESS wake-report →
 *       the run ends `done` with its message preserved and the false failure gone;
 *   (b) a pending run on an unreachable machine is DEFERRED (held claimable for
 *       catch-up), never failed and never alerted;
 *   (c) a long (>20min) run with a FRESH heartbeat survives the sweep.
 * Plus: a late FAILURE report records the real error honestly, and only ONE late
 * report is honored (single-shot).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";

let tmp: string;
let db: typeof import("../db/index.js");
let store: typeof import("../db/store.js");
let gatewayMod: typeof import("./index.js");
let cliMod: typeof import("./cli.js");
let tokens: typeof import("./tokens.js");
let schedulerMod: typeof import("../scheduler/index.js");

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-sleep-"));
  process.env.PIEVO_DATA_DIR = tmp;
  process.env.PIEVO_DB_PATH = path.join(tmp, "test.db");
  process.env.PIEVO_LOG_LEVEL = "silent";
  db = await import("../db/index.js");
  await db.runMigrations();
  store = await import("../db/store.js");
  gatewayMod = await import("./index.js");
  cliMod = await import("./cli.js");
  tokens = await import("./tokens.js");
  schedulerMod = await import("../scheduler/index.js");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  await (db.client as any).exec("DELETE FROM run_leases; DELETE FROM connect_keys; DELETE FROM runs; DELETE FROM loops; DELETE FROM machines;");
});

/** A recording notifier: captures every push instead of hitting a channel. */
function recordingNotify() {
  const sent: Array<{ loopId: string; message: string }> = [];
  const fn = (loop: any, message: string): Promise<void> => {
    sent.push({ loopId: loop.id, message });
    return Promise.resolve();
  };
  return { sent, fn };
}

function gateway(notify?: (loop: any, message: string) => Promise<void>, scheduler?: any) {
  const gw = new gatewayMod.MachineGateway(
    scheduler ?? {
      advanceDueSchedules(): never[] { return []; },
      enqueueInitialExec(): void {},
      addLoop(): void {},
      removeLoop(): void {},
      runNow(): void {},
    } as any,
    undefined,
    notify,
  );
  const rawReport = gw.report.bind(gw);
  gw.report = async (token, body) => {
    const lease = await tokens.resolveLease(token);
    const runId = body.runId ?? lease?.runId ?? "missing-run";
    const hash = tokens.sha256(JSON.stringify({ ...body, runId, token }));
    const reportId = body.reportId ?? `018f47a2-${hash.slice(0, 4)}-7${hash.slice(4, 7)}-8${hash.slice(7, 10)}-${hash.slice(10, 22)}`;
    return rawReport(token, { ...body, reportId, runId });
  };
  return gw;
}

const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();
const MIN = 60_000;

/** Seed an online machine (with a backdated last poll) + a loop. */
async function seedMachineLoop(lastSeenAgoMs: number) {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "Laptop", tokenHash: tokens.sha256(token), online: true }));
  (await store.updateMachine(machineId, { lastSeen: isoAgo(lastSeenAgoMs) }));
  const loop = (await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto" }));
  return { machineId, loop };
}

test("(a) a running run reclaimed while asleep is reconciled to done by the late wake-report — message preserved", async () => {
  const { sent, fn } = recordingNotify();
  const gw = gateway(fn);
  // Laptop slept mid-run: no heartbeat for 21 min, run was claimed 21 min ago.
  const { machineId, loop } = (await seedMachineLoop(21 * MIN));
  const run = (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: isoAgo(21 * MIN) }));
  const rt = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId, role: "exec", allowControl: true });

  // Sweep reclaims the stuck run and pushes the (soft) offline alert.
  (await gw.sweep());
  const swept = (await store.getRun(run.id))!;
  expect(swept.phase).toBe("error");
  expect(swept.error).toBe("machine timed out / disconnected");
  expect(sent).toHaveLength(1);
  expect(sent[0]!.message).toMatch(/asleep|interrupted/i);
  // The lease was NOT retired (terminalized to grace for the wake-report) — it still
  // resolves, now in terminal-grace.
  expect((await tokens.resolveLease(rt))?.state).toBe("terminal-grace");

  // Laptop wakes: claude finished successfully, daemon reports late.
  const res = (await gw.report(rt, { ok: true, durationMs: 1234, sessionId: "sess-1", finalText: "opened PR #42" }));
  expect(res.status).toBe(200);
  const final = (await store.getRun(run.id))!;
  expect(final.phase).toBe("done");
  expect(final.error).toBeNull();
  expect(final.message).toBe("opened PR #42");
  expect(final.durationMs).toBe(1234);
  // The false failure no longer counts against the streak (derived from rows).
  expect((await store.execFailureStreak(loop.id))).toBe(0);
  // A retraction push carried the real result.
  expect(sent).toHaveLength(2);
  expect(sent[1]!.message).toBe("opened PR #42");
  // Single-shot: the lease is now retired — a second late report is rejected.
  expect(await tokens.resolveLease(rt)).toBeUndefined();
  expect((await gw.report(rt, { ok: true, finalText: "again" })).status).toBe(401);
});

test("terminal-grace fences due cadence; late success consumes grace and retimes the fact", async () => {
  const scheduler = new schedulerMod.Scheduler({ dispatch(): void {} });
  const gw = gateway(() => Promise.resolve(), scheduler);
  const { machineId, loop: created } = await seedMachineLoop(21 * MIN);
  await store.updateLoop(created.id, { scheduleMode: "continuous", continuousDelayMinutes: 5 });
  const loop = (await store.getLoop(created.id))!;
  const run = await store.addRun({
    loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", requestedBy: "system", ts: isoAgo(21 * MIN),
  });
  const rt = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId, role: "exec", allowControl: true });

  await gw.sweep();
  const reclaimDue = (await store.getLoop(loop.id))!.nextCadenceAt!;
  expect(await store.advanceDueSchedules(new Date(Date.now() + 10 * MIN).toISOString())).toHaveLength(0);
  expect(await store.claimReadyRunForMachine(machineId)).toBeUndefined();

  expect((await gw.report(rt, { ok: true, finalText: "woke and finished" })).status).toBe(200);
  const final = (await store.getRun(run.id))!;
  const retimed = (await store.getLoop(loop.id))!.nextCadenceAt!;
  expect(retimed).toBe(new Date(Date.parse(final.ts) + 5 * MIN).toISOString());
  expect(Date.parse(retimed)).toBeGreaterThan(Date.parse(reclaimDue));
  await store.advanceDueSchedules(new Date(Date.parse(retimed) + 1).toISOString());
  expect(await store.claimReadyRunForMachine(machineId)).toBeDefined();
});

test("a provisional reclaim defers the breaker; confirmed late failure pauses atomically without duplicate alert", async () => {
  const { sent, fn } = recordingNotify();
  const gw = gateway(fn);
  const { machineId, loop } = await seedMachineLoop(21 * MIN);
  await store.updateLoop(loop.id, { scheduleMode: "continuous", continuousDelayMinutes: 5 });
  for (let i = 0; i < 2; i += 1) {
    await store.addRun({
      loopId: loop.id, userId: "u1", machineId, phase: "error", role: "exec", requestedBy: "system", ts: isoAgo((23 - i) * MIN),
    });
  }
  const running = await store.addRun({
    loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", requestedBy: "system", ts: isoAgo(21 * MIN),
  });
  const rt = await tokens.registerRunLease({ runId: running.id, loopId: loop.id, machineId, role: "exec", allowControl: true });
  await store.enqueueRun(loop.id, { role: "exec", requestedBy: "system" });

  await gw.sweep();
  expect((await store.getRun(running.id))!.phase).toBe("error");
  expect((await store.execFailureStreak(loop.id))).toBe(3);
  expect((await store.getLoop(loop.id))!.enabled).toBe(true);
  expect(sent).toHaveLength(0); // streak 3 is anti-spam-silent while provisional

  expect((await gw.report(rt, { ok: false, error: "confirmed" })).status).toBe(200);
  expect((await store.getLoop(loop.id))).toMatchObject({ enabled: false, nextCadenceAt: null, nextRunAt: null });
  expect((await store.openRunsForLoop(loop.id))).toHaveLength(0);
  expect(sent).toHaveLength(1); // one autopause note, never a second failure alert
});

test("(a') a late FAILURE report records the real error honestly, without a second push", async () => {
  const { sent, fn } = recordingNotify();
  const gw = gateway(fn);
  const { machineId, loop } = (await seedMachineLoop(21 * MIN));
  const run = (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: isoAgo(21 * MIN) }));
  const rt = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId, role: "exec", allowControl: true });

  (await gw.sweep());
  expect(sent).toHaveLength(1); // the reclaim alert
  const res = (await gw.report(rt, { ok: false, error: "claude reported an error" }));
  expect(res.status).toBe(200);
  const final = (await store.getRun(run.id))!;
  expect(final.phase).toBe("error");
  expect(final.error).toBe("claude reported an error"); // real reason replaces the generic reclaim reason
  // No double-alert: the reclaim already notified once for this run.
  expect(sent).toHaveLength(1);
});

test("a cancellation report that races timeout reclaim remains canceled", async () => {
  const gw = gateway(() => Promise.resolve());
  const { machineId, loop } = await seedMachineLoop(21 * MIN);
  const run = await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: isoAgo(21 * MIN) });
  const rt = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId, role: "exec", allowControl: true });

  await gw.sweep();
  expect((await store.getRun(run.id))!.phase).toBe("error");
  expect((await gw.report(rt, { result: "canceled", ok: false, exitCode: 143, error: "canceled by server request" })).status).toBe(200);
  expect(await store.getRun(run.id)).toMatchObject({ phase: "canceled", error: "stopped by user" });
});



test("(b) a pending run on an unreachable machine is DEFERRED — held claimable, no error, no alert", async () => {
  const { sent, fn } = recordingNotify();
  const gw = gateway(fn);
  // Machine last polled 2 min ago (asleep presence), pending run 2 min old. The
  // old sweep failed this as "machine offline" after 60s; now the pending row is
  // the durable inbox — it waits for the machine's next poll (catch-up).
  const { machineId, loop } = (await seedMachineLoop(2 * MIN));
  const run = (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "pending", role: "exec", ts: isoAgo(2 * MIN) }));

  (await gw.sweep());
  const held = (await store.getRun(run.id))!;
  expect(held.phase).toBe("pending");
  expect(held.error).toBeNull();
  // An asleep machine is the common calm case — fully silent (the one-shot
  // offline note fires only past the 6h presence threshold; see index.test.ts).
  expect(sent).toHaveLength(0);
  // The machine itself was flipped offline by the sweep.
  expect((await store.getMachine(machineId))!.online).toBe(false);
});

test("a ready pending row gets a fresh claim window after a 21-minute cross-role blocker ends", async () => {
  const gw = gateway();
  const { machineId, loop } = await seedMachineLoop(5_000);
  const pending = await store.addRun({
    loopId: loop.id, userId: "u1", machineId, phase: "pending", role: "exec", requestedBy: "system", ts: isoAgo(21 * MIN),
  });
  const blocker = await store.addRun({
    loopId: loop.id, userId: "u1", machineId, phase: "running", role: "edit", requestedBy: "owner", ts: isoAgo(21 * MIN),
  });
  // The blocker just ended. The old pending timestamp must not make the follow-up
  // instantly look 21m stale on this very first eligible sweep.
  await store.updateRun(blocker.id, { phase: "done", ts: new Date().toISOString() });
  await gw.sweep();
  expect((await store.getRun(pending.id))!.phase).toBe("pending");
});

test("(c) a long-running run with a fresh heartbeat survives the sweep", async () => {
  const gw = gateway();
  const { machineId, loop } = (await seedMachineLoop(5_000)); // machine polled 5s ago (online)
  // Claimed 30 min ago, but heartbeat stamped 10s ago — still actively working.
  const run = (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: isoAgo(30 * MIN) }));
  (await store.updateRun(run.id, { heartbeatAt: isoAgo(10_000) }));

  (await gw.sweep());
  expect((await store.getRun(run.id))!.phase).toBe("running"); // inactivity timeout keyed off the fresh stamp
});

test("agent-api verbs are refused for a reclaimed run (only the final report reconciles)", async () => {
  const gw = gateway(() => Promise.resolve());
  const { machineId, loop } = (await seedMachineLoop(21 * MIN));
  const run = (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: isoAgo(21 * MIN) }));
  const rt = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId, role: "exec", allowControl: true });

  (await gw.sweep());
  // The CLI verbs live on CliGateway (over the same core instance, like boot).
  const out = (await new cliMod.CliGateway(gw).agentApi(rt, ["reschedule", "1h"]));
  expect(out.status).toBe(409);
  expect(String((out.body as any).text)).toMatch(/terminal|no longer accepts/i);
});
