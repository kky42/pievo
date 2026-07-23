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
let notifyMod: typeof import("./notify.js");
let schedulerMod: typeof import("../scheduler/index.js");

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-gateway-"));
  process.env.PIEVO_DATA_DIR = tmp;
  process.env.PIEVO_DB_PATH = path.join(tmp, "test.db");
  process.env.PIEVO_LOG_LEVEL = "silent";
  db = await import("../db/index.js");
  await db.runMigrations();
  store = await import("../db/store.js");
  gatewayMod = await import("./index.js");
  cliMod = await import("./cli.js");
  tokens = await import("./tokens.js");
  notifyMod = await import("./notify.js");
  schedulerMod = await import("../scheduler/index.js");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  await (db.client as any).exec("DELETE FROM terminal_report_incidents; DELETE FROM run_report_receipts; DELETE FROM run_leases; DELETE FROM connect_keys; DELETE FROM runs; DELETE FROM loops; DELETE FROM machines;");
});

/** The core gateway MERGED with the CLI verb surface (`agentApi`/`cli` moved to
 *  `CliGateway`, constructed over the same instance - mirroring boot), so every
 *  existing call site keeps working without weakening a single assertion. */
type TestGateway = InstanceType<typeof gatewayMod.MachineGateway> &
  Pick<InstanceType<typeof cliMod.CliGateway>, "agentApi" | "cli">;

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
  notify?: (loop: any, message: string) => Promise<void>,
  cliDeps?: ConstructorParameters<typeof cliMod.CliGateway>[1],
): TestGateway {
  const core = new gatewayMod.MachineGateway(
    {
      advanceDueSchedules(): never[] { return []; },
      enqueueInitialExec(): void {},
      addLoop(): void {},
      removeLoop(): void {},
      runNow(): void {},
      requestSteer(id: string, instruction: string) {
        return store.enqueueRun(id, { role: "steer", requestedBy: "owner", requestText: instruction });
      },
    } as any,
    undefined, // default local blobstore under the test PIEVO_DATA_DIR
    notify,
  );
  const rawReport = core.report.bind(core);
  core.report = async (token, body) => rawReport(token, await withReportIds(token, body));
  const cli = new cliMod.CliGateway(core, cliDeps);
  return Object.assign(core, {
    agentApi: cli.agentApi.bind(cli),
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

function pollV3(
  gw: InstanceType<typeof gatewayMod.MachineGateway>,
  token: string,
  request: Partial<Parameters<InstanceType<typeof gatewayMod.MachineGateway>["pollV3"]>[1]> = {},
) {
  return gw.pollV3(token, {
    ...request,
    protocolVersion: 3,
    currentRuns: request.currentRuns ?? [],
    info: { version: "2.1.0", ...request.info },
  });
}

test("protocol rejection uses upgrade terminology and gives the restart flow", async () => {
  const res = await gateway().pollV3("not-a-device-token", { protocolVersion: 2, currentRuns: [] });
  expect(res.status).toBe(426);
  expect((res.body as any).error).toContain("daemon upgrade required");
  expect((res.body as any).error).toContain("npm install -g @kky42/pievo@latest");
  expect((res.body as any).error).toContain("pievo daemon restart");
  expect((res.body as any).error).not.toMatch(/update\s+required/i);
});

/** A recording notifier: captures (loopId, message) instead of pushing to a channel. */
function recordingNotify() {
  const sent: Array<{ loopId: string; message: string }> = [];
  const fn = (loop: any, message: string): Promise<void> => {
    sent.push({ loopId: loop.id, message });
    return Promise.resolve();
  };
  return { sent, fn };
}

/** Seed a loop with an exec run already RUNNING, ready for a report() call. */
async function seededExecRun(notify: "always" | "auto" | "never" = "auto") {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const loop = (await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify }));
  const run = (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: new Date().toISOString() }));
  const rt = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId, role: "exec", allowControl: false });
  return { machineId, loop, run, rt };
}

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
  const loop = (await store.createLoop({
    userId: "u1",
    machineId: machine.id,
    name: "L",
    cron: "0 0 1 1 *",
    enabled: true,
    notify: "auto",
    metricSchema: [{ key: "mrr" }],
    ui: "<h3>{{latest.mrr}}</h3>",
  }));
  const run = (await store.addRun({
    loopId: loop.id,
    userId: loop.userId,
    machineId: machine.id,
    phase: "running",
    role: "evolve",
    ts: new Date().toISOString(),
    metrics: { mrr: 10 },
  }));
  return { machine, loop, run };
}

test("set-ui is only allowed for an evolution run token and is audited", async () => {
  const { loop, machine, run } = (await seededLoop());
  const execToken = await tokens.registerRunLease({
    runId: run.id,
    loopId: loop.id,
    machineId: machine.id,
    role: "exec",
    allowControl: true,
  });
  const rejected = (await gateway().agentApi(execToken, ["set-ui", "--file-content", "<h3>Denied</h3>"]));
  expect(rejected.status).toBe(403);

  const evolveToken = await tokens.registerRunLease({
    runId: run.id,
    loopId: loop.id,
    machineId: machine.id,
    role: "evolve",
    allowControl: true,
    canSetUi: true,
  });
  const ok = (await gateway().agentApi(evolveToken, ["set-ui", "--file-content", "<h3>{{latest.mrr}}</h3>"]));
  expect(ok.status).toBe(200);
  expect((await store.getLoop(loop.id))!.ui).toBe("<h3>{{latest.mrr}}</h3>");
  expect((await store.getRun(run.id))!.control?.[0]?.command).toBe("set-ui");
  expect((await store.getRun(run.id))!.control?.[0]?.result).toBe("ok");
});

test("show reports the run's effective self-schedule capability", async () => {
  const { loop, machine, run } = (await seededLoop());
  const gw = gateway();
  const showText = async (allowControl: boolean, role: "exec" | "evolve" = "exec") => {
    const rt = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId: machine.id, role, allowControl });
    return ((await gw.agentApi(rt, ["show"])).body as { text: string }).text;
  };
  // A run that MAY self-schedule reads `allowed`; one that may not reads `off`.
  const allowed = (await showText(true));
  expect(allowed).toContain("selfSchedule: allowed");
  // cron carries spaces → TOON-quoted inside the envelope block.
  expect(allowed).toContain(`cron: "${loop.cron}"`);
  const off = (await showText(false));
  expect(off).toContain("selfSchedule: off");
  // An evolve/steer pass carries the effective (structural) capability, so it reads allowed.
  expect((await showText(true, "evolve"))).toContain("selfSchedule: allowed");
});

test("help (and a bare/unknown-flag invocation) returns role-aware usage", async () => {
  const { loop, machine, run } = (await seededLoop());
  const execToken = await tokens.registerRunLease({
    runId: run.id,
    loopId: loop.id,
    machineId: machine.id,
    role: "exec",
    allowControl: false,
  });
  const gw = gateway();
  const helpText = async (argv: string[]) => {
    const res = (await gw.agentApi(execToken, argv));
    expect(res.status).toBe(200);
    return (res.body as { text: string }).text;
  };
  for (const argv of [["help"], ["--help"], []]) {
    const text = (await helpText(argv));
    // The §4.9 TOON: a `verbs:` top key with grouped, typed lists + a trailing help[].
    expect(text).toContain("verbs:");
    expect(text).toContain("always[3]{verb,syntax}:");
    expect(text).toContain("report");
    expect(text).toContain("reschedule");
    expect(text).toContain("help[2]:");
  }
  // An exec run can't set-* or control → the availability TAGS say so, not "available".
  const execHelp = (await helpText(["help"]));
  expect(execHelp).toContain('dashboard: evolve/steer pass only — this run is "exec"');
  expect(execHelp).toContain("schedule[4]{verb,syntax}: needs allowControl (off for this loop)");
  expect(execHelp).not.toContain("finish:");

  // An evolve run with the caps sees those same tags FLIP to available.
  const evolveToken = await tokens.registerRunLease({
    runId: run.id,
    loopId: loop.id,
    machineId: machine.id,
    role: "evolve",
    allowControl: true,
    canSetUi: true,
  });
  const evolveHelp = ((await gw.agentApi(evolveToken, ["help"])).body as { text: string }).text;
  expect(evolveHelp).toContain("dashboard: available to this run");
  expect(evolveHelp).toContain("schedule[4]{verb,syntax}: available to this run");
});

test("set-schema rejects dropping keys still used by UI or recent runs", async () => {
  const { loop, machine, run } = (await seededLoop());
  const token = await tokens.registerRunLease({
    runId: run.id,
    loopId: loop.id,
    machineId: machine.id,
    role: "evolve",
    allowControl: true,
    canSetSchema: true,
  });
  const res = (await gateway().agentApi(token, ["set-schema", "--file-content", JSON.stringify([{ key: "paid" }])]));

  expect(res.status).toBe(400);
  expect((await store.getLoop(loop.id))!.metricSchema).toEqual([{ key: "mrr" }]);
  expect((await store.getRun(run.id))!.control?.[0]?.command).toBe("set-schema");
  expect((await store.getRun(run.id))!.control?.[0]?.result).toBe("rejected");
});

test("report persists normalized terminal telemetry without cost or transcript fields", async () => {
  const { loop, machine, run } = await seededLoop();
  await store.updateRun(run.id, { message: "agent callback summary" });
  const token = await tokens.registerRunLease({
    runId: run.id, loopId: loop.id, machineId: machine.id, role: "exec", allowControl: false,
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

test("machine finalization uses the already-validated report after the loop metric schema changes", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const loop = await store.createLoop({
    userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "never",
    metricSchema: [{ key: "score" }],
  });
  const run = await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: new Date().toISOString() });
  const rt = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId, role: "exec", allowControl: false });

  expect((await gateway().agentApi(rt, ["report", "--status", "kept", "--message", "measured", "--metrics", '{"score":7}'])).status).toBe(200);
  await store.updateLoop(loop.id, { metricSchema: null });

  expect((await gateway().report(rt, { result: "success", exitCode: 0 })).status).toBe(200);
  expect(await store.getRun(run.id)).toMatchObject({ phase: "done", metrics: { score: 7 }, error: null });
});

test("machine finalization turns a successful process into an error when the run skipped its required report", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const loop = await store.createLoop({
    userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "never",
    metricSchema: [{ key: "score" }, { key: "delta" }],
  });
  const run = await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: new Date().toISOString() });
  const rt = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId, role: "exec", allowControl: false });

  const res = await gateway().report(rt, { result: "success", exitCode: 0, finalText: "provider claimed success" });
  expect(res.status).toBe(200);
  expect(await store.getRun(run.id)).toMatchObject({
    phase: "error",
    status: null,
    message: null,
    metrics: null,
    error: "run protocol incomplete: missing status, message",
  });
});

test("report terminalizes the leased run when payload runId does not match", async () => {
  const { loop, machine, run } = await seededLoop();
  const token = await tokens.registerRunLease({
    runId: run.id, loopId: loop.id, machineId: machine.id, role: "exec", allowControl: false,
  });
  const response = await gateway().report(token, { runId: "run-other", result: "success" as const });
  expect(response).toMatchObject({ status: 200, body: { accepted: false, code: "REPORT_INVALID", disposition: "run-error" } });
  expect(await store.getRun(run.id)).toMatchObject({ phase: "error", reportIncident: { code: "REPORT_INVALID" } });
  expect(await tokens.resolveLease(token)).toBeUndefined();
});

test("report syncs the machine's task file content onto the loop", async () => {
  const { loop, machine, run } = (await seededLoop());
  const token = await tokens.registerRunLease({
    runId: run.id,
    loopId: loop.id,
    machineId: machine.id,
    role: "exec",
    allowControl: false,
  });
  const res = (await gateway().report(token, {
    result: "success" as const,
    durationMs: 1000,
    taskFileContent: "# Breakfast log\n2026-06-19: 4g dispensed\n",
  }));
  expect(res.status).toBe(200);

  const stored = (await store.getLoop(loop.id));
  expect(stored?.taskFileContent).toBe("# Breakfast log\n2026-06-19: 4g dispensed\n");
  expect(stored?.taskFileSyncedAt).toBeTruthy();
});


test("a machine's bound loops gate its deletion (loopsForMachine drains to empty)", async () => {
  const { machine, loop } = (await seededLoop());
  // While a loop is bound, the delete guard sees it and must block.
  expect((await store.loopsForMachine(machine.id)).map((l) => l.id)).toEqual([loop.id]);
  // An executing loop requires explicit authority retirement before deletion.
  (await store.forceDeleteLoop(loop.id));
  expect((await store.loopsForMachine(machine.id))).toHaveLength(0);
  expect((await store.deleteMachine(machine.id))).toBe(true);
});

test("createLoop persists a valid IANA timezone and rejects a bogus one", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));

  const ok = (await gateway().createLoop(token, {
    name: "Morning report",
    cron: "0 8 * * *",
    timezone: "Asia/Shanghai",
    taskFile: "pievo/x/README.md",
  }));
  expect(ok.status).toBe(200);
  expect((await store.getLoop((ok.body as any).id))!.timezone).toBe("Asia/Shanghai");

  const bad = (await gateway().createLoop(token, {
    name: "Bad tz",
    cron: "0 8 * * *",
    timezone: "Mars/Phobos",
    taskFile: "pievo/x/README.md",
  }));
  expect(bad.status).toBe(400);
  expect((bad.body as any).error).toMatch(/invalid timezone/);
});

test("continuous cadence is goal-orthogonal, validates delay >=1, and preserves cron when switching modes", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });

  const created = await gateway().createLoop(token, {
    name: "Continuous monitor",
    cron: "0 8 * * *",
    scheduleMode: "continuous",
    continuousDelayMinutes: 2,
    taskFile: "pievo/x/README.md",
  });
  expect(created.status).toBe(200);
  const id = (created.body as { id: string }).id;
  expect(await store.getLoop(id)).toMatchObject({
    scheduleMode: "continuous",
    continuousDelayMinutes: 2,
    cron: "0 8 * * *",
    goal: null,
  });

  const invalid = await gateway().createLoop(token, {
    cron: "0 8 * * *",
    scheduleMode: "continuous",
    continuousDelayMinutes: 0,
    taskFile: "x",
  });
  expect(invalid.status).toBe(400);
  expect((invalid.body as { error: string }).error).toContain(">= 1");

  expect((await gateway().editLoop(token, id, { scheduleMode: "cron" })).status).toBe(200);
  expect(await store.getLoop(id)).toMatchObject({ scheduleMode: "cron", cron: "0 8 * * *" });
});

test("owner cadence edits and run-token resume synchronously persist facts then re-arm hints", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const loop = await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 8 * * *", enabled: true, notify: "auto" });
  const added: string[] = [];
  const scheduler = {
    addLoop(l: { id: string }): void { added.push(l.id); },
    removeLoop(): void {}, enqueueInitialExec(): void {}, runNow(): void {}, advanceDueSchedules(): void {},
  } as any;
  const core = new gatewayMod.MachineGateway(scheduler);
  expect((await core.editLoop(token, loop.id, { scheduleMode: "continuous" })).status).toBe(200);
  expect((await store.getLoop(loop.id))!.nextCadenceAt).toBeTruthy();

  await store.updateLoop(loop.id, { enabled: false });
  const editRun = await store.addRun({
    loopId: loop.id, userId: "u1", machineId, phase: "running", role: "steer", requestedBy: "owner", ts: new Date().toISOString(),
  });
  const rt = await tokens.registerRunLease({ runId: editRun.id, loopId: loop.id, machineId, role: "steer", allowControl: true });
  const cli = new cliMod.CliGateway(core);
  expect((await cli.agentApi(rt, ["resume"])).status).toBe(200);
  expect((await store.getLoop(loop.id))!.enabled).toBe(true);

  await store.updateRun(editRun.id, { phase: "canceled" });
  await tokens.retireLease(rt);
  const editRun2 = await store.addRun({
    loopId: loop.id, userId: "u1", machineId, phase: "running", role: "steer", requestedBy: "owner", ts: new Date().toISOString(),
  });
  const rt2 = await tokens.registerRunLease({ runId: editRun2.id, loopId: loop.id, machineId, role: "steer", allowControl: true });
  expect((await cli.agentApi(rt2, ["set-schedule", "continuous", "--delay-minutes", "20"])).status).toBe(200);
  expect(added).toEqual([loop.id, loop.id, loop.id]);
});

test("createLoop records the coding agent: codex when declared, claude-code by default, and degrades an unknown value", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));

  // Explicit codex (the daemon's measured env / --agent codex) is persisted verbatim.
  const codex = (await gateway().createLoop(token, { name: "Codex loop", cron: "0 8 * * *", taskFile: "pievo/x/README.md", agent: "codex" }));
  expect(codex.status).toBe(200);
  expect((await store.getLoop((codex.body as any).id))!.agent).toBe("codex");

  // Absent agent (older daemon) back-fills to claude-code via the column default.
  const legacy = (await gateway().createLoop(token, { name: "Legacy loop", cron: "0 8 * * *", taskFile: "pievo/x/README.md" }));
  expect(legacy.status).toBe(200);
  expect((await store.getLoop((legacy.body as any).id))!.agent).toBe("claude-code");

  // An unrecognized / "unknown" value degrades to the default rather than rejecting.
  const weird = (await gateway().createLoop(token, { name: "Weird loop", cron: "0 8 * * *", taskFile: "pievo/x/README.md", agent: "unknown" }));
  expect(weird.status).toBe(200);
  expect((await store.getLoop((weird.body as any).id))!.agent).toBe("claude-code");

  // A daemon that still explicitly requests the retired executor must fail loud,
  // never silently create a loop that runs through a different CLI.
  const retired = await gateway().createLoop(token, {
    name: "Retired agent loop", cron: "0 8 * * *", taskFile: "pievo/x/README.md", agent: "grok",
  });
  expect(retired.status).toBe(400);
  expect((retired.body as any).error).toContain("support was removed");
});


test("createLoop surfaces a DROPPED ui loudly — provided but validated to nothing, never silent", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));

  // A whitespace-only ui coerces to null: the loop is still created, but the response
  // echoes ui:false AND a warning so a dropped dashboard is never a silent no-op.
  const res = (await gateway().createLoop(token, { name: "NoDash", cron: "0 5 * * *", taskFile: "x", ui: "   " }));
  expect(res.status).toBe(200);
  const b = res.body as any;
  expect(b.ui).toBe(false);
  expect(b.warning).toMatch(/not applied|without a dashboard/i);
  expect((await store.getLoop(b.id))!.ui).toBeNull();

  // Same surfacing on the dry-run path (warning at top level).
  const dry = (await gateway().createLoop(token, { cron: "0 5 * * *", taskFile: "x", ui: "   ", dryRun: true }));
  expect((dry.body as any).config.ui).toBe(false);
  expect((dry.body as any).warning).toMatch(/not applied|without a dashboard/i);

  // No warning when no ui was provided at all (a blank loop is not a dropped dashboard).
  const plain = (await gateway().createLoop(token, { cron: "0 5 * * *", taskFile: "x" }));
  expect((plain.body as any).warning).toBeUndefined();
  expect((plain.body as any).ui).toBe(false);
});

test("editLoop changes a loop's envelope from its machine's device token", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const created = (await gateway().createLoop(token, { name: "Daily", cron: "0 8 * * *", taskFile: "pievo/x/README.md" }));
  const id = (created.body as any).id as string;

  const res = (await gateway().editLoop(token, id, { cron: "0 9 * * *", notify: "always", enabled: false }));
  expect(res.status).toBe(200);
  expect((res.body as any).applied).toEqual(expect.arrayContaining(["cron", "notify", "enabled"]));
  const loop = (await store.getLoop(id))!;
  expect(loop.cron).toBe("0 9 * * *");
  expect(loop.notify).toBe("always");
  expect(loop.enabled).toBe(false);

  // A bogus cron is rejected and leaves the loop untouched.
  const bad = (await gateway().editLoop(token, id, { cron: "not a cron" }));
  expect(bad.status).toBe(400);
  expect((await store.getLoop(id))!.cron).toBe("0 9 * * *");
});

test("editLoop changes the coding agent to a known enum value", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const created = (await gateway().createLoop(token, { name: "A", cron: "0 8 * * *", taskFile: "pievo/x/README.md" }));
  const id = (created.body as any).id as string;
  // Defaults to claude-code at create (no agent on the create body).
  expect((await store.getLoop(id))!.agent).toBe("claude-code");

  const res = (await gateway().editLoop(token, id, { agent: "codex" }));
  expect(res.status).toBe(200);
  expect((res.body as any).applied).toEqual(expect.arrayContaining(["agent"]));
  expect((await store.getLoop(id))!.agent).toBe("codex");
});

test("editLoop rejects an unknown coding agent with a clear per-key message (loop untouched)", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const created = (await gateway().createLoop(token, { name: "A", cron: "0 8 * * *", taskFile: "pievo/x/README.md" }));
  const id = (created.body as any).id as string;

  const bad = (await gateway().editLoop(token, id, { agent: "emacs" } as any));
  expect(bad.status).toBe(400);
  expect((bad.body as any).error).toMatch(/agent must be one of/);
  // The rejection leaves the recorded agent at its create-time default.
  expect((await store.getLoop(id))!.agent).toBe("claude-code");
});

test("cli edit --json '{\"agent\":...}' changes the loop's recorded agent (the CLI forwards verbatim)", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const created = (await gateway().cli(token, ["new", "--json", JSON.stringify({ name: "A", cron: "0 8 * * *", taskFile: "pievo/x/README.md" })]));
  const id = idIn(created);

  const res = (await gateway().cli(token, ["edit", id, "--json", JSON.stringify({ agent: "codex" })]));
  expect(res.status).toBe(200);
  expect((await store.getLoop(id))!.agent).toBe("codex");

  // An unknown agent over the same CLI path fails loud (exit 1) and never persists.
  const bad = (await gateway().cli(token, ["edit", id, "--json", JSON.stringify({ agent: "nope" })]));
  expect(bad.status).toBe(400);
  expect((await store.getLoop(id))!.agent).toBe("codex");
});


test("editLoop accepts metricSchema as a JSON string too (run-token parity)", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const created = (await gateway().createLoop(token, { name: "S", cron: "0 8 * * *", taskFile: "pievo/x/README.md" }));
  const id = (created.body as any).id as string;

  const res = (await gateway().editLoop(token, id, { metricSchema: '[{"key":"visits","label":"Visits"}]' } as any));
  expect(res.status).toBe(200);
  expect((await store.getLoop(id))!.metricSchema).toEqual([{ key: "visits", label: "Visits" }]);
});

test("editLoop validates content fields (bad schema → 400, loop untouched)", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const created = (await gateway().createLoop(token, { name: "S", cron: "0 8 * * *", taskFile: "pievo/x/README.md" }));
  const id = (created.body as any).id as string;

  const bad = (await gateway().editLoop(token, id, { metricSchema: [{ notKey: 1 }] } as any));
  expect(bad.status).toBe(400);
  expect((await store.getLoop(id))!.metricSchema).toBeNull();
});

test("metric schemas reject duplicate normalized keys on create, edit, and set-schema", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const duplicate = [{ key: "latency" }, { key: " latency ", label: "Duplicate after trim" }];

  const create = await gateway().createLoop(token, {
    name: "Bad schema",
    cron: "0 8 * * *",
    taskFile: "pievo/x/README.md",
    metricSchema: duplicate,
  });
  expect(create.status).toBe(400);
  expect((create.body as any).error).toContain("duplicate metric key: latency");

  const created = await gateway().createLoop(token, { name: "Valid", cron: "0 8 * * *", taskFile: "pievo/x/README.md" });
  const id = (created.body as any).id as string;
  const edit = await gateway().editLoop(token, id, { metricSchema: duplicate });
  expect(edit.status).toBe(400);
  expect((edit.body as any).error).toContain("duplicate metric key: latency");

  const run = await store.addRun({
    loopId: id,
    userId: "u1",
    machineId,
    phase: "running",
    role: "evolve",
    requestedBy: "owner",
    ts: new Date().toISOString(),
  });
  const runToken = await tokens.registerRunLease({
    runId: run.id,
    loopId: id,
    machineId,
    role: "evolve",
    allowControl: true,
    canSetSchema: true,
  });
  const setSchema = await gateway().agentApi(runToken, ["set-schema", "--file-content", JSON.stringify(duplicate)]);
  expect(setSchema.status).toBe(400);
  expect((setSchema.body as any).text).toContain("duplicate metric key: latency");
  expect((await store.getLoop(id))!.metricSchema).toBeNull();
});


test("editLoop rejects an unknown patch key with a clear 400 (never silent no-op)", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const created = (await gateway().createLoop(token, { name: "S", cron: "0 8 * * *", taskFile: "pievo/x/README.md" }));
  const id = (created.body as any).id as string;

  // A typo (or an attempt to patch an identity column) fails loudly.
  const res = (await gateway().editLoop(token, id, { teamId: "other", croon: "0 9 * * *" } as any));
  expect(res.status).toBe(400);
  expect((res.body as any).error).toMatch(/unknown field/);
  expect((res.body as any).error).toMatch(/teamId/);
  // Nothing changed.
  expect((await store.getLoop(id))!.cron).toBe("0 8 * * *");
});

test("editLoop refuses a loop bound to a different machine (404, no change)", async () => {
  const tokenA = tokens.mintDeviceToken();
  const machineA = tokens.machineIdFromToken(tokenA);
  (await store.createMachine({ id: machineA, userId: "u1", name: "A", tokenHash: tokens.sha256(tokenA), online: true }));
  const created = (await gateway().createLoop(tokenA, { name: "Owned", cron: "0 8 * * *", taskFile: "pievo/x/README.md" }));
  const id = (created.body as any).id as string;

  const tokenB = tokens.mintDeviceToken();
  const machineB = tokens.machineIdFromToken(tokenB);
  (await store.createMachine({ id: machineB, userId: "u2", name: "B", tokenHash: tokens.sha256(tokenB), online: true }));

  const res = (await gateway().editLoop(tokenB, id, { cron: "*/5 * * * *" }));
  expect(res.status).toBe(404);
  expect((await store.getLoop(id))!.cron).toBe("0 8 * * *"); // untouched
});

test("concurrent polls deliver a pending run exactly once (atomic pending->running claim)", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const loop = (await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto" }));
  const run = (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "pending", role: "exec", ts: new Date().toISOString() }));

  // Two polls in flight at once (an HTTP retry racing its timed-out original, or
  // two daemons sharing one device token = the same machineId). The conditional
  // pending->running claim must let exactly ONE of them deliver the run - the old
  // unconditional read-then-write let both, double-executing it on the machine.
  const gw = gateway();
  const results = await Promise.all([pollV3(gw, token), pollV3(gw, token)]);
  const delivered = results
    .map((r) => (r.body as { delivery: { runId: string } | null }).delivery)
    .filter((delivery): delivery is { runId: string } => delivery !== null);
  expect(delivered.filter((d) => d.runId === run.id)).toHaveLength(1);
  expect((await store.getRun(run.id))!.phase).toBe("running");

  // A later poll sees the run as already claimed - no re-delivery, no error.
  const again = await pollV3(gw, token, { currentRuns: [{ runId: run.id, stage: "executing" }] });
  expect((again.body as any).delivery).toBeNull();
});

test("pollV3 with an old or unknown daemon version does not claim pending work", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const loop = await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto" });
  const run = await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "pending", role: "exec", ts: new Date().toISOString() });

  const unknown = await gateway().pollV3(token, { protocolVersion: 3, currentRuns: [], info: { host: "mac" } });
  expect(unknown.status).toBe(200);
  expect((unknown.body as any).delivery).toBeNull();
  expect((unknown.body as any).needsUpdate.current).toBeNull();
  expect((await store.getRun(run.id))!.phase).toBe("pending");

  const old = await gateway().pollV3(token, { protocolVersion: 3, currentRuns: [], info: { host: "mac", version: "2.0.2" } });
  expect(old.status).toBe(200);
  expect((old.body as any).delivery).toBeNull();
  expect((old.body as any).needsUpdate).toMatchObject({ current: "2.0.2", required: "2.1.0" });
  expect((await store.getRun(run.id))!.phase).toBe("pending");
});

test("pollV3 with a compatible daemon version can claim pending work", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const loop = await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto", model: "snapshot-model", reasoningEffort: "high", agent: "codex" });
  const run = await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "pending", role: "exec", ts: new Date().toISOString() });

  const res = await gateway().pollV3(token, { protocolVersion: 3, currentRuns: [], info: { host: "mac", version: "2.1.0" } });
  expect(res.status).toBe(200);
  expect((res.body as any).delivery).toMatchObject({ runId: run.id, runIndex: 1 });
  expect((res.body as any).needsUpdate).toBeUndefined();
  expect((await store.getRun(run.id))!).toMatchObject({ phase: "running", runIndex: 1, agent: "codex", model: "snapshot-model", reasoningEffort: "high" });
});

test("poll claims only one ready run per loop and honors steer > evolve > exec", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const loop = await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto" });
  await store.enqueueRun(loop.id, { role: "exec", requestedBy: "system" });
  await store.enqueueRun(loop.id, { role: "evolve", requestedBy: "owner" });
  await store.enqueueRun(loop.id, { role: "steer", requestedBy: "owner", requestText: "latest" });

  const gw = gateway();
  const first = (await pollV3(gw, token)).body as { delivery: { runId: string; role: string; task: string; runToken: string } | null };
  expect(first.delivery).not.toBeNull();
  expect(first.delivery!.role).toBe("steer");
  expect(first.delivery!.task).toContain("latest");
  expect((await store.openRunsForLoop(loop.id)).filter((r) => r.phase === "pending")).toHaveLength(2);

  // Even a second poll cannot drain the other roles while steer is running.
  const whileSteering = await pollV3(gw, token, { currentRuns: [{ runId: first.delivery!.runId, stage: "executing" }] });
  expect((whileSteering.body as any).delivery).toBeNull();
  await store.updateRun(first.delivery!.runId, { phase: "done" });
  await tokens.retireLease(first.delivery!.runToken);
  const second = (await pollV3(gw, token)).body as { delivery: { role: string } | null };
  expect(second.delivery?.role).toBe("evolve");
});

test("set-tz applies the timezone through an allowControl run token", async () => {
  const { loop, machine, run } = (await seededLoop());
  const token = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId: machine.id, role: "steer", allowControl: true });
  const res = (await gateway().agentApi(token, ["set-tz", "Asia/Tokyo"]));
  expect(res.status).toBe(200);
  expect((await store.getLoop(loop.id))!.timezone).toBe("Asia/Tokyo");

  const bad = (await gateway().agentApi(token, ["set-tz", "Mars/Phobos"]));
  expect(bad.status).toBe(400);
  expect((await store.getLoop(loop.id))!.timezone).toBe("Asia/Tokyo"); // unchanged
});

test("finishing running steer A does not clear queued steer B", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const loop = await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto" });
  const run = await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "steer", requestedBy: "owner", requestText: "A", ts: new Date().toISOString() });
  const followUp = await store.enqueueRun(loop.id, { role: "steer", requestedBy: "owner", requestText: "B" });
  const rt = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId, role: "steer", allowControl: true });

  const res = await gateway().report(rt, { result: "success" as const, durationMs: 5 });
  expect(res.status).toBe(200);
  expect("run" in followUp).toBe(true);
  const waiting = (await store.openRunsForLoop(loop.id)).find((r) => r.phase === "pending" && r.role === "steer");
  expect(waiting).toMatchObject({ requestText: "B", requestedBy: "owner" });
});

// ---- per-team connect-key: createLoop resolves the team from the claim intent ----

test("createLoop lands the loop in the connect-key's team, not the machine's home team (existing-machine reuse)", async () => {
  (await makeTeam("team-reuse", ["u1"]));
  // The machine's durable identity (home team = its personal team).
  const deviceToken = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(deviceToken);
  (await store.createMachine({ id: machineId, userId: "u1", teamId: "team-u1", name: "M", tokenHash: tokens.sha256(deviceToken), online: true }));
  // Team B's fresh connect-key (a different token than the device identity), minted
  // under team B — this is the realistic "one machine, second team" capture path.
  const connectKey = tokens.mintDeviceToken();
  await tokens.rememberConnectKey(connectKey, { userId: "u1", teamId: "team-reuse" });

  const res = (await gateway().createLoop(deviceToken, { name: "B loop", cron: "0 8 * * *", taskFile: "pievo/x/README.md", claim: connectKey }));
  expect(res.status).toBe(200);
  expect((await store.getLoop((res.body as any).id))!.teamId).toBe("team-reuse");
});

test("createLoop rejects (403) a claim minted by a different user — fail closed, nothing created", async () => {
  (await makeTeam("team-x", ["u2"]));
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", teamId: "team-u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  await tokens.rememberConnectKey(token, { userId: "u2", teamId: "team-x" }); // minted by someone else

  const res = (await gateway().createLoop(token, { cron: "0 8 * * *", taskFile: "pievo/x/README.md", claim: token }));
  expect(res.status).toBe(403);
  expect((await store.listLoops()).length).toBe(0); // never mis-filed
});

test("createLoop rejects (403) when the minter is no longer a member of the claim team", async () => {
  (await makeTeam("team-y", [])); // team exists, u1 is NOT a member
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", teamId: "team-u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  await tokens.rememberConnectKey(token, { userId: "u1", teamId: "team-y" });

  const res = (await gateway().createLoop(token, { cron: "0 8 * * *", taskFile: "pievo/x/README.md", claim: token }));
  expect(res.status).toBe(403);
  expect((await store.listLoops()).length).toBe(0);
});

test("createLoop with no claim falls back to the machine's home team (back-compat)", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", teamId: "team-home", name: "M", tokenHash: tokens.sha256(token), online: true }));

  const res = (await gateway().createLoop(token, { cron: "0 8 * * *", taskFile: "pievo/x/README.md" }));
  expect(res.status).toBe(200);
  expect((await store.getLoop((res.body as any).id))!.teamId).toBe("team-home");
});

test("createLoop with a claim for the machine's OWN home team needs no membership re-check (open-mode path)", async () => {
  // Mirrors open mode: intent team === home team, so the cross-team gate is skipped
  // and no team_members row is required (there is none for the shared user).
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "shared", teamId: "team-shared", name: "M", tokenHash: tokens.sha256(token), online: true }));
  await tokens.rememberConnectKey(token, { userId: "shared", teamId: "team-shared" });

  const res = (await gateway().createLoop(token, { cron: "0 8 * * *", taskFile: "pievo/x/README.md", claim: token }));
  expect(res.status).toBe(200);
  expect((await store.getLoop((res.body as any).id))!.teamId).toBe("team-shared");
});

test("claimStatus surfaces the MEASURED agent so the New-loop confirmation shows what actually ran", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const claim = "ck_confirm_agent";

  // The daemon measured Codex on the host and sent it on the create; the claim
  // result must carry that recorded value (not a removed dialog pre-selection).
  const res = (await gateway().createLoop(token, { name: "Codex loop", cron: "0 8 * * *", taskFile: "pievo/x/README.md", agent: "codex", claim }));
  expect(res.status).toBe(200);
  expect(gateway().claimStatus(claim)?.agent).toBe("codex");
});

test("listMachinesForTeam is membership-scoped — a machine shows in its owner's team regardless of its home team", async () => {
  (await makeTeam("team-lm", ["u1"])); // only u1 is a member
  const t1 = tokens.mintDeviceToken();
  const m1 = tokens.machineIdFromToken(t1);
  (await store.createMachine({ id: m1, userId: "u1", teamId: "team-u1", name: "Mine", tokenHash: tokens.sha256(t1), online: true }));
  const t2 = tokens.mintDeviceToken();
  (await store.createMachine({ id: tokens.machineIdFromToken(t2), userId: "u2", teamId: "team-u2", name: "Other", tokenHash: tokens.sha256(t2), online: true }));

  // u1's machine (home team-u1) appears under team-lm via membership; u2's doesn't.
  expect((await store.listMachinesForTeam("team-lm")).map((m) => m.id)).toEqual([m1]);
});









// ---- standing objective: goal never terminalizes the loop ----

test("goal is a standing objective and finish/complete are not run verbs", async () => {
  const { loop, rt } = await seededClosedRun();
  const gw = gateway();

  for (const verb of ["finish", "complete"]) {
    const res = await gw.cli(rt, [verb, "--message", "done"]);
    expect(res.status).toBe(400);
    expect(textOf(res)).toContain(`unknown command \\"${verb}\\"`);
  }
  const show = textOf(await gw.cli(rt, ["show"]));
  expect(show).toContain(`goal: "${loop.goal}"`);
  expect(show).not.toContain("selfFinish");
  expect(show).not.toContain("closed");
  expect((await store.getLoop(loop.id))!.enabled).toBe(true);
});

/** A machine + a goal-bearing loop with an exec run RUNNING. */
async function seededClosedRun(opts: { notify?: "always" | "auto" | "never"; goal?: string | null } = {}) {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const goal = opts.goal === undefined ? "reach the goal" : opts.goal;
  const loop = (await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: opts.notify ?? "auto", goal }));
  const run = (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: new Date().toISOString() }));
  const rt = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId, role: "exec", allowControl: true });
  return { token, machineId, loop, run, rt };
}

// ---- --dry-run: validate-only preview for new + edit (no persistence) ----

/** A connected machine + its device token, for the dry-run tests. */
async function seededMachine() {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  return { token, machineId };
}


test("createLoop --dry-run treats goal as ordinary standing configuration", async () => {
  const { token } = (await seededMachine());
  const res = (await gateway().createLoop(token, { cron: "0 8 * * *", taskFile: "x", goal: "improve score", dryRun: true }));
  expect((res.body as any).config.goal).toBe("improve score");
  expect((res.body as any).classification).toBeUndefined();
});

test("createLoop --dry-run still validates (bad cron → 400, nothing created)", async () => {
  const { token, machineId } = (await seededMachine());
  const res = (await gateway().createLoop(token, { cron: "not a cron", taskFile: "x", dryRun: true }));
  expect(res.status).toBe(400);
  expect((await store.loopsForMachine(machineId))).toHaveLength(0);
});


test("editLoop --dry-run previews per-key before→after and persists nothing", async () => {
  const { token } = (await seededMachine());
  const created = (await gateway().createLoop(token, { name: "E", cron: "0 8 * * *", taskFile: "x" }));
  const id = (created.body as any).id as string;
  const res = (await gateway().editLoop(token, id, { cron: "0 9 * * *", notify: "always" }, true));
  expect(res.status).toBe(200);
  const b = res.body as any;
  expect(b.dryRun).toBe(true);
  expect(b.ok).toBe(true);
  const changes = b.changes as Array<{ key: string; from: unknown; to: unknown }>;
  expect(changes.find((c) => c.key === "cron")).toEqual({ key: "cron", from: "0 8 * * *", to: "0 9 * * *" });
  expect(changes.find((c) => c.key === "notify")?.to).toBe("always");
  // Not persisted.
  expect((await store.getLoop(id))!.cron).toBe("0 8 * * *");
  expect((await store.getLoop(id))!.notify).toBe("auto");
});

test("editLoop --dry-run reports whitelist + invalid-value rejections (ok:false), changes nothing", async () => {
  const { token } = (await seededMachine());
  const created = (await gateway().createLoop(token, { name: "E", cron: "0 8 * * *", taskFile: "x" }));
  const id = (created.body as any).id as string;
  const res = (await gateway().editLoop(token, id, { croon: "x", cron: "not a cron" } as any, true));
  expect(res.status).toBe(200);
  const b = res.body as any;
  expect(b.dryRun).toBe(true);
  expect(b.ok).toBe(false);
  const keys = (b.rejections as Array<{ key: string }>).map((r) => r.key);
  expect(keys).toContain("croon"); // whitelist rejection
  expect(keys).toContain("cron"); // invalid-value rejection
  expect((await store.getLoop(id))!.cron).toBe("0 8 * * *");
});


// ---- self-schedule cadence floors (RUN path only; the owner's edit path is unlimited) ----

test("set-schedule applies the run cadence floor to continuous delay and the retained cron", async () => {
  const { loop, machine, run } = await seededLoop();
  const rt = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId: machine.id, role: "steer", allowControl: true });
  const gw = gateway();

  const tooFastContinuous = await gw.agentApi(rt, ["set-schedule", "continuous", "--delay-minutes", "3"]);
  expect(tooFastContinuous.status).toBe(400);
  expect((tooFastContinuous.body as { text: string }).text).toMatch(/15 min/);
  expect((await store.getLoop(loop.id))!.scheduleMode).toBe("cron");

  const continuous = await gw.agentApi(rt, ["set-schedule", "continuous", "--delay-minutes", "20"]);
  expect(continuous.status).toBe(200);
  expect(await store.getLoop(loop.id)).toMatchObject({ scheduleMode: "continuous", continuousDelayMinutes: 20, cron: loop.cron });

  await store.updateLoop(loop.id, { cron: "*/5 * * * *" }); // owner path is unlimited
  const tooFastCron = await gw.agentApi(rt, ["set-schedule", "cron"]);
  expect(tooFastCron.status).toBe(400);
  expect((tooFastCron.body as { text: string }).text).toMatch(/15 min/);
  expect((await store.getLoop(loop.id))!.scheduleMode).toBe("continuous");

  await store.updateLoop(loop.id, { cron: "*/20 * * * *" });
  expect((await gw.agentApi(rt, ["set-schedule", "cron"])).status).toBe(200);
  expect(await store.getLoop(loop.id)).toMatchObject({ scheduleMode: "cron", cron: "*/20 * * * *" });
});

test("set-cron floor: a run can't schedule more often than 15 min; the owner's edit can", async () => {
  const { loop, machine, run } = (await seededLoop());
  const rt = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId: machine.id, role: "exec", allowControl: true });

  // Every 5 minutes is under the 15-min self floor → rejected, cron unchanged.
  const denied = (await gateway().agentApi(rt, ["set-cron", "*/5 * * * *"]));
  expect(denied.status).toBe(400);
  expect((denied.body as { text: string }).text).toMatch(/15 min/);
  expect((await store.getLoop(loop.id))!.cron).toBe("0 0 1 1 *");

  // Every 20 minutes clears the floor.
  expect((await gateway().agentApi(rt, ["set-cron", "*/20 * * * *"])).status).toBe(200);
  expect((await store.getLoop(loop.id))!.cron).toBe("*/20 * * * *");

  // The OWNER's editLoop path is unlimited — the same dense cron is accepted.
  const deviceToken = tokens.mintDeviceToken();
  const dm = tokens.machineIdFromToken(deviceToken);
  (await store.createMachine({ id: dm, userId: "u2", name: "D", tokenHash: tokens.sha256(deviceToken), online: true }));
  const owned = (await gateway().createLoop(deviceToken, { name: "Owned", cron: "0 8 * * *", taskFile: "pievo/x/README.md" }));
  const oid = (owned.body as any).id as string;
  expect((await gateway().editLoop(deviceToken, oid, { cron: "*/5 * * * *" })).status).toBe(200);
  expect((await store.getLoop(oid))!.cron).toBe("*/5 * * * *");
});

test("set-cron floor is timezone-aware (probes adjacent fires in the loop's tz)", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const loop = (await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", timezone: "Asia/Tokyo", enabled: true, notify: "auto" }));
  const run = (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: new Date().toISOString() }));
  const rt = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId, role: "exec", allowControl: true });

  // A daily cron (adjacent fires 24h apart, well over the floor) is accepted.
  expect((await gateway().agentApi(rt, ["set-cron", "0 9 * * *"])).status).toBe(200);
  // A 2-minute cron is under the floor → rejected.
  expect((await gateway().agentApi(rt, ["set-cron", "*/2 * * * *"])).status).toBe(400);
});

test("reschedule floor: a run can't reschedule sooner than 5 min out", async () => {
  const { loop, machine, run } = (await seededLoop());
  const rt = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId: machine.id, role: "exec", allowControl: true });

  // 2 minutes out is under the 5-min floor → rejected, nextRunAt unchanged.
  const denied = (await gateway().agentApi(rt, ["reschedule", "--next", "2m"]));
  expect(denied.status).toBe(400);
  expect((denied.body as { text: string }).text).toMatch(/5 min/);
  expect((await store.getLoop(loop.id))!.nextRunAt).toBeNull();

  // 30 minutes out clears the floor.
  expect((await gateway().agentApi(rt, ["reschedule", "--next", "30m"])).status).toBe(200);
  expect((await store.getLoop(loop.id))!.nextRunAt).toBeTruthy();
});

test("show reports the standing objective without self-finish capability", async () => {
  const { loop, rt } = (await seededClosedRun());
  const text = ((await gateway().agentApi(rt, ["show"])).body as { text: string }).text;
  expect(text).toContain('goal: "reach the goal"');
  expect(text).not.toContain("selfFinish");
  expect(loop.goal).toBe("reach the goal");
});

// ---- failure visibility / alerting (notify on run failure + machine-offline) ----

/** Add a finalized exec run with an explicit ts (deterministic streak ordering). */
async function addExecRun(loopId: string, machineId: string, phase: "done" | "error", ts: string) {
  return (await store.addRun({ loopId, userId: "u1", machineId, phase, role: "exec", ts }));
}

test("a FAILED exec run notifies the user (first failure of a streak)", async () => {
  const { loop, rt } = (await seededExecRun());
  const { sent, fn } = recordingNotify();

  const res = (await gateway(fn).report(rt, { result: "failure" as const, error: "claude exited 1", durationMs: 5 }));
  expect(res.status).toBe(200);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.loopId).toBe(loop.id);
  expect(sent[0]!.message).toContain("Run failed");
  expect(sent[0]!.message).toContain("claude exited 1");
});


test("repeated consecutive failures are anti-spam'd: notify on the 1st and every Nth, not every tick", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const loop = (await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto" }));
  const { sent, fn } = recordingNotify();
  const gw = gateway(fn);

  // 12 synthetic consecutive failures. The default circuit breaker adds its
  // one auto-pause note at streak 3; ordinary failure alerts stay anti-spam'd at
  // streaks 1, 5, and 10 → exactly 4 pushes (not 12).
  for (let i = 1; i <= 12; i++) {
    const run = await store.addRun({
      loopId: loop.id,
      userId: "u1",
      machineId,
      phase: "running",
      role: "exec",
      requestedBy: "system",
      ts: `2026-06-01T00:00:${String(i).padStart(2, "0")}Z`,
    });
    const rt = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId, role: "exec", allowControl: false });
    (await gw.report(rt, { result: "failure" as const, error: "boom", durationMs: 1 }));
  }
  expect(sent).toHaveLength(4);
});

test("a success between failures resets the streak so the next failure re-alerts (transition)", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const loop = (await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto" }));
  const { sent, fn } = recordingNotify();

  // Prior history: a failure, then a success (the streak is broken at the success).
  (await addExecRun(loop.id, machineId, "error", "2026-06-01T00:00:01Z"));
  (await addExecRun(loop.id, machineId, "done", "2026-06-01T00:00:02Z"));

  // Now a fresh failure → streak is 1 again → it must re-alert.
  const run = (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: "2026-06-01T00:00:03Z" }));
  const rt = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId, role: "exec", allowControl: false });
  (await gateway(fn).report(rt, { result: "failure" as const, error: "boom", durationMs: 1 }));

  expect(sent).toHaveLength(1);
});

test("evolve and steer run failures never produce user-facing failure notifications", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const loop = (await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "always" }));
  const { sent, fn } = recordingNotify();
  const gw = gateway(fn);

  for (const role of ["evolve", "steer"] as const) {
    const run = (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role, ts: new Date().toISOString() }));
    const rt = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId, role, allowControl: true });
    (await gw.report(rt, { result: "failure" as const, error: "boom", durationMs: 1 }));
  }
  expect(sent).toHaveLength(0);
});

test("notify: 'never' suppresses failure alerts entirely", async () => {
  const { rt } = (await seededExecRun("never"));
  const { sent, fn } = recordingNotify();
  (await gateway(fn).report(rt, { result: "failure" as const, error: "boom", durationMs: 1 }));
  expect(sent).toHaveLength(0);
});

test("a deferred pending run on an OFFLINE machine gets ONE calm note, stays claimable, and is delivered on the next poll (catch-up)", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  // Machine offline + last seen long ago (past the 6h asleep window ⇒ presence "offline").
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: false, lastSeen: "2000-01-01T00:00:00Z" }));
  const loop = (await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto" }));
  const { sent, fn } = recordingNotify();
  const gw = gateway(fn);

  const run = (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "pending", role: "exec", ts: new Date(Date.now() - 3_600_000).toISOString() }));
  (await gw.sweep());
  (await gw.sweep()); // second sweep must not re-notify (deferredAt = dedup stamp)

  // Deferred, not failed: the run is still pending (the durable inbox slot),
  // stamped with the waiting hint, and exactly ONE calm note went out.
  const held = (await store.getRun(run.id))!;
  expect(held.phase).toBe("pending");
  expect(held.deferredAt).toBeTruthy();
  expect(sent).toHaveLength(1);
  expect(sent[0]!.loopId).toBe(loop.id);
  expect(sent[0]!.message).toMatch(/offline/i);
  expect(sent[0]!.message).not.toMatch(/fail/i);

  // CATCH-UP: the machine's next poll claims the deferred run — nothing was lost.
  const res = await pollV3(gw, token);
  expect(res.status).toBe(200);
  expect((res.body as { delivery: { runId: string } | null }).delivery?.runId).toBe(run.id);
  expect((await store.getRun(run.id))!.phase).toBe("running");
});

test("circuit breaker: the 3rd consecutive exec failure auto-pauses the loop with ONE note (skipped runs transparent)", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const loop = (await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto" }));
  const { sent, fn } = recordingNotify();
  const gw = gateway(fn);

  // 2 consecutive failures already on record, with a `skipped` slot in between —
  // skipped rides phase `canceled`, so it must neither count nor reset the streak.
  const base = Date.now() - 60 * 60_000;
  for (let i = 0; i < 2; i++) {
    (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "error", role: "exec", ts: new Date(base + i * 60_000).toISOString() }));
    if (i === 0) (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "canceled", role: "exec", ts: new Date(base + i * 60_000 + 30_000).toISOString() }));
  }
  expect((await store.getLoop(loop.id))!.enabled).toBe(true);

  // The 3rd failure arrives as a real failing report — the breaker trips.
  const run = (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: new Date().toISOString() }));
  const rt = (await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId, role: "exec", allowControl: true }));
  (await gw.report(rt, { result: "failure" as const, error: "boom", durationMs: 1 }));

  expect((await store.getLoop(loop.id))!.enabled).toBe(false);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.message).toMatch(/paused automatically/i);
  expect(sent[0]!.message).toMatch(/3/);
});

test("blocked status pauses the loop for any role and outranks canceled terminal state", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const loop = await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "never" });
  await store.enqueueRun(loop.id, { role: "exec", requestedBy: "system" });
  const run = await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "steer", requestedBy: "owner", requestText: "fix", ts: new Date().toISOString() });
  const rt = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId, role: "steer", allowControl: true });
  const gw = gateway();

  expect((await gw.cli(rt, ["report", "--status", "blocked", "--message", "owner-only goal change required"])).status).toBe(200);
  expect((await gw.report(rt, { result: "canceled", exitCode: 143, error: "canceled by server request", durationMs: 1 })).status).toBe(200);

  const finalized = (await store.getRun(run.id))!;
  expect(finalized.phase).toBe("canceled");
  expect(finalized.status).toBe("blocked");
  const paused = (await store.getLoop(loop.id))!;
  expect(paused.enabled).toBe(false);
  expect(paused.pauseCause).toMatchObject({ kind: "blocked", runId: run.id, role: "steer" });
  expect((await store.openRunsForLoop(loop.id)).filter((r) => r.phase === "pending" && r.requestedBy === "system")).toHaveLength(0);
});

test("report requires a valid status and a non-empty message for every run role", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const loop = await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "never" });
  const gw = gateway();

  for (const role of ["exec", "steer", "evolve"] as const) {
    const run = await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role, ts: new Date().toISOString() });
    const rt = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId, role, allowControl: true });
    expect((await gw.cli(rt, ["report", "--status", "wibble", "--message", "done"])).status).toBe(400);
    expect((await gw.cli(rt, ["report", "--status", "kept"])).status).toBe(400);
    expect((await gw.cli(rt, ["report", "--status", "kept", "--message", "   "])).status).toBe(400);
    expect(await store.getRun(run.id)).toMatchObject({ status: null, message: null });
    await store.updateRun(run.id, { phase: "canceled" });
    await tokens.retireLease(rt);
  }
});

test("continuous loop stops enqueueing after the 3rd exec error trips the breaker", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const loop = await store.createLoop({
    userId: "u1",
    machineId,
    name: "Continuous",
    cron: "0 0 1 1 *",
    scheduleMode: "continuous",
    continuousDelayMinutes: 1,
    enabled: true,
    notify: "never",
  });
  const scheduler = new schedulerMod.Scheduler({ dispatch(): void {} });
  const gw = new gatewayMod.MachineGateway(scheduler);

  let current = await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", requestedBy: "system", ts: new Date().toISOString() });
  for (let attempt = 1; attempt <= 3; attempt++) {
    const rt = await tokens.registerRunLease({ runId: current.id, loopId: loop.id, machineId, role: "exec", allowControl: true });
    expect((await reportV2(gw, rt, { result: "failure" as const, error: `boom ${attempt}`, durationMs: 1 })).status).toBe(200);
    let waiting = (await store.openRunsForLoop(loop.id)).find((r) => r.phase === "pending" && r.role === "exec");
    if (attempt < 3) {
      expect(waiting).toBeUndefined(); // cadence remains a fact until due
      const target = (await store.getLoop(loop.id))!.nextCadenceAt!;
      await store.advanceDueSchedules(new Date(Date.parse(target) + 1).toISOString());
      waiting = (await store.openRunsForLoop(loop.id)).find((r) => r.phase === "pending" && r.role === "exec");
      expect(waiting, `attempt ${attempt} should continue`).toBeTruthy();
      current = (await store.updateRun(waiting!.id, { phase: "running", ts: new Date().toISOString() }))!;
    } else {
      expect(waiting).toBeUndefined();
    }
  }
  expect((await store.getLoop(loop.id))!.enabled).toBe(false);
});

test("circuit breaker: notify=never still pauses, silently", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const loop = (await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "never" }));
  const { sent, fn } = recordingNotify();
  const gw = gateway(fn);

  const base = Date.now() - 60 * 60_000;
  for (let i = 0; i < 2; i++) {
    (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "error", role: "exec", ts: new Date(base + i * 60_000).toISOString() }));
  }
  const run = (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: new Date().toISOString() }));
  const rt = (await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId, role: "exec", allowControl: true }));
  (await gw.report(rt, { result: "failure" as const, error: "boom", durationMs: 1 }));

  expect((await store.getLoop(loop.id))!.enabled).toBe(false);
  expect(sent).toHaveLength(0);
});

test("manual follow-ups are not reclaimed while blocked by a running role or a long-offline machine", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const loop = await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "never" });
  await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "steer", requestedBy: "owner", requestText: "A", ts: new Date().toISOString() });
  const queued = await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "pending", role: "exec", requestedBy: "owner", ts: new Date(Date.now() - 8 * 86_400_000).toISOString() });
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
  const loop = (await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto" }));
  const { sent, fn } = recordingNotify();
  const gw = gateway(fn);

  // Pending for 8 days — the machine never came back inside the 7-day horizon.
  const run = (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "pending", role: "exec", ts: new Date(Date.now() - 8 * 86_400_000).toISOString() }));
  (await gw.sweep());

  const retired = (await store.getRun(run.id))!;
  expect(retired.phase).toBe("canceled");
  expect(retired.error).toBeNull();
  // Skipped is neither success nor failure: no push, and the failure streak
  // stays untouched (it counts only phase `error`).
  expect(sent).toHaveLength(0);
  expect(await store.execFailureStreak(loop.id)).toBe(0);
});

test("execFailureStreak counts only consecutive trailing exec errors, ignoring evolve/canceled/open", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const loop = (await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto" }));

  (await addExecRun(loop.id, machineId, "done", "2026-06-01T00:00:01Z"));
  (await addExecRun(loop.id, machineId, "error", "2026-06-01T00:00:02Z"));
  (await addExecRun(loop.id, machineId, "error", "2026-06-01T00:00:03Z"));
  // An interleaved evolve error must NOT count (internal role).
  (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "error", role: "evolve", ts: "2026-06-01T00:00:04Z" }));
  expect((await store.execFailureStreak(loop.id))).toBe(2);

  // A trailing success breaks the streak to 0.
  (await addExecRun(loop.id, machineId, "done", "2026-06-01T00:00:05Z"));
  expect((await store.execFailureStreak(loop.id))).toBe(0);
});

// ---- loopLog (device-token-scoped run-log read for `pievo log`) ----

/** A machine + a loop on it, with `count` exec runs (newest ts last). */
async function seededLoopWithRuns(machineId: string, count: number) {
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: "h-" + machineId, online: true }));
  const loop = (await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto" }));
  for (let i = 0; i < count; i++) {
    (await store.addRun({
      loopId: loop.id,
      userId: "u1",
      machineId,
      phase: i % 2 === 0 ? "done" : "error",
      role: "exec",
      ts: `2026-06-01T00:00:${String(i + 1).padStart(2, "0")}Z`,
      sessionId: `sess-${i}`,
      ...(i % 2 === 0 ? { state: { mrr: 42 + i } } : { error: `boom ${i}` }),
    }));
  }
  return loop;
}

test("loopLog honors and caps the run limit", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  const loop = (await seededLoopWithRuns(machineId, 5));

  expect(((await gateway().loopLog(token, loop.id, 2)).body as { runs: any[] }).runs).toHaveLength(2);
  // Limit is clamped to the max (20), so a huge value just returns everything.
  expect(((await gateway().loopLog(token, loop.id, 9999)).body as { runs: any[] }).runs).toHaveLength(5);
  // A non-positive / garbage limit falls back to the default (≥ all 5 here).
  expect(((await gateway().loopLog(token, loop.id, -1)).body as { runs: any[] }).runs).toHaveLength(5);
});

test("loopLog refuses a token whose machine does not own the loop (cross-device)", async () => {
  const tokenA = tokens.mintDeviceToken();
  const machineA = tokens.machineIdFromToken(tokenA);
  const loop = (await seededLoopWithRuns(machineA, 2));

  // A different device with its own token cannot read machine A's loop's runs.
  const tokenB = tokens.mintDeviceToken();
  const machineB = tokens.machineIdFromToken(tokenB);
  (await store.createMachine({ id: machineB, userId: "u2", name: "MB", tokenHash: "hb", online: true }));
  const res = (await gateway().loopLog(tokenB, loop.id));
  expect(res.status).toBe(404);
});

test("loopLog rejects an unknown loop id and an unregistered token", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: "h", online: true }));
  // Loop that doesn't exist → 404 (existence never leaks).
  expect((await gateway().loopLog(token, "loop-nope")).status).toBe(404);
  // Missing loop id → 400.
  expect((await gateway().loopLog(token, "")).status).toBe(400);
  // Token for a machine that was never registered → 401.
  expect((await gateway().loopLog(tokens.mintDeviceToken(), "loop-x")).status).toBe(401);
});

// ---- run-lifecycle hardening: canceled ordering, sweep inactivity/revocation ----



test("a canceled evolve report has no loop-level lifecycle side effect", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const loop = await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto" });
  const cadence = loop.nextCadenceAt;
  const run = await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "canceled", role: "evolve", ts: new Date().toISOString() });
  const rt = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId, role: "evolve", allowControl: true });

  expect((await gateway().report(rt, { result: "success" as const, durationMs: 5 })).status).toBe(200);
  expect((await store.getLoop(loop.id))!.nextCadenceAt).toBe(cadence);
  expect(await tokens.resolveLease(rt)).toBeUndefined();
});



test("sweep marks a reclaimed run's token reclaimed: agent-api mutations are refused (409), but the token survives for one wake-report", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const loop = (await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "never" }));
  // Claimed 30min ago, no heartbeat heard since → past the 20min inactivity window.
  const staleTs = new Date(Date.now() - 30 * 60_000).toISOString();
  const run = (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: staleTs }));
  const rt = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId, role: "exec", allowControl: false });

  const gw = gateway();
  expect((await gw.agentApi(rt, ["show"])).status).toBe(200); // live before the sweep
  (await gw.sweep());
  expect((await store.getRun(run.id))!.phase).toBe("error");
  expect((await store.getRun(run.id))!.error).toBe("machine timed out / disconnected");
  // The orphaned agent can no longer MUTATE the loop (reclaimed → 409, not silent),
  // but the token is not revoked outright: it survives to accept one wake-report.
  expect((await gw.agentApi(rt, ["show"])).status).toBe(409);
  expect(await tokens.resolveLease(rt)).toBeTruthy();
});

test("a stale sweep observation that loses its phase CAS has zero side effects", async () => {
  const { loop, run, rt } = await seededExecRun("always");
  const calls: string[] = [];
  const core = new gatewayMod.MachineGateway({
    addLoop(): void { calls.push("arm"); }, removeLoop(): void {}, advanceDueSchedules(): never[] { return []; },
  } as any, undefined, async () => { calls.push("notify"); });
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
  const loop = await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto" });
  const queued = await store.enqueueRun(loop.id, { role: "exec", requestedBy: "system" });
  if (!("run" in queued)) throw new Error("expected queued run");
  const stalePending = queued.run;
  expect(await store.claimReadyRunForMachine(machineId)).toBeDefined();
  const calls: string[] = [];
  const core = new gatewayMod.MachineGateway({
    addLoop(): void { calls.push("arm"); }, removeLoop(): void {}, advanceDueSchedules(): never[] { return []; },
  } as any, undefined, async () => { calls.push("notify"); });

  await (core as any).reclaimRun(stalePending, "stale pending reclaim");
  expect((await store.getRun(stalePending.id))!.phase).toBe("running");
  expect(calls).toEqual([]);
});

test("sweep keeps an online pending row as durable queued work", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const activeLoop = await store.createLoop({ userId: "u1", machineId, name: "active", cron: "0 0 1 1 *", enabled: true });
  const waitingLoop = await store.createLoop({ userId: "u1", machineId, name: "waiting", cron: "0 0 1 1 *", enabled: true });
  await store.addRun({ loopId: activeLoop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: new Date().toISOString() });
  const old = new Date(Date.now() - 30 * 60_000).toISOString();
  const waiting = await store.addRun({
    loopId: waitingLoop.id, userId: "u1", machineId, phase: "pending", role: "exec",
    requestedBy: "system", ts: old, createdAt: old, updatedAt: old,
  });

  await gateway().sweep();
  expect(await store.getRun(waiting.id)).toMatchObject({ phase: "pending", error: null });
});

test("stale offline expiration cannot cancel a concurrently promoted/coalesced row", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: false });
  const loop = await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true });
  const old = new Date(Date.now() - 8 * 86_400_000).toISOString();
  const pending = await store.addRun({
    loopId: loop.id, userId: "u1", machineId, phase: "pending", role: "exec",
    requestedBy: "system", ts: old, createdAt: old, updatedAt: old,
  });
  await store.enqueueRun(loop.id, { role: "exec", requestedBy: "owner" });

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

test("stale deferred stamping cannot overwrite a concurrently promoted owner row", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: false });
  const loop = await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true });
  const pending = await store.addRun({
    loopId: loop.id, userId: "u1", machineId, phase: "pending", role: "exec",
    requestedBy: "system", ts: new Date().toISOString(),
  });
  const staleUpdatedAt = pending.updatedAt;
  await store.enqueueRun(loop.id, { role: "exec", requestedBy: "owner" });

  const stamped = await store.markPendingRunDeferred(
    pending.id,
    { requestedBy: "system", updatedAt: staleUpdatedAt },
    new Date().toISOString(),
  );
  expect(stamped).toBeUndefined();
  expect(await store.getRun(pending.id)).toMatchObject({
    phase: "pending",
    requestedBy: "owner",
    deferredAt: null,
  });
});

test("sweep is INACTIVITY-based: a >20min run reported in currentRuns is NOT reclaimed", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const loop = (await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "never" }));
  const staleTs = new Date(Date.now() - 30 * 60_000).toISOString();
  const run = (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: staleTs }));

  const gw = gateway();
  // Another machine cannot heartbeat this run.
  const otherToken = tokens.mintDeviceToken();
  await pollV3(gw, otherToken, { info: { host: "other" }, currentRuns: [{ runId: run.id, stage: "executing" }] });
  expect((await store.getRun(run.id))!.heartbeatAt).toBeNull();

  // The owning daemon's currentRuns heartbeat refreshes the dedicated stamp.
  await pollV3(gw, token, { currentRuns: [{ runId: run.id, stage: "executing" }] });
  expect((await store.getRun(run.id))!.heartbeatAt).toBeTruthy();
  (await gw.sweep());
  expect((await store.getRun(run.id))!.phase).toBe("running"); // never falsely failed

  // Once the stamp itself goes stale (nothing heard for the full window) → reclaimed.
  (await store.updateRun(run.id, { heartbeatAt: staleTs }));
  (await gw.sweep());
  expect((await store.getRun(run.id))!.phase).toBe("error");
  expect((await store.getRun(run.id))!.error).toBe("machine timed out / disconnected");
});

test("currentRuns heartbeat refresh is scoped to the owning machine", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const loop = await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "never" });
  const run = await store.addRun({ id: "single-active", loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: new Date().toISOString() });
  await pollV3(gateway(), token, {
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

test("execFailureStreak is exact past any cap, so the every-Nth reminder keeps firing", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const loop = (await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto" }));

  // A success, then 70 consecutive failures — beyond the old capped scan (64),
  // which pinned the streak at 64 and silenced reminders forever.
  (await addExecRun(loop.id, machineId, "done", "2026-05-31T23:59:59Z"));
  for (let i = 1; i <= 70; i++) {
    const mm = String(Math.floor(i / 60)).padStart(2, "0");
    const ss = String(i % 60).padStart(2, "0");
    (await addExecRun(loop.id, machineId, "error", `2026-06-01T00:${mm}:${ss}Z`));
  }
  expect((await store.execFailureStreak(loop.id))).toBe(70);
  // 70 % FAILURE_NOTIFY_EVERY(5) === 0 → the "still broken" reminder fires.
  expect(notifyMod.shouldNotifyFailure("auto", 70)).toBe(true);
});

test("show computes `next` in the loop's timezone", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const gw = gateway();
  const showNext = async (timezone: string) => {
    const loop = (await store.createLoop({ userId: "u1", machineId, name: `L-${timezone}`, cron: "0 8 * * *", timezone, enabled: true, notify: "auto" }));
    const run = (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: new Date().toISOString() }));
    const rt = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId, role: "exec", allowControl: false });
    const text = ((await gw.agentApi(rt, ["show"])).body as { text: string }).text;
    await store.updateRun(run.id, { phase: "canceled" });
    await tokens.retireLease(rt);
    return text.split("\n").find((l) => l.startsWith("nextFire:"))!;
  };
  // Same cron, timezones 25h apart — the derived nextFire, rendered IN the loop's own
  // timezone, must read differently for the two zones.
  expect((await showNext("Pacific/Kiritimati"))).not.toBe((await showNext("Pacific/Niue")));
});

// ---- wire-input bounds ----




test("agent-api report clips --message to the 2000-char cap", async () => {
  const { run, rt } = (await seededExecRun());
  const res = (await gateway().agentApi(rt, ["report", "--status", "kept", "--message", "m".repeat(5000)]));
  expect(res.status).toBe(200);
  expect((await store.getRun(run.id))!.message!.length).toBe(2000);
});

test("agent-api flags are NUL-stripped before any pg write", async () => {
  // Postgres text/jsonb REJECT U+0000 (SQLite tolerated it) - a flag value
  // carrying one (e.g. --file-content inlining a file with a stray NUL) must be
  // sanitized at the parseFlags chokepoint, not 500 the verb mid-run.
  const { run, rt } = (await seededExecRun());
  const res = (await gateway().agentApi(rt, [
    "report",
    "--status",
    "kept",
    "--message",
    "before\u0000after",
  ]));
  expect(res.status).toBe(200);
  const stored = (await store.getRun(run.id))!;
  expect(stored.message).toBe("beforeafter");
});

test("exec report requires complete declared metrics and accepts negative/null values", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const loop = await store.createLoop({
    userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "never",
    metricSchema: [{ key: "delta" }, { key: "missing" }],
  } as any);
  const run = await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: new Date().toISOString() });
  const rt = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId, role: "exec", allowControl: false });
  const gw = gateway();

  expect((await gw.agentApi(rt, ["report", "--status", "kept", "--message", "measured"])).status).toBe(400);
  expect((await gw.agentApi(rt, ["report", "--status", "kept", "--message", "measured", "--metrics", '{"delta":-2}'])).status).toBe(400);
  const res = await gw.agentApi(rt, ["report", "--status", "kept", "--message", "measured", "--metrics", '{"delta":-2,"missing":null}']);
  expect(res.status).toBe(200);
  expect((await store.getRun(run.id)) as any).toMatchObject({ metrics: { delta: -2, missing: null } });
});

test("steer/evolve reports reject metrics", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const loop = await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "never" });
  const gw = gateway();
  for (const role of ["steer", "evolve"] as const) {
    const run = await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role, ts: new Date().toISOString() });
    const rt = await tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId, role, allowControl: true });
    expect((await gw.agentApi(rt, ["report", "--status", "kept", "--message", "updated", "--metrics", '{"x":1}'])).status).toBe(400);
    await store.updateRun(run.id, { phase: "canceled" });
    await tokens.retireLease(rt);
  }
});

test("report clips sessionId and error (untrusted wire input, same discipline as message)", async () => {
  const { run, rt } = (await seededExecRun());
  const res = (await gateway().report(rt, {
    result: "failure" as const,
    durationMs: 1,
    sessionId: "s".repeat(500),
    error: "e".repeat(5000),
  }));
  expect(res.status).toBe(200);
  const stored = (await store.getRun(run.id))!;
  expect(stored.sessionId!.length).toBe(200); // SESSION_ID_CAP
  expect(stored.error!.length).toBe(2000); // MESSAGE_CAP
  // A non-string error degrades to the server's default reason.
  const again = (await seededExecRun());
  (await gateway().report(again.rt, { result: "failure" as const, durationMs: 1, error: 42 as never }));
  expect((await store.getRun(again.run.id))!.error).toBe("run failed on machine");
});

test("poll persists the daemon version, updating only when it changes", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  // First poll self-registers and records the reported version.
  await gateway().pollV3(token, { protocolVersion: 3, currentRuns: [], info: { host: "mac", platform: "darwin", arch: "arm64", version: "0.8.0" } });
  expect((await store.getMachine(machineId))!.daemonVersion).toBe("0.8.0");
  // A newer version on the next poll updates it.
  await gateway().pollV3(token, { protocolVersion: 3, currentRuns: [], info: { host: "mac", platform: "darwin", arch: "arm64", version: "0.9.0" } });
  expect((await store.getMachine(machineId))!.daemonVersion).toBe("0.9.0");
  // A poll with no version leaves it as-is (older daemons don't report it).
  await gateway().pollV3(token, { protocolVersion: 3, currentRuns: [], info: { host: "mac", platform: "darwin", arch: "arm64" } });
  expect((await store.getMachine(machineId))!.daemonVersion).toBe("0.9.0");
  // An over-long version is clipped defensively (untrusted wire input).
  await gateway().pollV3(token, { protocolVersion: 3, currentRuns: [], info: { host: "mac", version: "9".repeat(200) } });
  expect((await store.getMachine(machineId))!.daemonVersion!.length).toBe(64);
});

// ---- /api/machine/cli — unified dispatch, verb × credential matrix (§4.1) ----

/** A machine seeded from a REAL device token, an OPEN loop bound to it, and an exec
 *  run RUNNING with a fresh run token — so one setup drives both the device-credential
 *  and run-credential branches of `cli()` against the same loop. */
async function seededCli(opts: { allowControl?: boolean; goal?: string | null } = {}) {
  const deviceToken = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(deviceToken);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(deviceToken), online: true }));
  const loop = (await store.createLoop({
    userId: "u1",
    machineId,
    name: "L",
    cron: "0 0 1 1 *",
    enabled: true,
    notify: "auto",
    goal: opts.goal === undefined ? null : opts.goal,
  }));
  const run = (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: new Date().toISOString() }));
  const runToken = await tokens.registerRunLease({
    runId: run.id,
    loopId: loop.id,
    machineId,
    role: "exec",
    allowControl: opts.allowControl ?? true,
  });
  return { deviceToken, machineId, loop, run, runToken };
}

test("cli branches by credential: dk_ prefix → device path, bare-UUID → run path", async () => {
  const { deviceToken, runToken, loop } = (await seededCli());
  const gw = gateway();
  // Device credential lists the machine's loops (owner authority).
  const dev = (await gw.cli(deviceToken, ["loops"]));
  expect(dev.status).toBe(200);
  expect((dev.body as any).loops.map((l: any) => l.id)).toContain(loop.id);
  // The same `loops` verb on a RUN credential is owner-only → 403.
  const run = (await gw.cli(runToken, ["loops"]));
  expect(run.status).toBe(403);
});

test("cli run credential: log returns the run's OWN-loop history (closes the note.md seam)", async () => {
  const { runToken, loop, machineId } = (await seededCli());
  const historical = await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "done", role: "steer", requestedBy: "owner", status: "kept", message: "did a thing", sessionId: "sess-abc", ts: new Date().toISOString() });
  const res = (await gateway().cli(runToken, ["log"]));
  expect(res.status).toBe(200);
  const body = res.body as any;
  expect(body.text).toContain(loop.id); // loopId is render-only (stripped); the survey text carries it
  expect(body.runs.some((r: any) => r.id === historical.id && r.role === "steer" && r.message === "did a thing")).toBe(true); // runs channel retained
  // Batch 4 wired a `log` case into dispatch, so the legacy `/agent-api/loop`
  // transport now yields the run's OWN-loop log too — the help that advertises
  // `log` is truthful on both transports (the seam is closed everywhere).
  const legacy = (await gateway().agentApi(runToken, ["log"]));
  expect(legacy.status).toBe(200);
  expect((legacy.body as { text: string }).text).toContain(loop.id);
});

test("cli run credential: show is scoped to the run's own loop with its caps", async () => {
  const { runToken, loop } = (await seededCli({ allowControl: true }));
  const res = (await gateway().cli(runToken, ["show"]));
  expect(res.status).toBe(200);
  const text = (res.body as { text: string }).text;
  expect(text).toContain(`cron: "${loop.cron}"`);
  expect(text).toContain("selfSchedule: allowed");
});

test("cli run credential: owner-only verbs are 403, not unknown-command", async () => {
  const { runToken } = (await seededCli());
  const gw = gateway();
  for (const argv of [["new"], ["edit"], ["steer"], ["loops"], ["start"], ["stop"], ["delete"], ["run", "stop", "r"]]) {
    const res = (await gw.cli(runToken, argv));
    expect(res.status).toBe(403);
    expect((res.body as { text: string }).text).toMatch(/device credential|own loop/);
  }
});

test("cli server dispatch has no removed status/doctor command aliases", async () => {
  const { deviceToken, runToken } = await seededCli();
  for (const token of [deviceToken, runToken]) {
    for (const verb of ["status", "doctor"]) {
      const res = await gateway().cli(token, [verb]);
      expect(res.status).toBe(400);
      expect(textOf(res)).toContain("unknown command");
    }
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
  const res = await gateway(undefined, {
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

  await store.updateMachine(loop.machineId, { daemonProtocol: 3 });
  const stopped = await gw.cli(deviceToken, ["stop", loop.id]);
  expect(stopped.status).toBe(200);
  expect(textOf(stopped)).toContain("stop requested; waiting for");
  expect((await store.getLoop(loop.id))?.enabled).toBe(false);
  expect((await store.getRun(run.id))?.cancelRequestedAt).toBeTruthy();
  expect((await store.getRun(run.id))?.phase).toBe("running");
});

test("cli stop finds the requested loop's run when another loop is also running", async () => {
  const { deviceToken, machineId } = await seededCli();
  const target = await store.createLoop({ userId: "u1", machineId, name: "target", cron: "0 0 1 1 *", enabled: true });
  const targetRun = await store.addRun({ loopId: target.id, userId: "u1", machineId, phase: "running", role: "exec", ts: new Date().toISOString() });
  await tokens.registerRunLease({ runId: targetRun.id, loopId: target.id, machineId, role: "exec", allowControl: true });

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
  await store.updateMachine(loop.machineId, { daemonProtocol: 3 });
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
  await store.updateMachine(loop.machineId, { daemonProtocol: 3 });
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
  await store.updateMachine(first.loop.machineId, { daemonProtocol: 3, online: false, lastSeen: null });
  await store.requestDeleteLoop(first.loop.id);
  const audit: Array<Record<string, unknown>> = [];
  const forced = await gateway(undefined, { destructiveLog: (event) => audit.push(event) }).cli(first.deviceToken, [
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
  const failed = await gateway(undefined, { forceDeleteLoop: async () => false }).cli(second.deviceToken, [
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

test("cli run credential: a --loop naming another loop is 403 (never a silent retarget)", async () => {
  const { runToken, loop } = (await seededCli());
  const gw = gateway();
  // Own loop id via --loop is accepted (it equals the slot's loop).
  expect((await gw.cli(runToken, ["log", "--loop", loop.id])).status).toBe(200);
  expect((await gw.cli(runToken, ["show", "--loop", loop.id])).status).toBe(200);
  // A different loop id → hard 403 on both the read verbs and a mutation.
  expect((await gw.cli(runToken, ["log", "--loop", "loop-other"])).status).toBe(403);
  expect((await gw.cli(runToken, ["show", "--loop", "loop-other"])).status).toBe(403);
  expect((await gw.cli(runToken, ["reschedule", "--loop", "loop-other", "--next", "30m"])).status).toBe(403);
  // A positional loop id on a read verb is checked the same way.
  expect((await gw.cli(runToken, ["log", "loop-other"])).status).toBe(403);
  expect((await gw.cli(runToken, ["show", "loop-other"])).status).toBe(403);
  // The mismatch must not have touched the loop.
  expect((await store.getLoop(loop.id))!.nextRunAt).toBeNull();
});

test("cli run credential: the reschedule floor still applies through the unified dispatch", async () => {
  const { runToken, loop } = (await seededCli({ allowControl: true }));
  const denied = (await gateway().cli(runToken, ["reschedule", "--next", "2m"]));
  expect(denied.status).toBe(400);
  expect((denied.body as { text: string }).text).toMatch(/5 min/);
  expect((await store.getLoop(loop.id))!.nextRunAt).toBeNull();
  // 30m clears the floor — the floor logic is identical to the agent-api path.
  expect((await gateway().cli(runToken, ["reschedule", "--next", "30m"])).status).toBe(200);
  expect((await store.getLoop(loop.id))!.nextRunAt).toBeTruthy();
});

test("reschedule: --run-at (canonical) and --next (alias) both drive the pinned next fire, floors enforced", async () => {
  // F4: the in-run help documents `--run-at` while the code historically only read
  // `--next` — following the help guaranteed a failure. Now BOTH parse.
  const runAt = (await seededCli({ allowControl: true }));
  const viaRunAt = (await gateway().cli(runAt.runToken, ["reschedule", "--run-at", "30m"]));
  expect(viaRunAt.status).toBe(200);
  expect((await store.getLoop(runAt.loop.id))!.nextRunAt).toBeTruthy();

  const next = (await seededCli({ allowControl: true }));
  const viaNext = (await gateway().cli(next.runToken, ["reschedule", "--next", "30m"]));
  expect(viaNext.status).toBe(200);
  expect((await store.getLoop(next.loop.id))!.nextRunAt).toBeTruthy();

  // The self-schedule floor applies to the canonical flag exactly as to the alias.
  const floored = (await seededCli({ allowControl: true }));
  const denied = (await gateway().cli(floored.runToken, ["reschedule", "--run-at", "2m"]));
  expect(denied.status).toBe(400);
  expect((denied.body as { text: string }).text).toMatch(/5 min/);
  expect((await store.getLoop(floored.loop.id))!.nextRunAt).toBeNull();
});

test("the in-run help documents exactly what parses (no --run-at drift): its reschedule syntax succeeds verbatim", async () => {
  const { runToken } = (await seededCli({ allowControl: true }));
  const gw = gateway();
  const help = ((await gw.agentApi(runToken, ["help"])).body as { text: string }).text;
  // Help shows the canonical `--run-at` flag (not the retired `--next`).
  expect(help).toContain("--run-at <30m|2h|ISO>");
  // And the flag the help documents actually parses — following the help succeeds,
  // never the shipped drift where the documented flag was silently rejected.
  const followed = (await gw.cli(runToken, ["reschedule", "--run-at", "2h"]));
  expect(followed.status).toBe(200);
});

test("per-verb --help (run credential): role-aware syntax + availability from the lease caps", async () => {
  const { runToken } = (await seededCli({ allowControl: true, goal: "reach the goal" }));
  const gw = gateway();
  // reschedule --help: syntax + the canonical flag + an availability line.
  const resched = (await gw.cli(runToken, ["reschedule", "--help"]));
  expect(resched.status).toBe(200);
  const rt = (resched.body as { text: string }).text;
  expect(rt).toContain("verb: reschedule");
  expect(rt).toContain("--run-at <30m|2h|ISO>");
  // Multi-word values render quoted (TOON), matching the reference tool.
  expect(rt).toContain('availability: "available to this run"');
  expect(rt).toContain("help[");

  // report --help is always available regardless of caps.
  const report = ((await gw.cli(runToken, ["report", "--help"])).body as { text: string }).text;
  expect(report).toContain("verb: report");
  expect(report).toContain("--status kept|no-change|blocked");
  expect(report).toContain('availability: "always available"');

  // A structural set-* verb reflects the (missing) evolve/steer cap on an exec run.
  const setUi = ((await gw.cli(runToken, ["set-ui", "--help"])).body as { text: string }).text;
  expect(setUi).toContain("verb: set-ui");
  expect(setUi).toContain("evolve/steer pass only");
});

test("per-verb --help (device credential): owner verbs print full syntax + templates, no availability line", async () => {
  const { deviceToken } = (await seededCli());
  const gw = gateway();
  const edit = (await gw.cli(deviceToken, ["edit", "--help"]));
  expect(edit.status).toBe(200);
  const et = (edit.body as { text: string }).text;
  expect(et).toContain("verb: edit");
  expect(et).toContain("edit <id> [--json '<patch>']");
  // The owner surface lists the editable envelope keys (discoverable without failing).
  expect(et).toContain("cron");
  expect(et).toContain("taskFile");
  expect(et).toContain("help[");
  // No run-lease availability caveat on the owner surface.
  expect(et).not.toContain("availability:");

  for (const verb of ["new", "loops", "show", "log"]) {
    const text = ((await gw.cli(deviceToken, [verb, "--help"])).body as { text: string }).text;
    expect(text).toContain(`verb: ${verb}`);
  }
});

test("--help on an unknown verb falls through to unknown-command (no fabricated help)", async () => {
  const { deviceToken, runToken } = (await seededCli());
  const gw = gateway();
  // Device: unknown verb + --help → the switch default 400 (unchanged behavior).
  const dev = (await gw.cli(deviceToken, ["frobnicate", "--help"]));
  expect(dev.status).toBe(400);
  // Run: an owner-only verb is still 403 even with --help (role-aware, not help).
  expect((await gw.cli(runToken, ["new", "--help"])).status).toBe(403);
  // Run: a genuinely unknown verb + --help → dispatch's unknown-command 400.
  expect((await gw.cli(runToken, ["frobnicate", "--help"])).status).toBe(400);
});

test("cli run credential: allowControl still gates schedule mutations through the unified dispatch", async () => {
  const { runToken, loop } = (await seededCli({ allowControl: false }));
  const res = (await gateway().cli(runToken, ["pause"]));
  expect(res.status).toBe(403);
  expect((res.body as { text: string }).text).toMatch(/allowControl/);
  expect((await store.getLoop(loop.id))!.enabled).toBe(true);
});

test("cli device credential: new/edit/loops/log/show route to the existing gateway logic", async () => {
  const { deviceToken, machineId } = (await seededCli());
  const gw = gateway();
  // new → createLoop
  const created = (await gw.cli(deviceToken, ["new", "--json", JSON.stringify({ name: "Daily", cron: "0 8 * * *", taskFile: "pievo/x/README.md", model: "gpt-5.6-luna", reasoningEffort: "custom-high" })]));
  expect(created.status).toBe(200);
  const newId = idIn(created);
  expect((await store.getLoop(newId))!.machineId).toBe(machineId);
  expect((await store.getLoop(newId))!.model).toBe("gpt-5.6-luna");
  expect((await store.getLoop(newId))!.reasoningEffort).toBe("custom-high");
  // loops → listLoops (includes the just-created loop; the `loops` channel is retained)
  const loops = (await gw.cli(deviceToken, ["loops"]));
  expect((loops.body as any).loops.map((l: any) => l.id)).toContain(newId);
  // edit → editLoop (positional loop id + --json patch)
  const edited = (await gw.cli(deviceToken, ["edit", newId, "--json", JSON.stringify({ cron: "0 9 * * *", notify: "always", reasoningEffort: "maximum" })]));
  expect(edited.status).toBe(200);
  expect((await store.getLoop(newId))!.cron).toBe("0 9 * * *");
  expect((await store.getLoop(newId))!.notify).toBe("always");
  expect((await store.getLoop(newId))!.reasoningEffort).toBe("maximum");
  // log → loopLog for that loop
  const log = (await gw.cli(deviceToken, ["log", newId]));
  expect(log.status).toBe(200);
  expect(textOf(log)).toContain(newId); // loopId is render-only; the survey text carries it
  // show → describe for that loop
  const show = (await gw.cli(deviceToken, ["show", newId]));
  expect(show.status).toBe(200);
  expect((show.body as { text: string }).text).toContain('cron: "0 9 * * *"');
});

test("cli device credential: steer queues and coalesces the latest owner instruction", async () => {
  const { deviceToken, loop } = await seededCli();
  // seededCli has a running exec, so the steer remains pending and can coalesce.
  const first = await gateway().cli(deviceToken, ["steer", loop.id, "--message", "first instruction"]);
  const second = await gateway().cli(deviceToken, ["steer", loop.id, "--message", "latest instruction"]);
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(textOf(second)).toContain("updated instruction");
  const pending = (await store.openRunsForLoop(loop.id)).filter((run) => run.phase === "pending" && run.role === "steer");
  expect(pending).toHaveLength(1);
  expect(pending[0]?.requestText).toBe("latest instruction");
});

test("cli device credential: steer validates ownership and message", async () => {
  const { deviceToken, loop } = await seededCli();
  expect((await gateway().cli(deviceToken, ["steer", loop.id])).status).toBe(400);
  expect((await gateway().cli(deviceToken, ["steer", loop.id, "--message", "   "])).status).toBe(400);
  expect((await gateway().cli(deviceToken, ["steer", "missing", "--message", "x"])).status).toBe(404);
});

test("cli device credential: edit honors --dry-run (validate-only, no persistence)", async () => {
  const { deviceToken, loop } = (await seededCli());
  const before = (await store.getLoop(loop.id))!.cron;
  const dry = (await gateway().cli(deviceToken, ["edit", loop.id, "--json", JSON.stringify({ cron: "0 9 * * *" }), "--dry-run"]));
  expect(dry.status).toBe(200);
  expect(textOf(dry)).toContain("dry-run:"); // the dry-run render (structured dryRun flag retired)
  expect((await store.getLoop(loop.id))!.cron).toBe(before); // unchanged
});

test("cli device credential: log/show of a loop on ANOTHER machine is a flat 404 (existence never leaks)", async () => {
  const { deviceToken } = (await seededCli());
  // A second machine + loop the first device does not own.
  const otherDevice = tokens.mintDeviceToken();
  const otherMachineId = tokens.machineIdFromToken(otherDevice);
  (await store.createMachine({ id: otherMachineId, userId: "u2", name: "M2", tokenHash: tokens.sha256(otherDevice), online: true }));
  const otherLoop = (await store.createLoop({ userId: "u2", machineId: otherMachineId, name: "Other", cron: "0 0 1 1 *", enabled: true, notify: "auto" }));
  const gw = gateway();
  expect((await gw.cli(deviceToken, ["log", otherLoop.id])).status).toBe(404);
  expect((await gw.cli(deviceToken, ["show", otherLoop.id])).status).toBe(404);
});
