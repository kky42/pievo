import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";

let tmp: string;
let db: typeof import("../db/index.js");
let store: typeof import("../db/store.js");
let tokens: typeof import("./tokens.js");
let history: typeof import("./history.js");
let CliGateway: typeof import("./cli.js").CliGateway;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-history-"));
  process.env.PIEVO_DATA_DIR = tmp;
  process.env.PIEVO_LOG_LEVEL = "silent";
  db = await import("../db/index.js");
  await db.runMigrations();
  store = await import("../db/store.js");
  tokens = await import("./tokens.js");
  history = await import("./history.js");
  CliGateway = (await import("./cli.js")).CliGateway;
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

beforeEach(async () => {
  await (db.client as any).exec("DELETE FROM terminal_report_incidents; DELETE FROM run_report_receipts; DELETE FROM run_leases; DELETE FROM runs; DELETE FROM loops; DELETE FROM machines;");
});

async function seedMachineLoop(suffix = "a") {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await store.createMachine({ id: machineId, userId: "u1", name: `M-${suffix}`, tokenHash: tokens.sha256(token), online: true });
  const loop = await store.createLoop({
    userId: "u1", machineId, name: `History ${suffix}`, cron: "0 0 1 1 *", enabled: true, notify: "auto",
    agent: "codex", model: "gpt-history", reasoningEffort: "high", goal: "keep it healthy",
  });
  return { token, machineId, loop };
}

test("run indexes follow claim priority, then unclaimed terminalization", async () => {
  const { machineId, loop } = await seedMachineLoop();
  await store.enqueueRun(loop.id, { role: "exec", requestedBy: "system" });
  await store.enqueueRun(loop.id, { role: "evolve", requestedBy: "owner" });
  await store.enqueueRun(loop.id, { role: "steer", requestedBy: "owner", requestText: "go first" });

  const first = (await store.claimReadyRunForMachine(machineId))!;
  expect(first.run).toMatchObject({ role: "steer", runIndex: 1, agent: "codex", model: "gpt-history", reasoningEffort: "high" });
  await store.finalizeRunningRun(loop.id, first.run.id, { phase: "done", ts: "2026-01-01T00:00:01Z" }, {}, tokens.sha256(first.runToken));

  const second = (await store.claimReadyRunForMachine(machineId))!;
  expect(second.run).toMatchObject({ role: "evolve", runIndex: 2 });
  await store.finalizeRunningRun(loop.id, second.run.id, { phase: "done", ts: "2026-01-01T00:00:02Z" }, {}, tokens.sha256(second.runToken));

  const pendingExec = (await store.openRunsForLoop(loop.id)).find((run) => run.role === "exec")!;
  const canceled = (await store.requestRunCancel(loop.id, pendingExec.id))!;
  expect(canceled).toMatchObject({ phase: "canceled", runIndex: 3 });
  expect((await store.getLoop(loop.id))!.lastRunIndex).toBe(3);
});

test("terminal-grace reconciliation preserves its original index and is single-shot", async () => {
  const { machineId, loop } = await seedMachineLoop();
  await store.enqueueRun(loop.id, { role: "exec", requestedBy: "owner" });
  const claimed = (await store.claimReadyRunForMachine(machineId))!;
  expect(claimed.run.runIndex).toBe(1);
  const hash = tokens.sha256(claimed.runToken);
  await store.reclaimRun(claimed.run.id, "running", "asleep", new Date(Date.now() - 1_000).toISOString(), 60_000);
  const reconciled = await store.reconcileReclaimedRun(loop.id, claimed.run.id, hash, { phase: "done", status: "kept", ts: new Date().toISOString() });
  expect(reconciled?.run.runIndex).toBe(1);
  expect((await store.getLoop(loop.id))!.lastRunIndex).toBe(1);
  expect(await store.reconcileReclaimedRun(loop.id, claimed.run.id, hash, { phase: "done", ts: new Date().toISOString() })).toBeUndefined();
});

async function seedSummary() {
  const seeded = await seedMachineLoop();
  const base = Date.parse("2026-02-01T00:00:00Z");
  await store.addRun({ loopId: seeded.loop.id, userId: "u1", machineId: seeded.machineId, phase: "done", role: "exec", requestedBy: "system", ts: new Date(base + 1_000).toISOString(), status: "no-change", durationMs: 100, usage: { inputTokens: 10 }, metrics: { score: 2 }, agent: "codex", model: "m1", reasoningEffort: "high" });
  await store.addRun({ loopId: seeded.loop.id, userId: "u1", machineId: seeded.machineId, phase: "done", role: "steer", requestedBy: "owner", ts: new Date(base + 2_000).toISOString(), status: "kept", usage: { outputTokens: 5 }, agent: "claude-code", model: null, reasoningEffort: null });
  await store.addRun({ loopId: seeded.loop.id, userId: "u1", machineId: seeded.machineId, phase: "done", role: "exec", requestedBy: "system", ts: new Date(base + 3_000).toISOString(), status: "no-change", durationMs: 300, usage: { inputTokens: 30, outputTokens: 6 }, metrics: { score: 4 }, agent: "codex", model: "m1", reasoningEffort: "high" });
  await store.addRun({ loopId: seeded.loop.id, userId: "u1", machineId: seeded.machineId, phase: "error", role: "exec", requestedBy: "system", ts: new Date(base + 4_000).toISOString(), error: "boom", agent: "codex", model: "m2", reasoningEffort: "low" });
  await store.addRun({ loopId: seeded.loop.id, userId: "u1", machineId: seeded.machineId, phase: "pending", role: "evolve", requestedBy: "owner", ts: new Date(base + 5_000).toISOString() });
  return seeded;
}

test("initial Cookbook cursor #0 is a valid exclusive history boundary", () => {
  expect(history.parseHistoryFlags({ summary: true, after: "0", json: true })).toMatchObject({
    ok: true,
    value: { mode: "summary", after: 0, json: true },
  });
});

test("normal history TOON uses indexed terminal columns and displays steer", async () => {
  const { loop } = await seedSummary();
  const res = await history.readLoopHistory(loop, { limit: "20" });
  expect(res.status).toBe(200);
  const text = (res.body as any).text as string;
  expect(text).toContain("runs[4]{index,terminal,role,result,durationMs,usage,metrics,agent,session,message}");
  expect(text).toMatch(/\n  2,[^\n]+,steer,/);
  expect(text).not.toContain(",running,");
  expect(text).toContain("through: 4");
});

test("summary windows keep phase/status separate and exclude missing telemetry", async () => {
  const { loop } = await seedSummary();
  const res = await history.readLoopHistory(loop, { summary: true, through: "3", json: true });
  expect(res.status).toBe(200);
  const summary = (res.body as any).summary;
  expect(summary).toMatchObject({ through: 3, total: 3, byRole: { exec: 2, steer: 1, evolve: 0 }, phases: { done: 3, error: 0, canceled: 0 }, openNow: 1, execNoChangeStreak: 2 });
  expect(summary.reportedStatusByRole.exec).toMatchObject({ "no-change": 2, kept: 0 });
  expect(summary.usage.overall.inputTokens).toEqual({ total: 40, average: 20, samples: 2 });
  expect(summary.usage.overall.outputTokens).toEqual({ total: 11, average: 5.5, samples: 2 });
  expect(summary.duration.overall).toEqual({ total: 400, average: 200, samples: 2 });
  expect(summary.metrics.values.score).toMatchObject({ samples: 2, first: { runIndex: 1, value: 2 }, latest: { runIndex: 3, value: 4 }, min: 2, max: 4, average: 3 });
  expect(summary.executionProfiles.agent.counts).toMatchObject({ codex: 2, "claude-code": 1 });
  expect(JSON.parse((res.body as any).text).through).toBe(3);

  const timed = await history.readLoopHistory(loop, { summary: true, since: "2026-02-01T00:00:02Z", until: "2026-02-01T00:00:03Z", json: true });
  expect((timed.body as any).summary).toMatchObject({ total: 2, through: 3, firstTerminal: { runIndex: 2 }, lastTerminal: { runIndex: 3 } });
});

test("summary cursor stops before the lowest indexed open run and omits later terminal evidence", async () => {
  const { loop, machineId } = await seedMachineLoop("contiguous");
  for (let runIndex = 1; runIndex <= 9; runIndex++) {
    await store.addRun({ id: `00000000-0000-4000-8000-${String(runIndex).padStart(12, "0")}`, loopId: loop.id, userId: "u1", machineId, phase: "done", role: "exec", runIndex, ts: `2026-02-${String(runIndex).padStart(2, "0")}T00:00:00Z` });
  }
  await store.addRun({ id: "00000000-0000-4000-8000-000000000010", loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", runIndex: 10, ts: "2026-02-10T00:00:00Z" });
  await store.addRun({ id: "00000000-0000-4000-8000-000000000011", loopId: loop.id, userId: "u1", machineId, phase: "canceled", role: "steer", runIndex: 11, ts: "2026-02-11T00:00:00Z" });

  const summaryResult = await history.readLoopHistory(loop, { summary: true, json: true });
  expect(summaryResult.status).toBe(200);
  expect((summaryResult.body as any).summary).toMatchObject({ through: 9, total: 9, lastTerminal: { runIndex: 9 }, openNow: 1 });

  const listResult = await history.readLoopHistory(loop, { limit: "20", json: true });
  expect((listResult.body as any).runs[0]).toMatchObject({ runIndex: 11, phase: "canceled" });
  expect(JSON.parse((listResult.body as any).text).through).toBe(9);
});

test("summary fails loudly when its bounded row budget is exceeded", async () => {
  const { loop, machineId } = await seedMachineLoop("budget");
  await (db.client as any).exec(`
    INSERT INTO runs (id,loop_id,user_id,machine_id,phase,role,run_index,ts)
    SELECT 'budget-' || n, '${loop.id}', 'u1', '${machineId}', 'done', 'exec', n, '2026-01-01T00:00:00Z'
    FROM generate_series(1, ${history.HISTORY_SUMMARY_ROWS_MAX + 1}) AS n;
  `);
  const result = await history.readLoopHistory(loop, { summary: true, json: true });
  expect(result.status).toBe(413);
  expect((result.body as any).error).toContain(`more than ${history.HISTORY_SUMMARY_ROWS_MAX} runs`);
  expect((result.body as any).error).toContain("--after or --since");
});

test("detail is loop scoped and bounds large fields with explicit truncation", async () => {
  const a = await seedMachineLoop("a");
  const otherMachine = tokens.mintDeviceToken();
  const otherMachineId = tokens.machineIdFromToken(otherMachine);
  await store.createMachine({ id: otherMachineId, userId: "u2", name: "M-b", tokenHash: tokens.sha256(otherMachine), online: true });
  const b = await store.createLoop({ userId: "u2", machineId: otherMachineId, name: "B", cron: "0 0 1 1 *", enabled: true, notify: "auto" });
  const foreign = await store.addRun({ loopId: b.id, userId: "u2", machineId: otherMachineId, phase: "done", role: "exec", ts: "2026-03-01T00:00:00Z" });
  expect((await history.readLoopHistory(a.loop, { run: foreign.id, json: true })).status).toBe(404);

  const local = await store.addRun({ loopId: a.loop.id, userId: "u1", machineId: a.machineId, phase: "done", role: "steer", requestedBy: "owner", ts: "2026-03-02T00:00:00Z", finalText: "x".repeat(history.HISTORY_DETAIL_TEXT_CAP + 10) });
  const detail = await history.readLoopHistory(a.loop, { run: String(local.runIndex), diff: true, json: true });
  expect(detail.status).toBe(200);
  const body = JSON.parse((detail.body as any).text);
  expect(body.identity).toMatchObject({ id: local.id, runIndex: local.runIndex, role: "steer" });
  expect(body.outcome.finalText).toHaveLength(history.HISTORY_DETAIL_TEXT_CAP);
  expect(body.truncation.finalText).toMatchObject({ truncated: true, totalChars: history.HISTORY_DETAIL_TEXT_CAP + 10 });
  expect(body.diff).toEqual({ included: true, available: false, reason: "snapshot-unavailable", truncated: false, files: [] });
  expect(Buffer.byteLength(JSON.stringify(detail.body), "utf8")).toBeLessThanOrEqual(history.HISTORY_JSON_TEXT_CAP);
});

test("history detail applies the bounded diff file budget and exposes truncation metadata", async () => {
  const { loop, machineId } = await seedMachineLoop("diff-budget");
  const previous = await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "done", role: "exec", ts: "2026-03-01T00:00:00Z" });
  const current = await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "done", role: "exec", ts: "2026-03-02T00:00:00Z" });
  const manifest = (prefix: string) => Object.fromEntries(Array.from({ length: history.HISTORY_DIFF_FILES_MAX + 1 }, (_, index) => [
    `file-${String(index).padStart(3, "0")}.bin`,
    { hash: prefix.repeat(64), size: 1, binary: true, oversize: false },
  ]));
  await store.putRunSnapshot(previous.id, loop.id, manifest("a"));
  await store.putRunSnapshot(current.id, loop.id, manifest("b"));

  const result = await history.readLoopHistory(loop, { run: String(current.runIndex), diff: true, json: true });
  expect(result.status).toBe(200);
  expect((result.body as any).run.diff).toMatchObject({
    available: true,
    totalFiles: history.HISTORY_DIFF_FILES_MAX + 1,
    truncated: true,
    truncation: { files: true, inputBytes: false, diffChars: false },
    work: { filesProcessed: history.HISTORY_DIFF_FILES_MAX, inputBytes: 0, emittedDiffChars: 0 },
  });
  expect((result.body as any).run.diff.files).toHaveLength(history.HISTORY_DIFF_FILES_MAX);
});

test("in-run log --json uses the same server JSON text and displays steer", async () => {
  const { loop, machineId } = await seedSummary();
  const active = await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: new Date().toISOString() });
  const runToken = await tokens.registerRunLease({ runId: active.id, loopId: loop.id, machineId, role: "exec", allowControl: false });
  const cli = new CliGateway({} as any);
  const argv = ["log", "--json", "--limit", "20"];
  const res = await cli.agentApi(runToken, argv);
  const unified = await cli.cli(runToken, argv);
  expect(res.status).toBe(200);
  expect((unified.body as any).text).toBe((res.body as any).text);
  const parsed = JSON.parse((res.body as any).text);
  expect(parsed.runs.some((run: any) => run.role === "steer")).toBe(true);
  expect(parsed.through).toBe(4);
});

test("history rejects mixed windows and invalid filters", () => {
  for (const flags of [
    { after: "1", since: "2026-01-01T00:00:00Z" },
    { role: "edit" },
    { status: "success" },
    { phase: "running" },
    { limit: "21" },
    { diff: true },
  ]) {
    expect(history.parseHistoryFlags(flags as any)).toMatchObject({ ok: false });
  }
});
