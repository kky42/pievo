/**
 * Phase 3 — per-run snapshot + diff. Runs the real path: gateway sync (stores
 * blobs + reconciles artifact_files) → gateway report (writes the run snapshot at
 * finalize) → computeRunDiff (lazily diffs run N vs N-1 with a pure-string text
 * diff). All against the booted gateway's local blob store (no R2/creds).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";

let tmp: string;
let db: typeof import("../db/index.js");
let store: typeof import("../db/store.js");
let boot: typeof import("./boot.js");
let tokens: typeof import("../gateway/tokens.js");
let runDiff: typeof import("./runDiff.js");
let gw: Awaited<ReturnType<typeof import("./boot.js")["getGateway"]>>;
let art: Awaited<ReturnType<typeof import("./boot.js")["getArtifactSync"]>>;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-diff-"));
  process.env.PIEVO_DATA_DIR = tmp;
  process.env.PIEVO_DB_PATH = path.join(tmp, "test.db");
  process.env.PIEVO_LOG_LEVEL = "silent";
  db = await import("../db/index.js");
  await db.runMigrations();
  store = await import("../db/store.js");
  boot = await import("./boot.js");
  tokens = await import("../gateway/tokens.js");
  runDiff = await import("./runDiff.js");
  gw = await boot.getGateway();
  art = await boot.getArtifactSync();
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

beforeEach(async () => {
  await (db.client as { exec(q: string): Promise<unknown> }).exec("DELETE FROM run_leases; DELETE FROM connect_keys; DELETE FROM run_snapshots; DELETE FROM artifact_files; DELETE FROM blobs; DELETE FROM runs; DELETE FROM loops; DELETE FROM machines;");
});

function sha256(s: string | Buffer): string {
  return createHash("sha256").update(s).digest("hex");
}

async function seed() {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await store.createMachine({ id: machineId, userId: "u1", teamId: "team-u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const loop = await store.createLoop({ userId: "u1", teamId: "team-u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto" });
  return { token, machineId, loop };
}

interface FileSpec {
  path: string;
  bytes: Buffer;
  binary?: boolean;
  oversize?: boolean;
}

/** One full run cycle: create the run, sync its files (run-tagged), report → snapshot. */
async function doRun(token: string, machineId: string, loopId: string, ts: string, files: FileSpec[]) {
  const run = await store.addRun({ loopId, userId: "u1", machineId, phase: "running", role: "exec", ts });
  const runToken = await tokens.registerRunLease({
    runId: run.id,
    loopId,
    machineId,
    role: "exec",
    allowControl: false,
    canSetUi: false,
    canSetSchema: false,
  });
  const manifest = files.map((f) =>
    f.oversize
      ? { path: f.path, hash: sha256(f.bytes), size: f.bytes.length, oversize: true }
      : { path: f.path, hash: sha256(f.bytes), size: f.bytes.length, binary: !!f.binary },
  );
  const blobs = files
    .filter((f) => !f.oversize)
    .map((f) => ({ hash: sha256(f.bytes), encoding: "base64" as const, data: f.bytes.toString("base64") }));
  await art.sync(token, { loopId, runId: run.id, manifest, blobs });
  const r = await gw.report(runToken, { reportId: `018f47a2-9c2b-7d11-8f52-${run.id.replace(/-/g, "").slice(0, 12)}`, runId: run.id, result: "success" as const, durationMs: 1 });
  expect(r.status).toBe(200);
  return run;
}

test("report writes a run snapshot capturing the loop's end-state manifest", async () => {
  const { token, machineId, loop } = await seed();
  const run = await doRun(token, machineId, loop.id, "2026-06-01T00:00:00.000Z", [
    { path: "report.md", bytes: Buffer.from("hello") },
  ]);
  const snap = await store.getRunSnapshot(run.id);
  expect(snap).toBeDefined();
  expect(Object.keys(snap!.manifest)).toEqual(["report.md"]);
  expect(snap!.manifest["report.md"]).toMatchObject({ hash: sha256("hello"), size: 5, binary: false, oversize: false });
});

test("getRunDiff: added / modified / removed / unchanged across two runs", async () => {
  const { token, machineId, loop } = await seed();
  await doRun(token, machineId, loop.id, "2026-06-01T00:00:00.000Z", [
    { path: "a.md", bytes: Buffer.from("line one\nline two\n") },
    { path: "keep.md", bytes: Buffer.from("unchanged") },
    { path: "gone.md", bytes: Buffer.from("bye") },
  ]);
  const run2 = await doRun(token, machineId, loop.id, "2026-06-02T00:00:00.000Z", [
    { path: "a.md", bytes: Buffer.from("line one\nline TWO changed\n") }, // modified
    { path: "keep.md", bytes: Buffer.from("unchanged") }, // unchanged → skipped
    { path: "new.md", bytes: Buffer.from("brand new") }, // added
    // gone.md omitted → removed
  ]);

  const diff = await runDiff.computeRunDiff(run2.id);
  expect(diff.hasSnapshot).toBe(true);
  const byPath = Object.fromEntries(diff.files.map((f) => [f.path, f]));
  expect(Object.keys(byPath).sort()).toEqual(["a.md", "gone.md", "new.md"]); // keep.md skipped

  expect(byPath["a.md"]!.status).toBe("modified");
  expect(byPath["a.md"]!.diff).toContain("line TWO changed");
  expect(byPath["new.md"]!.status).toBe("added");
  expect(byPath["new.md"]!.diff).toContain("brand new");
  expect(byPath["new.md"]!.sizeDelta).toBe(9);
  expect(byPath["gone.md"]!.status).toBe("removed");
  expect(byPath["gone.md"]!.sizeDelta).toBe(-3);
});

test("getRunDiff: binary/oversize change emits a size-delta marker, no inline diff", async () => {
  const { token, machineId, loop } = await seed();
  const small = Buffer.from([0x00, 0x01, 0x02]);
  const bigger = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]);
  await doRun(token, machineId, loop.id, "2026-06-01T00:00:00.000Z", [{ path: "blob.bin", bytes: small, binary: true }]);
  const run2 = await doRun(token, machineId, loop.id, "2026-06-02T00:00:00.000Z", [{ path: "blob.bin", bytes: bigger, binary: true }]);

  const diff = await runDiff.computeRunDiff(run2.id);
  const f = diff.files.find((x) => x.path === "blob.bin")!;
  expect(f.status).toBe("modified");
  expect(f.binary).toBe(true);
  expect(f.diff).toBeUndefined();
  expect(f.sizeDelta).toBe(2);
});

test("getRunDiff: a large text file (over the diff cap, under oversize) is tooLarge, not binary", async () => {
  const { token, machineId, loop } = await seed();
  const big = Buffer.from("x".repeat(600 * 1024)); // > 512KB diff cap, plain text
  const bigger = Buffer.from("y".repeat(601 * 1024));
  await doRun(token, machineId, loop.id, "2026-06-01T00:00:00.000Z", [{ path: "huge.txt", bytes: big }]);
  const run2 = await doRun(token, machineId, loop.id, "2026-06-02T00:00:00.000Z", [{ path: "huge.txt", bytes: bigger }]);

  const diff = await runDiff.computeRunDiff(run2.id);
  const f = diff.files.find((x) => x.path === "huge.txt")!;
  expect(f.status).toBe("modified");
  expect(f.tooLarge).toBe(true);
  expect(f.binary).toBe(false);
  expect(f.diff).toBeUndefined();
});

test("getRunDiff: first run (no previous snapshot) shows everything as added", async () => {
  const { token, machineId, loop } = await seed();
  const run = await doRun(token, machineId, loop.id, "2026-06-01T00:00:00.000Z", [{ path: "first.md", bytes: Buffer.from("hi") }]);
  const diff = await runDiff.computeRunDiff(run.id);
  expect(diff.hasSnapshot).toBe(true);
  expect(diff.files.map((f) => [f.path, f.status])).toEqual([["first.md", "added"]]);
});

test("getRunDiff degrades cleanly for a run with no snapshot (predates the feature)", async () => {
  const { machineId, loop } = await seed();
  const run = await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "done", role: "exec", ts: "2026-05-01T00:00:00.000Z" });
  const diff = await runDiff.computeRunDiff(run.id);
  expect(diff).toEqual({ hasSnapshot: false, files: [] });
});

test("bounded run diff caps changed files, blob input, and emitted diff text before later work", async () => {
  const { token, machineId, loop } = await seed();
  await doRun(token, machineId, loop.id, "2026-06-01T00:00:00.000Z", [
    { path: "a.md", bytes: Buffer.from("old-a\n") },
    { path: "b.md", bytes: Buffer.from("old-b\n") },
    { path: "c.md", bytes: Buffer.from("old-c\n") },
  ]);
  const run2 = await doRun(token, machineId, loop.id, "2026-06-02T00:00:00.000Z", [
    { path: "a.md", bytes: Buffer.from("new-a\n") },
    { path: "b.md", bytes: Buffer.from("new-b\n") },
    { path: "c.md", bytes: Buffer.from("new-c\n") },
  ]);

  const fileLimited = await runDiff.computeRunDiff(run2.id, { maxFiles: 1, maxInputBytes: 100, maxDiffChars: 100 });
  expect(fileLimited).toMatchObject({
    hasSnapshot: true,
    totalFiles: 3,
    truncated: true,
    truncation: { files: true, inputBytes: false },
    work: { filesProcessed: 1, inputBytes: 12 },
  });
  expect(fileLimited.files.map((file) => file.path)).toEqual(["a.md"]);

  const workLimited = await runDiff.computeRunDiff(run2.id, { maxFiles: 3, maxInputBytes: 12, maxDiffChars: 20 });
  expect(workLimited.totalFiles).toBe(3);
  expect(workLimited.work?.inputBytes).toBeLessThanOrEqual(12);
  expect(workLimited.work?.emittedDiffChars).toBeLessThanOrEqual(20);
  expect(workLimited.truncation).toMatchObject({ inputBytes: true, diffChars: true });
  expect(workLimited.truncated).toBe(true);
  expect(workLimited.files.find((file) => file.path === "b.md")).toMatchObject({ diffOmitted: "input-budget" });

  const diffSearchLimited = await runDiff.computeRunDiff(run2.id, { maxFiles: 1, maxInputBytes: 100, maxDiffChars: 1 });
  expect(diffSearchLimited.files[0]).toMatchObject({ path: "a.md", diffOmitted: "diff-budget" });
  expect(diffSearchLimited.work?.emittedDiffChars).toBe(0);
});
