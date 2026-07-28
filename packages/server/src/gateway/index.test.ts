import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";

import { testStore, type TestLoopSeed, type TestStore } from "../../test/store.js";

let tmp: string;
let db: typeof import("../db/index.js");
let store: TestStore;
let gatewayMod: typeof import("./index.js");
let cliMod: typeof import("./cli.js");
let tokens: typeof import("./tokens.js");
let schedulerMod: typeof import("../scheduler/index.js");

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-gateway-"));
  process.env.PIEVO_DATA_DIR = tmp;
  process.env.PIEVO_LOG_LEVEL = "silent";
  db = await import("../db/index.js");
  await db.runMigrations();
  store = testStore(await import("../db/store.js"));
  gatewayMod = await import("./index.js");
  cliMod = await import("./cli.js");
  tokens = await import("./tokens.js");
  schedulerMod = await import("../scheduler/index.js");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  await (db.client as any).exec("DELETE FROM terminal_report_incidents; DELETE FROM run_report_receipts; DELETE FROM run_leases; DELETE FROM connect_keys; DELETE FROM runs; DELETE FROM loops; DELETE FROM machines;");
});

async function createLoop(input: Omit<TestLoopSeed, "workdir"> & { workdir?: string }) {
  return store.createLoop({ ...input, workdir: input.workdir ?? "/work/project" });
}

type TestGateway = InstanceType<typeof gatewayMod.MachineGateway> & {
  runCli: InstanceType<typeof cliMod.CliGateway>["cli"];
  cli: InstanceType<typeof cliMod.CliGateway>["cli"];
};

async function withReportIds(token: string, body: Parameters<InstanceType<typeof gatewayMod.MachineGateway>["report"]>[1]) {
  const lease = await tokens.resolveLease(token);
  const runId = body.runId ?? lease?.runId ?? "missing-run";
  const hash = tokens.sha256(JSON.stringify({ ...body, runId, token }));
  const reportId = body.reportId ?? `018f47a2-${hash.slice(0, 4)}-7${hash.slice(4, 7)}-8${hash.slice(7, 10)}-${hash.slice(10, 22)}`;
  return { ...body, reportId, runId };
}

async function reportV2(gw: InstanceType<typeof gatewayMod.MachineGateway>, token: string, body: Parameters<typeof gw.report>[1]) {
  return gw.report(token, await withReportIds(token, body));
}

function gateway(
  cliDeps?: ConstructorParameters<typeof cliMod.CliGateway>[1],
): TestGateway {
  const core = new gatewayMod.MachineGateway(
    {
      advanceDueSchedules(): never[] { return []; },
      enqueueInitialExec(): void {},
      addLoop(): void {},
      removeLoop(): void {},
      runNow(): void {},
    } as any,
    undefined, // default local blobstore under the test PIEVO_DATA_DIR
  );
  const rawReport = core.report.bind(core);
  core.report = async (token, body) => rawReport(token, await withReportIds(token, body));
  const cli = new cliMod.CliGateway(core, cliDeps);
  return Object.assign(core, {
    runCli: cli.cli.bind(cli),
    cli: cli.cli.bind(cli),
  });
}

function idIn(res: any): string {
  const m = String(res.body?.text ?? "").match(/loop-[a-z0-9-]+/);
  return res.body?.id ?? m?.[0] ?? "";
}

function textOf(res: any): string {
  return String(res.body?.text ?? "");
}

function pollV4(
  gw: InstanceType<typeof gatewayMod.MachineGateway>,
  token: string,
  request: Partial<Parameters<InstanceType<typeof gatewayMod.MachineGateway>["pollV4"]>[1]> = {},
) {
  return gw.pollV4(token, {
    daemonInstanceId: "test-daemon",
    recoveryComplete: true,
    ...request,
    protocolVersion: 4,
    currentRuns: request.currentRuns ?? [],
    info: { version: "2.4.0", ...request.info },
  });
}

test("machine status distinguishes an unregistered identity without rejecting its token", async () => {
  const unknown = await gateway().status(tokens.mintDeviceToken());
  expect(unknown).toMatchObject({
    status: 200,
    body: { registered: false, claimValid: false, online: false, name: null, lastSeen: null, daemonProtocol: null },
  });

  const claim = tokens.mintDeviceToken();
  await tokens.rememberConnectKey(claim, { userId: "u1", teamId: "team-personal-u1" });
  expect(await gateway().status(claim)).toMatchObject({
    status: 200,
    body: { registered: false, claimValid: true },
  });

  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: false });
  expect(await gateway().status(token)).toMatchObject({ status: 200, body: { registered: true } });
});

test("protocol rejection uses upgrade terminology and gives the restart flow", async () => {
  const res = await gateway().pollV4("not-a-device-token", { protocolVersion: 2, currentRuns: [] });
  expect(res.status).toBe(426);
  expect((res.body as any).error).toContain("daemon upgrade required");
  expect((res.body as any).error).toContain("npm install -g @kky42/pievo@latest");
  expect((res.body as any).error).toContain("pievo daemon restart");
  expect((res.body as any).error).not.toMatch(/update\s+required/i);
});

async function seededExecRun() {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const loop = (await createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true }));
  const run = (await store.addRun({ loopId: loop.id, machineId, phase: "running", ts: new Date().toISOString() }));
  const rt = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId });
  return { machineId, loop, run, rt };
}

test("every index/CLI device surface rejects a full-token-hash collision", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: "different-full-hash", online: true });
  const loop = await createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true });
  const gw = gateway();

  const results = await Promise.all([
    gw.status(token),
    gw.createLoop(token, {}),
    gw.listLoops(token),
    gw.editLoop(token, loop.id, { name: "stolen" }),
    gw.cli(token, ["home"]),
    gw.cli(token, ["pause", loop.id]),
  ]);
  expect(results.map((result) => result.status)).toEqual([401, 401, 401, 401, 401, 401]);
  expect(results.every((result) => JSON.stringify(result.body).includes("mismatch"))).toBe(true);
  expect((await store.getLoop(loop.id))?.name).toBe("L");
});

test("canonical create/edit expose one exclusive schedule union", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const gw = gateway();
  const config = {
    name: "Prompt runner",
    schedule: { mode: "cron", cron: "0 6 * * *", timezone: "UTC", overlap: "skip" },
    workdir: "/work/project",
    agent: "claude-code",
    prompt: "Inspect the project.",
    statusDefinitions: { keep: "useful result", noChange: "nothing changed", block: "owner input needed" },
    artifacts: ["reports/latest.md"],
    idempotencyKey: "a".repeat(64),
  };
  expect((await gw.createLoop(token, { ...config, cron: "0 7 * * *" } as any)).status).toBe(400);
  const created = await gw.createLoop(token, config);
  expect(created.status).toBe(200);
  const id = (created.body as any).id;
  expect(await store.getLoop(id)).toMatchObject({ prompt: config.prompt, cronOverlap: "skip", artifacts: config.artifacts });
  expect((await gw.editLoop(token, id, { schedule: { mode: "continuous", delayMinutes: 5, cron: "0 8 * * *" } })).status).toBe(400);
  expect((await gw.editLoop(token, id, { schedule: { mode: "continuous", delayMinutes: 5 } })).status).toBe(200);
  expect(await store.getLoop(id)).toMatchObject({ scheduleMode: "continuous", continuousDelayMinutes: 5 });

  const cronCreated = await gw.createLoop(token, { ...config, name: "Cron runner", idempotencyKey: "c".repeat(64) });
  expect(cronCreated.status).toBe(200);
  const listed = await gw.listLoops(token, undefined, true);
  const json = JSON.parse((listed.body as any).text) as Array<Record<string, unknown>>;
  expect(json.map((loop) => loop.schedule)).toEqual([
    { mode: "continuous", delayMinutes: 5 },
    config.schedule,
  ]);
  for (const loop of json) {
    expect(loop).not.toHaveProperty("cron");
    expect(loop).not.toHaveProperty("scheduleMode");
    expect(loop).not.toHaveProperty("continuousDelayMinutes");
    expect(loop).not.toHaveProperty("timezone");
  }
  expect((listed.body as any).loops).toEqual(json);
});

test("create transport requires exact idempotency/dryRun fields and rejects invalid explicit claims", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await makeTeam("claim-team", ["u1"]);
  const machine = await store.createMachine({ id: machineId, userId: "u1", teamId: "claim-team", name: "M", tokenHash: tokens.sha256(token), online: true });
  const config = {
    name: "Strict transport",
    schedule: { mode: "continuous", delayMinutes: 5 },
    workdir: "/work/project",
    agent: "claude-code",
    prompt: "Inspect the project.",
    statusDefinitions: { keep: "keep", noChange: "none", block: "blocked" },
  };
  const gw = gateway();

  for (const idempotencyKey of [undefined, null, 42, "A".repeat(64), "a".repeat(63), ` ${"a".repeat(64)}`]) {
    expect((await gw.createLoop(token, { ...config, idempotencyKey })).status).toBe(400);
  }
  expect((await gw.createLoop(token, { ...config, idempotencyKey: "a".repeat(64), dryRun: "true" })).body)
    .toMatchObject({ error: "dryRun must be boolean when provided" });

  for (const claim of [null, "", "dk_not-hex", tokens.mintDeviceToken()]) {
    const result = await gw.createLoop(token, { ...config, idempotencyKey: "b".repeat(64), dryRun: true, claim });
    expect(result.status).toBe(400);
  }

  const claim = tokens.mintDeviceToken();
  await tokens.rememberConnectKey(claim, { userId: machine.userId, teamId: machine.teamId });
  expect((await gw.createLoop(token, { ...config, idempotencyKey: "c".repeat(64), dryRun: true, claim })).status).toBe(200);
  expect(await store.loopsForMachine(machineId)).toHaveLength(0);
});

test("minimal report protocol accepts only canonical status, message, and help flags", async () => {
  const { run, rt } = await seededExecRun();
  const gw = gateway();
  expect((await gw.runCli(rt, ["report", "--status", "invalid", "--message", "bad status"])).status).toBe(400);
  expect((await gw.runCli(rt, ["report", "--status", "keep", "--message", "ok", "--extra", "value"])).status).toBe(400);
  expect((await gw.runCli(rt, ["show"])).status).toBe(403);
  expect((await gw.runCli(rt, ["report", "--status", "keep", "--message", "completed"])).status).toBe(200);
  expect(await store.getRun(run.id)).toMatchObject({ status: "keep", message: "completed" });
});

test("a valid report callback after force deletion succeeds as a discarded retired-run no-op", async () => {
  const { loop, run, rt } = await seededExecRun();
  expect(await store.forceDeleteLoop(loop.id)).toBe(true);

  const gw = gateway();
  expect((await gw.runCli(rt, ["report", "--status", "keep"])).status).toBe(400);
  const response = await gw.runCli(rt, ["report", "--status", "keep", "--message", "completed before deletion"]);

  expect(response).toEqual({
    status: 200,
    body: { text: "reported: run retired · result discarded", exitCode: 0 },
  });
  expect(await store.getLoop(loop.id)).toBeUndefined();
  expect(await store.getRun(run.id)).toBeUndefined();
  expect(await tokens.resolveLease(rt)).toMatchObject({ state: "retired" });
});

test("report callback is exactly once under the loop lock", async () => {
  const { run, rt } = await seededExecRun();
  const gw = gateway();
  const [a, b] = await Promise.all([
    gw.runCli(rt, ["report", "--status", "keep", "--message", "first"]),
    gw.runCli(rt, ["report", "--status", "block", "--message", "second"]),
  ]);
  expect([a.status, b.status].sort()).toEqual([200, 409]);
  const stored = await store.getRun(run.id);
  expect([
    { status: "keep", message: "first" },
    { status: "block", message: "second" },
  ]).toContainEqual({ status: stored?.status, message: stored?.message });
  expect((await gw.runCli(rt, ["report", "--status", "no-change", "--message", "third"])).status).toBe(409);
  expect(await store.getRun(run.id)).toMatchObject({ status: stored?.status, message: stored?.message });
});

test("block persists telemetry and atomically pauses", async () => {
  const { loop, run, rt } = await seededExecRun();
  const gw = gateway();
  expect((await gw.runCli(rt, ["report", "--status", "block", "--message", "owner input required"])).status).toBe(200);
  const terminal = await reportV2(gw, rt, {
    result: "success",
    durationMs: 321,
    exitCode: 0,
    sessionId: "session-123",
    finalText: "provider final response",
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 },
  });
  expect(terminal.status).toBe(200);
  expect(await store.getRun(run.id)).toMatchObject({
    phase: "done",
    status: "block",
    message: "owner input required",
    sessionId: "session-123",
    finalText: "provider final response",
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 },
  });
  expect(await store.getLoop(loop.id)).toMatchObject({ enabled: false, nextCadenceAt: null, nextRunAt: null, pauseCause: { kind: "blocked", runId: run.id } });
});

test("three ordinary errors trigger the failure-streak pause", async () => {
  const seeded = await seededExecRun();
  const gw = gateway();
  let currentRun = seeded.run;
  let token = seeded.rt;
  for (let i = 0; i < 3; i++) {
    const response = await reportV2(gw, token, { result: "failure", error: `failure ${i + 1}` });
    expect(response.status).toBe(200);
    if (i < 2) {
      currentRun = await store.addRun({ loopId: seeded.loop.id, machineId: seeded.machineId, phase: "running", ts: new Date().toISOString() });
      token = await tokens.registerRunLease({ runId: currentRun.id, loopId: seeded.loop.id, machineId: seeded.machineId });
    }
  }
  expect(await store.getLoop(seeded.loop.id)).toMatchObject({ enabled: false, pauseCause: { kind: "failure-streak", count: 3, runId: currentRun.id } });
});

/** Insert a team (+ optional member rows) directly, bypassing store.ensureTeam's
 *  memo/rename side effects so each test controls membership precisely. */
async function makeTeam(id: string, memberUserIds: string[] = []): Promise<void> {
  const ts = new Date().toISOString();
  await (db.client as any).exec(`INSERT INTO teams (id, name, owner_user_id, created_at) VALUES ('${id}', '${id}', NULL, '${ts}') ON CONFLICT DO NOTHING`);
  for (const u of memberUserIds) {
    await (db.client as any).exec(
      `INSERT INTO team_members (id, team_id, user_id, role, created_at) VALUES ('${id}:${u}', '${id}', '${u}', 'member', '${ts}') ON CONFLICT DO NOTHING`,
    );
  }
}

async function seededLoop() {
  const machine = (await store.createMachine({ id: "m-gateway", userId: "u1", name: "M", tokenHash: "h", online: true }));
  const loop = (await createLoop({
    userId: "u1",
    machineId: machine.id,
    name: "L",
    cron: "0 0 1 1 *",
    enabled: true,
  }));
  const run = (await store.addRun({
    loopId: loop.id,
    machineId: machine.id,
    phase: "running",
    ts: new Date().toISOString(),
  }));
  return { machine, loop, run };
}





test("report persists normalized terminal telemetry without cost or transcript fields", async () => {
  const { loop, machine, run } = await seededLoop();
  await store.updateRun(run.id, { message: "agent callback summary" });
  const token = await tokens.registerRunLease({
    runId: run.id, loopId: loop.id, machineId: machine.id,
  });
  const res = await gateway().report(token, {
    runId: run.id,
    result: "success" as const,
    exitCode: 0,
    durationMs: 1234,
    sessionId: "sess-abc",
    finalText: "provider final output",
    usage: { inputTokens: 120, outputTokens: 9, cacheReadTokens: 40, cacheCreationTokens: 3 },
  });
  expect(res.status).toBe(200);
  const stored = await store.getRun(run.id);
  expect(stored).toMatchObject({
    exitCode: 0, durationMs: 1234, sessionId: "sess-abc", finalText: "provider final output",
    message: "agent callback summary",
    usage: { inputTokens: 120, outputTokens: 9, cacheReadTokens: 40, cacheCreationTokens: 3 },
  });
  expect(stored && "costUsd" in stored).toBe(false);
  expect(stored && "transcript" in stored).toBe(false);
});

test("machine finalization turns a successful process into an error when the run skipped its required report", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const loop = await createLoop({
    userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true,
  });
  const run = await store.addRun({ loopId: loop.id, machineId, phase: "running", ts: new Date().toISOString() });
  const rt = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId });

  const res = await gateway().report(rt, { result: "success", exitCode: 0, finalText: "provider claimed success" });
  expect(res.status).toBe(200);
  expect(await store.getRun(run.id)).toMatchObject({
    phase: "error",
    status: null,
    message: null,
    error: "run protocol incomplete: missing status, message",
  });
});

test("report terminalizes the leased run when payload runId does not match", async () => {
  const { loop, machine, run } = await seededLoop();
  const token = await tokens.registerRunLease({
    runId: run.id, loopId: loop.id, machineId: machine.id,
  });
  const response = await gateway().report(token, { runId: "run-other", result: "success" as const });
  expect(response).toMatchObject({ status: 200, body: { accepted: false, code: "REPORT_INVALID", disposition: "run-error" } });
  expect(await store.getRun(run.id)).toMatchObject({ phase: "error", reportIncident: { code: "REPORT_INVALID" } });
  expect(await tokens.resolveLease(token)).toBeUndefined();
});

test("a machine's bound loops gate its deletion (loopsForMachine drains to empty)", async () => {
  const { machine, loop } = (await seededLoop());
  expect((await store.loopsForMachine(machine.id)).map((l) => l.id)).toEqual([loop.id]);
  // An executing loop requires explicit authority retirement before deletion.
  (await store.forceDeleteLoop(loop.id));
  expect((await store.loopsForMachine(machine.id))).toHaveLength(0);
  expect((await store.deleteMachine(machine.id))).toBe(true);
});


















test("concurrent polls deliver a pending run exactly once (atomic pending->running claim)", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const loop = (await createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true }));
  const run = (await store.addRun({ loopId: loop.id, machineId, phase: "pending", ts: new Date().toISOString() }));

  // Two polls in flight at once (an HTTP retry racing its timed-out original, or
  // two daemons sharing one device token = the same machineId). The conditional
  // pending->running claim must let exactly ONE of them deliver the run - the old
  // unconditional read-then-write let both, double-executing it on the machine.
  const gw = gateway();
  const results = await Promise.all([pollV4(gw, token), pollV4(gw, token)]);
  const delivered = results
    .map((r) => (r.body as { delivery: { runId: string } | null }).delivery)
    .filter((delivery): delivery is { runId: string } => delivery !== null);
  expect(delivered.filter((d) => d.runId === run.id)).toHaveLength(1);
  expect((await store.getRun(run.id))!.phase).toBe("running");

  const again = await pollV4(gw, token, { currentRuns: [{ runId: run.id, stage: "executing" }] });
  expect((again.body as any).delivery).toBeNull();
});

test("pollV4 with an old or unknown daemon version does not claim pending work", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const loop = await createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true });
  const run = await store.addRun({ loopId: loop.id, machineId, phase: "pending", ts: new Date().toISOString() });

  const unknown = await gateway().pollV4(token, { protocolVersion: 4, daemonInstanceId: "test-daemon", recoveryComplete: true, currentRuns: [], info: { host: "mac" } });
  expect(unknown.status).toBe(200);
  expect((unknown.body as any).delivery).toBeNull();
  expect((unknown.body as any).needsUpdate.current).toBeNull();
  expect((await store.getRun(run.id))!.phase).toBe("pending");

  const old = await gateway().pollV4(token, { protocolVersion: 4, daemonInstanceId: "test-daemon", recoveryComplete: true, currentRuns: [], info: { host: "mac", version: "2.0.2" } });
  expect(old.status).toBe(200);
  expect((old.body as any).delivery).toBeNull();
  expect((old.body as any).needsUpdate).toMatchObject({ current: "2.0.2", required: "2.4.0" });
  expect((await store.getRun(run.id))!.phase).toBe("pending");

  for (const malformed of [
    "2.4",
    "2.4.0garbage",
    "2.4.0.1",
    " 2.4.0",
    "v2.4.0",
    "02.4.0",
  ]) {
    const rejected = await gateway().pollV4(token, { protocolVersion: 4, daemonInstanceId: "test-daemon", recoveryComplete: true, currentRuns: [], info: { host: "mac", version: malformed } });
    expect((rejected.body as any).delivery, malformed).toBeNull();
    expect((rejected.body as any).needsUpdate, malformed).toMatchObject({ current: malformed, required: "2.4.0" });
    expect((await store.getRun(run.id))!.phase, malformed).toBe("pending");
  }
});

test("protocol-v4 recovery fields and exact currentRuns items are required before claiming", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const loop = await createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true });
  const run = await store.addRun({ loopId: loop.id, machineId, phase: "pending", ts: new Date().toISOString() });
  const base = { protocolVersion: 4, currentRuns: [], info: { version: "2.4.0" } };

  const invalidRequests = [
    base,
    { ...base, daemonInstanceId: "test-daemon" },
    { ...base, daemonInstanceId: "", recoveryComplete: true },
    { protocolVersion: 4, daemonInstanceId: "test-daemon", recoveryComplete: true, info: { version: "2.4.0" } },
    { ...base, daemonInstanceId: "test-daemon", recoveryComplete: false },
    { ...base, daemonInstanceId: "test-daemon", recoveryComplete: "true" },
    { ...base, daemonInstanceId: "test-daemon", recoveryComplete: true, currentRuns: [{ runId: "", stage: "executing" }] },
    { ...base, daemonInstanceId: "test-daemon", recoveryComplete: true, currentRuns: [{ runId: "local-run", stage: "executing", unknown: true }] },
    { ...base, daemonInstanceId: "test-daemon", recoveryComplete: true, unknown: true },
  ];
  for (const request of invalidRequests) {
    expect((await gateway().pollV4(token, request as any)).status).toBe(400);
    expect((await store.getRun(run.id))?.phase).toBe("pending");
  }
});

test("pollV4 defensively rejects invalid machine info before any mutation", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: false, daemonProtocol: 3 });
  const loop = await createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true });
  const run = await store.addRun({ loopId: loop.id, machineId, phase: "pending", ts: new Date().toISOString() });
  const base = { protocolVersion: 4, daemonInstanceId: "test-daemon", recoveryComplete: true, currentRuns: [] };

  for (const info of [
    { host: 42 },
    { platform: null },
    { arch: "arm64\0forged" },
    { version: "v".repeat(65) },
    { host: "mac", unknown: true },
  ]) {
    expect((await gateway().pollV4(token, { ...base, info } as any)).status).toBe(400);
    expect(await store.getMachine(machineId)).toMatchObject({ online: false, daemonProtocol: 3, hostname: null });
    expect((await store.getRun(run.id))?.phase).toBe("pending");
  }
});

test("pollV4 with the supported daemon version can claim pending work", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const loop = await createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, model: "snapshot-model", reasoningEffort: "high", agent: "codex" });
  const run = await store.addRun({ loopId: loop.id, machineId, phase: "pending", ts: new Date().toISOString() });

  const res = await gateway().pollV4(token, { protocolVersion: 4, daemonInstanceId: "test-daemon", recoveryComplete: true, currentRuns: [], info: { host: "mac", version: "2.4.0" } });
  expect(res.status).toBe(200);
  expect((res.body as any).delivery).toMatchObject({ runId: run.id, runIndex: 1 });
  expect((res.body as any).needsUpdate).toBeUndefined();
  expect((await store.getRun(run.id))!).toMatchObject({ phase: "running", runIndex: 1, agent: "codex", model: "snapshot-model", reasoningEffort: "high" });

  const secondLoop = await createLoop({ userId: "u1", machineId, name: "L2", cron: "0 0 1 1 *", enabled: true });
  const secondRun = await store.addRun({ loopId: secondLoop.id, machineId, phase: "pending", ts: new Date().toISOString() });
  const omitted = await gateway().pollV4(token, { protocolVersion: 4, daemonInstanceId: "test-daemon", recoveryComplete: true, currentRuns: [], info: { host: "mac" } });
  expect((omitted.body as any).delivery).toBeNull();
  expect((omitted.body as any).needsUpdate).toMatchObject({ current: null, required: "2.4.0" });
  expect((await store.getRun(secondRun.id))?.phase).toBe("pending");
});

test("createLoop uses the claim intent team instead of the machine home team", async () => {
  await makeTeam("team-home", ["u1"]);
  await makeTeam("team-target", ["u1"]);
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await store.createMachine({ id: machineId, userId: "u1", teamId: "team-home", name: "M", tokenHash: tokens.sha256(token), online: true });
  const claim = tokens.mintDeviceToken();
  await tokens.rememberConnectKey(claim, { userId: "u1", teamId: "team-target" });

  const result = await gateway().createLoop(token, {
    name: "Targeted",
    schedule: { mode: "continuous", delayMinutes: 5 },
    workdir: "/work/project",
    agent: "claude-code",
    prompt: "Inspect the project.",
    statusDefinitions: { keep: "keep", noChange: "none", block: "blocked" },
    claim,
    idempotencyKey: "d".repeat(64),
  });

  expect(result.status).toBe(200);
  expect(await store.getLoop((result.body as { id: string }).id)).toMatchObject({ teamId: "team-target", machineId });
});

test("listMachinesForTeam is membership-scoped — a machine shows in its owner's team regardless of its home team", async () => {
  (await makeTeam("team-lm", ["u1"])); // only u1 is a member
  const t1 = tokens.mintDeviceToken();
  const m1 = tokens.machineIdFromToken(t1);
  (await store.createMachine({ id: m1, userId: "u1", teamId: "team-u1", name: "Mine", tokenHash: tokens.sha256(t1), online: true }));
  const t2 = tokens.mintDeviceToken();
  (await store.createMachine({ id: tokens.machineIdFromToken(t2), userId: "u2", teamId: "team-u2", name: "Other", tokenHash: tokens.sha256(t2), online: true }));

  expect((await store.listMachinesForTeam("team-lm")).map((m) => m.id)).toEqual([m1]);
});

async function seededMachine() {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  return { token, machineId };
}



test("createLoop --dry-run still validates (bad cron → 400, nothing created)", async () => {
  const { token, machineId } = (await seededMachine());
  const res = await gateway().createLoop(token, {
    name: "bad", schedule: { mode: "cron", cron: "not a cron", timezone: "UTC", overlap: "skip" },
    workdir: "/work", agent: "codex", prompt: "test", dryRun: true, idempotencyKey: "b".repeat(64),
    statusDefinitions: { keep: "keep", noChange: "no change", block: "block" },
  });
  expect(res.status).toBe(400);
  expect((await store.loopsForMachine(machineId))).toHaveLength(0);
});

test("editLoop --dry-run returns canonical before and after without persisting", async () => {
  const { token, machineId } = await seededMachine();
  const loop = await createLoop({ userId: "u1", machineId, name: "Before", cron: "0 8 * * *", enabled: true });

  const res = await gateway().editLoop(token, loop.id, { name: "  After  ", model: "  opus  " }, true);

  expect(res.status).toBe(200);
  const body = res.body as Record<string, unknown>;
  expect(body).toMatchObject({
    dryRun: true,
    applied: ["name", "model"],
    before: { id: loop.id, name: "Before", model: null },
    after: { id: loop.id, name: "After", model: "opus" },
    config: { name: "After", model: "opus" },
  });
  expect(body.config).not.toHaveProperty("id");
  expect(JSON.parse(String(body.text))).toMatchObject({ before: { name: "Before" }, after: { name: "After" } });
  expect(await store.getLoop(loop.id)).toMatchObject({ name: "Before", model: null });
});

async function addExecRun(loopId: string, machineId: string, phase: "done" | "error", ts: string) {
  return (await store.addRun({ loopId, machineId, phase, ts }));
}





test("only a done block terminal auto-pauses", async () => {
  const canceled = await seededExecRun();
  const gw = gateway();
  expect((await gw.cli(canceled.rt, ["report", "--status", "block", "--message", "owner input needed"])).status).toBe(200);
  expect((await gw.report(canceled.rt, { result: "canceled", exitCode: 143, durationMs: 1 })).status).toBe(200);
  expect(await store.getLoop(canceled.loop.id)).toMatchObject({ enabled: true, pauseCause: null });

  const failed = await seededExecRun();
  expect((await gw.cli(failed.rt, ["report", "--status", "block", "--message", "owner input needed"])).status).toBe(200);
  expect((await gw.report(failed.rt, { result: "failure", error: "provider failed", durationMs: 1 })).status).toBe(200);
  expect(await store.getLoop(failed.loop.id)).toMatchObject({ enabled: true, pauseCause: null });

  const done = await seededExecRun();
  expect((await gw.cli(done.rt, ["report", "--status", "block", "--message", "owner input needed"])).status).toBe(200);
  expect((await gw.report(done.rt, { result: "success", durationMs: 1 })).status).toBe(200);
  expect(await store.getLoop(done.loop.id)).toMatchObject({ enabled: false, pauseCause: { kind: "blocked", runId: done.run.id } });
});

test("report requires a valid status and a non-empty message", async () => {
  const { run, rt } = await seededExecRun();
  const gw = gateway();
  expect((await gw.cli(rt, ["report", "--status", "wibble", "--message", "done"])).status).toBe(400);
  expect((await gw.cli(rt, ["report", "--status", "keep"])).status).toBe(400);
  expect((await gw.cli(rt, ["report", "--status", "keep", "--message", "   "])).status).toBe(400);
  expect(await store.getRun(run.id)).toMatchObject({ status: null, message: null });
});

test("continuous loop stops enqueueing after the 3rd exec error trips the breaker", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const loop = await createLoop({
    userId: "u1",
    machineId,
    name: "Continuous",
    cron: "0 0 1 1 *",
    scheduleMode: "continuous",
    continuousDelayMinutes: 1,
    enabled: true,
  });
  const scheduler = new schedulerMod.Scheduler({ dispatch(): void {} });
  const gw = new gatewayMod.MachineGateway(scheduler);

  let current = await store.addRun({ loopId: loop.id, machineId, phase: "running", requestedBy: "system", ts: new Date().toISOString() });
  for (let attempt = 1; attempt <= 3; attempt++) {
    const rt = await tokens.registerRunLease({ runId: current.id, loopId: loop.id, machineId });
    expect((await reportV2(gw, rt, { result: "failure" as const, error: `boom ${attempt}`, durationMs: 1 })).status).toBe(200);
    let waiting = (await store.openRunsForLoop(loop.id)).find((r) => r.phase === "pending");
    if (attempt < 3) {
      expect(waiting).toBeUndefined();
      const target = (await store.getLoop(loop.id))!.nextCadenceAt!;
      await store.advanceDueSchedules(new Date(Date.parse(target) + 1).toISOString());
      waiting = (await store.openRunsForLoop(loop.id)).find((r) => r.phase === "pending");
      expect(waiting, `attempt ${attempt} should continue`).toBeTruthy();
      current = (await store.updateRun(waiting!.id, { phase: "running", ts: new Date().toISOString() }))!;
    } else {
      expect(waiting).toBeUndefined();
    }
  }
  expect((await store.getLoop(loop.id))!.enabled).toBe(false);
});

test("circuit breaker pauses after the configured failure streak", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const loop = (await createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true }));
  const gw = gateway();

  const base = Date.now() - 60 * 60_000;
  for (let i = 0; i < 2; i++) {
    (await store.addRun({ loopId: loop.id, machineId, phase: "error", ts: new Date(base + i * 60_000).toISOString() }));
  }
  const run = (await store.addRun({ loopId: loop.id, machineId, phase: "running", ts: new Date().toISOString() }));
  const rt = (await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId }));
  (await gw.report(rt, { result: "failure" as const, error: "boom", durationMs: 1 }));

  expect((await store.getLoop(loop.id))!.enabled).toBe(false);
});

test("manual follow-ups are not reclaimed while blocked by a running run or a long-offline machine", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const loop = await createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true });
  await store.addRun({ loopId: loop.id, machineId, phase: "running", requestedBy: "owner", ts: new Date().toISOString() });
  const queued = await store.addRun({ loopId: loop.id, machineId, phase: "pending", requestedBy: "owner", ts: new Date(Date.now() - 8 * 86_400_000).toISOString() });
  const gw = gateway();

  await gw.sweep();
  expect((await store.getRun(queued.id))!.phase).toBe("pending");
  await store.updateMachine(machineId, { online: false, lastSeen: "2000-01-01T00:00:00Z" });
  await gw.sweep();
  expect((await store.getRun(queued.id))!.phase).toBe("pending");
});

test("an auto deferred pending run past the catch-up horizon retires as `skipped` — no error, no alert", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: false, lastSeen: "2000-01-01T00:00:00Z" }));
  const loop = (await createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true }));
  const gw = gateway();

  const run = (await store.addRun({ loopId: loop.id, machineId, phase: "pending", ts: new Date(Date.now() - 8 * 86_400_000).toISOString() }));
  (await gw.sweep());

  const retired = (await store.getRun(run.id))!;
  expect(retired.phase).toBe("canceled");
  expect(retired.error).toBeNull();
});

test("sweep marks a reclaimed run token report-only while preserving one wake-report", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const loop = (await createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true }));
  const staleTs = new Date(Date.now() - 30 * 60_000).toISOString();
  const run = (await store.addRun({ loopId: loop.id, machineId, phase: "running", ts: staleTs }));
  const rt = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId });

  const gw = gateway();
  expect((await gw.runCli(rt, ["show"])).status).toBe(403); // run credentials are report-only even before sweep
  (await gw.sweep());
  expect((await store.getRun(run.id))!.phase).toBe("error");
  expect((await store.getRun(run.id))!.error).toBe("machine timed out / disconnected");
  // The orphaned agent can no longer MUTATE the loop (reclaimed → 409, not silent),
  // but the token is not revoked outright: it survives to accept one wake-report.
  expect((await gw.runCli(rt, ["show"])).status).toBe(409);
  expect(await tokens.resolveLease(rt)).toBeTruthy();
});

test("a stale sweep observation that loses its phase CAS has zero side effects", async () => {
  const { loop, run, rt } = await seededExecRun();
  const calls: string[] = [];
  const core = new gatewayMod.MachineGateway({
    addLoop(): void { calls.push("arm"); }, removeLoop(): void {}, advanceDueSchedules(): never[] { return []; },
  } as any);
  await store.updateRun(run.id, { phase: "done"});

  await (core as any).reclaimRun(run, "stale reclaim");
  expect((await store.getRun(run.id))!.phase).toBe("done");
  expect(calls).toEqual([]);
  // Reclaim checks the phase under the loop lock before terminalizing, so a stale
  // observation cannot mutate the winning report's active lease.
  expect((await tokens.resolveLease(rt))?.state).toBe("active");
  expect((await store.getLoop(loop.id))!.enabled).toBe(true);
});

test("a pending reclaim CAS cannot overwrite a concurrent poll claim", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const loop = await createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true });
  const queued = await store.enqueueRun(loop.id, { requestedBy: "system" });
  if (!("run" in queued)) throw new Error("expected queued run");
  const stalePending = queued.run;
  expect(await store.claimReadyRunForMachine(machineId)).toBeDefined();
  const calls: string[] = [];
  const core = new gatewayMod.MachineGateway({
    addLoop(): void { calls.push("arm"); }, removeLoop(): void {}, advanceDueSchedules(): never[] { return []; },
  } as any);

  await (core as any).reclaimRun(stalePending, "stale pending reclaim");
  expect((await store.getRun(stalePending.id))!.phase).toBe("running");
  expect(calls).toEqual([]);
});

test("sweep keeps an online pending row as durable queued work", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const activeLoop = await createLoop({ userId: "u1", machineId, name: "active", cron: "0 0 1 1 *", enabled: true });
  const waitingLoop = await createLoop({ userId: "u1", machineId, name: "waiting", cron: "0 0 1 1 *", enabled: true });
  await store.addRun({ loopId: activeLoop.id, machineId, phase: "running", ts: new Date().toISOString() });
  const old = new Date(Date.now() - 30 * 60_000).toISOString();
  const waiting = await store.addRun({
    loopId: waitingLoop.id, machineId, phase: "pending",
    requestedBy: "system", ts: old, createdAt: old, updatedAt: old,
  });

  await gateway().sweep();
  expect(await store.getRun(waiting.id)).toMatchObject({ phase: "pending", error: null });
});

test("stale offline expiration cannot cancel a concurrently promoted/coalesced row", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: false });
  const loop = await createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true });
  const old = new Date(Date.now() - 8 * 86_400_000).toISOString();
  const pending = await store.addRun({
    loopId: loop.id, machineId, phase: "pending",
    requestedBy: "system", ts: old, createdAt: old, updatedAt: old,
  });
  await store.enqueueRun(loop.id, { requestedBy: "owner" });

  const expired = await store.expirePendingRun(
    pending.id,
    { requestedBy: "system", updatedAt: pending.updatedAt },
    new Date().toISOString(),
    7 * 86_400_000,
    "skipped - offline",
  );
  expect(expired).toBe(false);
  expect(await store.getRun(pending.id)).toMatchObject({ phase: "pending", requestedBy: "owner" });
});

test("sweep is INACTIVITY-based: a >20min run reported in currentRuns is NOT reclaimed", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const loop = (await createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true }));
  const staleTs = new Date(Date.now() - 30 * 60_000).toISOString();
  const run = (await store.addRun({ loopId: loop.id, machineId, phase: "running", ts: staleTs }));

  const gw = gateway();
  const otherToken = tokens.mintDeviceToken();
  await pollV4(gw, otherToken, { info: { host: "other" }, currentRuns: [{ runId: run.id, stage: "executing" }] });
  expect((await store.getRun(run.id))!.heartbeatAt).toBeNull();

  await pollV4(gw, token, { currentRuns: [{ runId: run.id, stage: "executing" }] });
  expect((await store.getRun(run.id))!.heartbeatAt).toBeTruthy();
  (await gw.sweep());
  expect((await store.getRun(run.id))!.phase).toBe("running");

  (await store.updateRun(run.id, { heartbeatAt: staleTs }));
  (await gw.sweep());
  expect((await store.getRun(run.id))!.phase).toBe("error");
  expect((await store.getRun(run.id))!.error).toBe("machine timed out / disconnected");
});

test("currentRuns heartbeat refresh is scoped to the owning machine", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const loop = await createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true });
  const run = await store.addRun({ id: "single-active", loopId: loop.id, machineId, phase: "running", ts: new Date().toISOString() });
  await pollV4(gateway(), token, {
    currentRuns: [
      { runId: run.id, stage: "executing" },
      { runId: run.id, stage: "executing" },
    ],
  });
  expect((await store.getRun(run.id))?.heartbeatAt).toBeTruthy();
});

test("heartbeat refresh throttling stays inside short custom timeout windows", () => {
  expect(gatewayMod.heartbeatRefreshMs(9_000)).toBe(3_000);
  expect(gatewayMod.heartbeatRefreshMs(30_000)).toBe(10_000);
  expect(gatewayMod.heartbeatRefreshMs(10 * 60_000)).toBe(60_000);
  expect(gatewayMod.heartbeatRefreshMs(Number.NaN)).toBe(1);
});

test("CLI report clips --message to the 2000-char cap", async () => {
  const { run, rt } = (await seededExecRun());
  const res = (await gateway().runCli(rt, ["report", "--status", "keep", "--message", "m".repeat(5000)]));
  expect(res.status).toBe(200);
  expect((await store.getRun(run.id))!.message!.length).toBe(2000);
});

test("CLI flags are NUL-stripped before any pg write", async () => {
  // Postgres text/jsonb REJECT U+0000 (SQLite tolerated it) - a flag value
  // carrying one (e.g. --file-content inlining a file with a stray NUL) must be
  // sanitized at the parseFlags chokepoint, not 500 the verb mid-run.
  const { run, rt } = (await seededExecRun());
  const res = (await gateway().runCli(rt, [
    "report",
    "--status",
    "keep",
    "--message",
    "before\u0000after",
  ]));
  expect(res.status).toBe(200);
  const stored = (await store.getRun(run.id))!;
  expect(stored.message).toBe("beforeafter");
});

test("report clips valid diagnostic strings and durably rejects a non-string error", async () => {
  const { run, rt } = (await seededExecRun());
  const res = (await gateway().report(rt, {
    result: "failure" as const,
    durationMs: 1,
    sessionId: "s".repeat(500),
    error: "e".repeat(5000),
  }));
  expect(res.status).toBe(200);
  const stored = (await store.getRun(run.id))!;
  expect(stored.sessionId!.length).toBe(200);
  expect(stored.error!.length).toBe(2000);

  const again = (await seededExecRun());
  const invalid = await gateway().report(again.rt, { result: "failure" as const, durationMs: 1, error: 42 as never });
  expect(invalid).toMatchObject({ status: 200, body: { accepted: false, code: "REPORT_INVALID", disposition: "run-error" } });
  expect((invalid.body as any).issues).toContain("error must be a string");
  expect((await store.getRun(again.run.id))!).toMatchObject({ phase: "error", reportIncident: { code: "REPORT_INVALID" } });
});

test("poll persists the daemon version, updating only when it changes", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await tokens.rememberConnectKey(token, { userId: "shared", teamId: store.teamIdForUser("shared") });
  await gateway().pollV4(token, { protocolVersion: 4, daemonInstanceId: "test-daemon", recoveryComplete: true, currentRuns: [], info: { host: "mac", platform: "darwin", arch: "arm64", version: "0.8.0" } });
  expect((await store.getMachine(machineId))!.daemonVersion).toBe("0.8.0");
  await gateway().pollV4(token, { protocolVersion: 4, daemonInstanceId: "test-daemon", recoveryComplete: true, currentRuns: [], info: { host: "mac", platform: "darwin", arch: "arm64", version: "0.9.0" } });
  expect((await store.getMachine(machineId))!.daemonVersion).toBe("0.9.0");
  await gateway().pollV4(token, { protocolVersion: 4, daemonInstanceId: "test-daemon", recoveryComplete: true, currentRuns: [], info: { host: "mac", platform: "darwin", arch: "arm64" } });
  expect((await store.getMachine(machineId))!.daemonVersion).toBe("0.9.0");
  await gateway().pollV4(token, { protocolVersion: 4, daemonInstanceId: "test-daemon", recoveryComplete: true, currentRuns: [], info: { host: "mac", version: "9".repeat(200) } });
  expect((await store.getMachine(machineId))!.daemonVersion).toBe("0.9.0");
});

async function seededCli() {
  const deviceToken = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(deviceToken);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(deviceToken), online: true }));
  const loop = (await createLoop({
    userId: "u1",
    machineId,
    name: "L",
    cron: "0 0 1 1 *",
    enabled: true,
  }));
  const run = (await store.addRun({ loopId: loop.id, machineId, phase: "running", ts: new Date().toISOString() }));
  const runToken = await tokens.registerRunLease({
    runId: run.id,
    loopId: loop.id,
    machineId,
  });
  return { deviceToken, machineId, loop, run, runToken };
}

test("cli branches by canonical dk_ and rk_ credential prefixes", async () => {
  const { deviceToken, runToken, loop } = (await seededCli());
  const gw = gateway();
  const dev = (await gw.cli(deviceToken, ["loops"]));
  expect(dev.status).toBe(200);
  expect((dev.body as any).loops.map((l: any) => l.id)).toContain(loop.id);
  const run = (await gw.cli(runToken, ["loops"]));
  expect(run.status).toBe(403);
  expect((await gw.cli("00000000-0000-0000-0000-000000000000", ["report"])).status).toBe(401);
});



test("cli run credential rejects every owner verb with the report-only boundary", async () => {
  const { runToken } = (await seededCli());
  const gw = gateway();
  for (const argv of [["new"], ["edit"], ["loops"], ["start"], ["stop"], ["delete"], ["run", "stop", "r"]]) {
    const res = (await gw.cli(runToken, argv));
    expect(res.status).toBe(403);
    expect((res.body as { text: string }).text).toMatch(/only pievo report|may only report/);
  }
});

test("cli device lifecycle: pause/start are truthful and use the store lifecycle", async () => {
  const { deviceToken, loop } = await seededCli();
  const gw = gateway();
  const paused = await gw.cli(deviceToken, ["pause", loop.id]);
  expect(paused.status).toBe(200);
  expect(textOf(paused)).toContain("loop paused; current run is finishing");
  expect((await store.getLoop(loop.id))?.enabled).toBe(false);

  const started = await gw.cli(deviceToken, ["start", loop.id]);
  expect(started.status).toBe(200);
  expect(textOf(started)).toContain("loop started");
  expect((await store.getLoop(loop.id))?.enabled).toBe(true);
});

test("cli pause wording uses the running state returned after the locked pause", async () => {
  const { deviceToken, loop } = await seededCli();
  const pausedLoop = { ...loop, enabled: false };
  const res = await gateway({
    pauseLoopState: async () => ({ loop: pausedLoop }),
  }).cli(deviceToken, ["pause", loop.id]);
  expect(res.status).toBe(200);
  expect(textOf(res)).toBe("loop paused; future runs disabled");
  expect(textOf(res)).not.toContain("current run is finishing");
});

test("cli device stop is update-gated before mutation and never falsely advertises a stop", async () => {
  const { deviceToken, loop, run } = await seededCli();
  const gw = gateway();
  const rejected = await gw.cli(deviceToken, ["stop", loop.id]);
  expect(rejected.status).toBe(426);
  expect(textOf(rejected)).toContain("Daemon upgrade required to stop a running process");
  expect((await store.getLoop(loop.id))?.enabled).toBe(true);
  expect((await store.getRun(run.id))?.cancelRequestedAt).toBeNull();

  await store.updateMachine(loop.machineId, { daemonProtocol: 4 });
  const stopped = await gw.cli(deviceToken, ["stop", loop.id]);
  expect(stopped.status).toBe(200);
  expect(textOf(stopped)).toContain("stop requested; waiting for");
  expect((await store.getLoop(loop.id))?.enabled).toBe(false);
  expect((await store.getRun(run.id))?.cancelRequestedAt).toBeTruthy();
  expect((await store.getRun(run.id))?.phase).toBe("running");
});

test("cli stop finds the requested loop's run when another loop is also running", async () => {
  const { deviceToken, machineId } = await seededCli();
  const target = await createLoop({ userId: "u1", machineId, name: "target", cron: "0 0 1 1 *", enabled: true });
  const targetRun = await store.addRun({ loopId: target.id, machineId, phase: "running", ts: new Date().toISOString() });
  await tokens.registerRunLease({ runId: targetRun.id, loopId: target.id, machineId });

  const rejected = await gateway().cli(deviceToken, ["stop", target.id]);
  expect(rejected.status).toBe(426);
  expect((await store.getLoop(target.id))?.enabled).toBe(true);
  expect((await store.getRun(targetRun.id))?.cancelRequestedAt).toBeNull();
});

test("cli delete is protocol-gated before requesting deletion when a run is active", async () => {
  const { deviceToken, loop } = await seededCli();
  const rejected = await gateway().cli(deviceToken, ["delete", loop.id]);
  expect(rejected.status).toBe(426);
  expect(textOf(rejected)).toContain("Daemon upgrade required to stop a running process");
  expect((await store.getLoop(loop.id))?.deleteRequestedAt).toBeNull();
  expect((await store.getLoop(loop.id))?.enabled).toBe(true);
});

test("cli device run stop preserves loop state and reports terminal runs truthfully", async () => {
  const { deviceToken, loop, run } = await seededCli();
  await store.updateMachine(loop.machineId, { daemonProtocol: 4 });
  const gw = gateway();
  const stopped = await gw.cli(deviceToken, ["run", "stop", run.id]);
  expect(stopped.status).toBe(200);
  expect(textOf(stopped)).toContain("stop requested; waiting for");
  expect((await store.getLoop(loop.id))?.enabled).toBe(true);
  expect((await store.getRun(run.id))?.phase).toBe("running");
});

test("cli force delete requires prior request, explicit marker, and team-owner authority", async () => {
  const { deviceToken, loop } = await seededCli();
  await store.ensureTeam("team-cli", "CLI", "u1");
  await store.updateLoop(loop.id, { teamId: "team-cli" });
  await store.updateMachine(loop.machineId, { daemonProtocol: 4 });
  const gw = gateway();

  const noRequest = await gw.cli(deviceToken, ["delete", loop.id, "--force", "--confirmation", "delete-server-data-anyway"]);
  expect(noRequest.status).toBe(409);
  expect(textOf(noRequest)).toContain("delete must be requested first");

  expect((await gw.cli(deviceToken, ["delete", loop.id])).status).toBe(200);
  const noMarker = await gw.cli(deviceToken, ["delete", loop.id, "--force"]);
  expect(noMarker.status).toBe(400);
  expect(textOf(noMarker)).toContain("force delete confirmation required");

  await store.addTeamMember("team-cli", "u2", "owner");
  expect(await store.setTeamMemberRoleGuarded("team-cli", "u1", "member")).toBe("ok");
  const notOwner = await gw.cli(deviceToken, ["delete", loop.id, "--force", "--confirmation", "delete-server-data-anyway"]);
  expect(notOwner.status).toBe(403);
  expect(textOf(notOwner)).toContain("team owner");
});

test("cli force delete logs, reports reachability truthfully, and honors a false store result", async () => {
  const first = await seededCli();
  await store.ensureTeam("team-force", "Force", "u1");
  await store.updateLoop(first.loop.id, { teamId: "team-force" });
  await store.updateMachine(first.loop.machineId, { daemonProtocol: 4, online: false, lastSeen: null });
  await store.requestDeleteLoop(first.loop.id);
  const audit: Array<Record<string, unknown>> = [];
  const forced = await gateway({ destructiveLog: (event) => audit.push(event) }).cli(first.deviceToken, [
    "delete", first.loop.id, "--force", "--confirmation", "delete-server-data-anyway",
  ]);
  expect(forced.status).toBe(200);
  expect(textOf(forced)).toContain("machine is unreachable");
  expect(audit).toEqual([expect.objectContaining({ action: "force-delete", loopId: first.loop.id, machineReachability: "offline" })]);

  const online = await seededCli();
  await store.updateLoop(online.loop.id, { teamId: "team-force" });
  await store.updateMachine(online.loop.machineId, { online: true, lastSeen: new Date().toISOString() });
  await store.requestDeleteLoop(online.loop.id);
  const onlineForced = await gateway().cli(online.deviceToken, [
    "delete", online.loop.id, "--force", "--confirmation", "delete-server-data-anyway",
  ]);
  expect(onlineForced.status).toBe(200);
  expect(textOf(onlineForced)).toContain("machine is online");
  expect(textOf(onlineForced)).not.toContain("machine is unreachable");

  const second = await seededCli();
  await store.updateLoop(second.loop.id, { teamId: "team-force" });
  await store.requestDeleteLoop(second.loop.id);
  const failed = await gateway({ forceDeleteLoop: async () => false }).cli(second.deviceToken, [
    "delete", second.loop.id, "--force", "--confirmation", "delete-server-data-anyway",
  ]);
  expect(failed.status).toBe(409);
  expect(textOf(failed)).toContain("server data was not deleted");
  expect(await store.getLoop(second.loop.id)).toBeTruthy();
});

test("cli device credential: report is run-only and removed finish verbs are unknown", async () => {
  const { deviceToken } = (await seededCli());
  const gw = gateway();
  expect((await gw.cli(deviceToken, ["report"])).status).toBe(403);
  expect((await gw.cli(deviceToken, ["finish"])).status).toBe(400);
  expect((await gw.cli(deviceToken, ["complete"])).status).toBe(400);
});













test("cli device credential: log/show of a loop on ANOTHER machine is a flat 404 (existence never leaks)", async () => {
  const { deviceToken } = (await seededCli());
  const otherDevice = tokens.mintDeviceToken();
  const otherMachineId = tokens.machineIdFromToken(otherDevice);
  (await store.createMachine({ id: otherMachineId, userId: "u2", name: "M2", tokenHash: tokens.sha256(otherDevice), online: true }));
  const otherLoop = (await createLoop({ userId: "u2", machineId: otherMachineId, name: "Other", cron: "0 0 1 1 *", enabled: true }));
  const gw = gateway();
  expect((await gw.cli(deviceToken, ["log", otherLoop.id])).status).toBe(404);
  expect((await gw.cli(deviceToken, ["show", otherLoop.id])).status).toBe(404);
});
