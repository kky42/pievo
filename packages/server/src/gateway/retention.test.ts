/**
 * Artifact-storage retention / GC tests. The whole point is correctness over
 * aggressiveness: a still-referenced (shared, or snapshot-retained) blob must
 * NEVER be reclaimed, while a blob no live row needs IS reclaimed once nothing
 * pins it. Snapshot retention remains bounded.
 *
 * Runs on an injected in-memory blob store + throwaway PGlite DB (no filesystem
 * artifact writes or network); the same BlobStore interface backs local/R2 prod.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";

import { MemoryBlobStore } from "./blobstore.js";

import { testStore, type TestStore } from "../../test/store.js";

let tmp: string;
let db: typeof import("../db/index.js");
let store: TestStore;
let gatewayMod: typeof import("./index.js");
let syncMod: typeof import("./sync.js");
let retention: typeof import("./retention.js");
let tokens: typeof import("./tokens.js");

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-retention-"));
  process.env.PIEVO_DATA_DIR = tmp;
  process.env.PIEVO_LOG_LEVEL = "silent";
  db = await import("../db/index.js");
  await db.runMigrations();
  store = testStore(await import("../db/store.js"));
  gatewayMod = await import("./index.js");
  syncMod = await import("./sync.js");
  retention = await import("./retention.js");
  tokens = await import("./tokens.js");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  await (db.client as any).exec(
    "DELETE FROM run_snapshots; DELETE FROM artifact_files; DELETE FROM blobs; DELETE FROM runs; DELETE FROM loops; DELETE FROM machines;",
  );
});


function sha256(s: string | Buffer): string {
  return createHash("sha256").update(s).digest("hex");
}

const scheduler = {
  advanceDueSchedules(): never[] { return []; },
  enqueueInitialExec(): void {},
  addLoop(): void {},
  removeLoop(): void {},
  runNow(): void {},
} as any;

/** Gateway (retention/GC) + ArtifactSync (byte ingress) over ONE shared blob
 *  store - the same sharing boot wires up. */
function gatewayWithStore(): {
  gw: InstanceType<typeof gatewayMod.MachineGateway>;
  art: InstanceType<typeof syncMod.ArtifactSync>;
  blobs: MemoryBlobStore;
} {
  const blobs = new MemoryBlobStore();
  return { gw: new gatewayMod.MachineGateway(scheduler, blobs), art: new syncMod.ArtifactSync(blobs), blobs };
}

async function seed() {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const loop = (await store.createLoop({
    workdir: "/work", userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true,
    artifacts: ["a.txt", "b.txt", "report.md", "racer.txt", "f.md"],
  }));
  return { token, machineId, loop };
}

/** Store a blob (bytes + metadata) directly, as a sync would. */
async function putBlob(blobs: MemoryBlobStore, content: string): Promise<string> {
  const hash = sha256(content);
  await blobs.put(hash, Buffer.from(content));
  await store.recordBlob(hash, content.length);
  return hash;
}

async function putArtifact(input: Parameters<typeof store.upsertConfiguredArtifactFile>[0]): Promise<void> {
  expect(await store.upsertConfiguredArtifactFile(input)).toBe(true);
}

async function reconcileArtifacts(loopId: string, keepPaths: string[]): Promise<void> {
  const loop = (await store.getLoop(loopId))!;
  await store.reconcileConfiguredArtifacts(loopId, loop.artifacts, keepPaths);
}

// A negative grace pushes the cutoff into the future so every just-written blob
// counts as "old enough" — letting these tests exercise collection without a wait.
const FORCE = -10_000;

test("GC keeps a blob still referenced by another live file (shared content)", async () => {
  const { loop } = (await seed());
  const { blobs } = gatewayWithStore();
  const hash = await putBlob(blobs, "shared bytes");

  // Two distinct paths point at the SAME content hash.
  await putArtifact({ loopId: loop.id, path: "a.txt", hash, size: 11, binary: false, oversize: false });
  await putArtifact({ loopId: loop.id, path: "b.txt", hash, size: 11, binary: false, oversize: false });

  // Reconcile one path away; the other still references the shared bytes.
  await reconcileArtifacts(loop.id, ["a.txt"]);

  const reclaimed = await retention.gcBlobs(blobs, FORCE);
  expect(reclaimed).toBe(0);
  expect(await blobs.has(hash)).toBe(true);
  expect((await store.blobExists(hash))).toBe(true);
});

test("GC keeps a blob a retained snapshot still references, then reclaims it once pruned", async () => {
  const { loop, machineId } = (await seed());
  const { blobs } = gatewayWithStore();
  const hash = await putBlob(blobs, "report v1");

  // The blob was a live file, captured into a run snapshot, then the file deleted.
  await putArtifact({ loopId: loop.id, path: "report.md", hash, size: 9, binary: false, oversize: false });
  const run = (await store.addRun({ loopId: loop.id, machineId, phase: "done", ts: new Date().toISOString() }));
  (await store.putRunSnapshot(run.id, loop.id, { "report.md": { hash, size: 9, binary: false, oversize: false } }));
  await reconcileArtifacts(loop.id, []);

  // No live artifact_files row references it now — but the snapshot does, so KEEP.
  const r1 = await retention.gcBlobs(blobs, FORCE);
  expect(r1).toBe(0);
  expect(await blobs.has(hash)).toBe(true);

  // Prune the snapshot (window of 0) → nothing references the hash anymore → reclaim.
  expect((await store.pruneRunSnapshots(loop.id, 0))).toBe(1);
  const r2 = await retention.gcBlobs(blobs, FORCE);
  expect(r2).toBe(1);
  expect(await blobs.has(hash)).toBe(false);
  expect((await store.blobExists(hash))).toBe(false);
});

test("the grace window protects freshly-written (unreferenced) blobs", async () => {
  const { blobs } = gatewayWithStore();
  const hash = await putBlob(blobs, "just written, not yet referenced");

  // Default-ish grace (1h): a brand-new unreferenced blob is NOT collected — it may
  // be a blob a concurrent sync is about to reference.
  const kept = await retention.gcBlobs(blobs, 60 * 60 * 1000);
  expect(kept).toBe(0);
  expect(await blobs.has(hash)).toBe(true);

  // With the grace effectively elapsed, the same unreferenced blob IS reclaimed.
  const reclaimed = await retention.gcBlobs(blobs, FORCE);
  expect(reclaimed).toBe(1);
  expect(await blobs.has(hash)).toBe(false);
});

test("GC deletes bytes before metadata: a blob re-referenced mid-delete drops metadata to self-heal", async () => {
  const { loop } = (await seed());
  const base = new MemoryBlobStore();
  const content = "racy bytes";
  const hash = sha256(content);
  await base.put(hash, Buffer.from(content));
  await store.recordBlob(hash, content.length);
  // No live row references it at pass start → it's garbage.

  // A BlobStore whose delete() simulates a concurrent sync racing the byte delete:
  // it re-references the hash (live file row + recreated blobs metadata) DURING the
  // await — the exact TOCTOU window the bytes-before-metadata ordering must survive.
  const racing = {
    has: (h: string) => base.has(h),
    put: (h: string, b: Buffer) => base.put(h, b),
    get: (h: string) => base.get(h),
    async delete(h: string): Promise<void> {
      if (h === hash) {
        await putArtifact({ loopId: loop.id, path: "racer.txt", hash, size: content.length, binary: false, oversize: false });
        await store.recordBlob(hash, content.length);
      }
      return base.delete(h);
    },
  };

  const reclaimed = await retention.gcBlobs(racing, FORCE);
  // The bytes were reclaimed (counted), AND the metadata row is dropped
  // unconditionally so blobExists()=false — the live row re-uploads on the next sync
  // (self-heal). The invariant: never a live blobs row left pointing at deleted bytes.
  expect(reclaimed).toBe(1);
  expect(await base.has(hash)).toBe(false);
  expect((await store.blobExists(hash))).toBe(false);
  expect((await store.getArtifactFile(loop.id, "racer.txt"))!.deleted).toBe(false);
});

test("snapshot retention prunes the oldest beyond the window, keeps the newest N", async () => {
  const { loop, machineId } = (await seed());
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    const run = (await store.addRun({ loopId: loop.id, machineId, phase: "done", ts: new Date().toISOString() }));
    (await store.putRunSnapshot(run.id, loop.id, {}));
    ids.push(run.id);
    await new Promise((r) => setTimeout(r, 5)); // distinct createdAt for deterministic ordering
  }

  // Keep the 2 most recent → 3 oldest pruned.
  const pruned = (await store.pruneRunSnapshots(loop.id, 2));
  expect(pruned).toBe(3);
  // Oldest three gone, newest two survive.
  expect((await store.getRunSnapshot(ids[0]!))).toBeUndefined();
  expect((await store.getRunSnapshot(ids[2]!))).toBeUndefined();
  expect((await store.getRunSnapshot(ids[3]!))).toBeDefined();
  expect((await store.getRunSnapshot(ids[4]!))).toBeDefined();

  // Idempotent: pruning again at the same window removes nothing.
  expect((await store.pruneRunSnapshots(loop.id, 2))).toBe(0);
});

test("pruneSnapshots applies the window across every loop", async () => {
  const { machineId } = (await seed());
  const l2 = (await store.createLoop({ workdir: "/work", userId: "u1", machineId, name: "L2", cron: "0 0 1 1 *", enabled: true }));
  for (const loopId of [l2.id]) {
    for (let i = 0; i < 4; i++) {
      const run = (await store.addRun({ loopId, machineId, phase: "done", ts: new Date().toISOString() }));
      (await store.putRunSnapshot(run.id, loopId, {}));
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  expect((await retention.pruneSnapshots(1))).toBe(3);
});

test("pruneRunSnapshots handles a large backlog without a per-victim bound-variable explosion", async () => {
  const { loop, machineId } = (await seed());
  const N = 1200;
  for (let i = 0; i < N; i++) {
    const run = (await store.addRun({ loopId: loop.id, machineId, phase: "done", ts: new Date().toISOString() }));
    (await store.putRunSnapshot(run.id, loop.id, {}));
  }
  // Prune to the window in ONE statement — the delete binds only the survivors (≤20),
  // not 1180 victim ids, so a large backlog can't trip SQLite's variable limit.
  expect((await store.pruneRunSnapshots(loop.id, 20))).toBe(N - 20);
  expect((await store.pruneRunSnapshots(loop.id, 20))).toBe(0);
}, 15_000);

test("GC spares a blob a snapshot comes to reference MID-PASS (per-candidate snapshot guard)", async () => {
  const { loop, machineId } = (await seed());
  const base = new MemoryBlobStore();
  const c1 = "first garbage";
  const c2 = "second garbage";
  const h1 = sha256(c1);
  const h2 = sha256(c2);
  await base.put(h1, Buffer.from(c1));
  await store.recordBlob(h1, c1.length);
  await base.put(h2, Buffer.from(c2));
  await store.recordBlob(h2, c2.length);
  // Neither is referenced at pass start → both are garbage in the keep-set computed then.
  const run = (await store.addRun({ loopId: loop.id, machineId, phase: "done", ts: new Date().toISOString() }));

  // While the FIRST garbage blob's bytes are being deleted, a report() captures the
  // SECOND garbage hash into a retained snapshot — the GC-check-time race that the
  // artifact_files-only guard would miss, wrongly collecting h2's still-needed bytes.
  const racing = {
    has: (h: string) => base.has(h),
    put: (h: string, b: Buffer) => base.put(h, b),
    get: (h: string) => base.get(h),
    async delete(h: string): Promise<void> {
      if (h === h1) {
        (await store.putRunSnapshot(run.id, loop.id, { "report.md": { hash: h2, size: c2.length, binary: false, oversize: false } }));
      }
      return base.delete(h);
    },
  };

  const reclaimed = await retention.gcBlobs(racing, FORCE);
  // h1 collected; h2 SPARED because the per-candidate guard now also consults snapshots.
  expect(reclaimed).toBe(1);
  expect(await base.has(h1)).toBe(false);
  expect((await store.blobExists(h1))).toBe(false);
  expect(await base.has(h2)).toBe(true);
  expect((await store.blobExists(h2))).toBe(true);
});

test("deleting a loop cascades runs/artifact_files/run_snapshots so its blobs become collectable", async () => {
  const { loop, machineId } = (await seed());
  const { blobs } = gatewayWithStore();
  const hash = await putBlob(blobs, "doomed loop content");

  // The blob is pinned twice: a live file row AND a retained run snapshot.
  await putArtifact({ loopId: loop.id, path: "f.md", hash, size: 19, binary: false, oversize: false });
  const run = (await store.addRun({ loopId: loop.id, machineId, phase: "done", ts: new Date().toISOString() }));
  (await store.putRunSnapshot(run.id, loop.id, { "f.md": { hash, size: 19, binary: false, oversize: false } }));
  expect(await retention.gcBlobs(blobs, FORCE)).toBe(0); // referenced → kept

  // Delete the loop → its runs / file rows / snapshots go with it (previously they
  // lived forever, pinning the blob in the keep-set permanently).
  expect((await store.deleteLoop(loop.id))).toBe(true);
  expect((await store.getRun(run.id))).toBeUndefined();
  expect((await store.listAllArtifactFiles(loop.id))).toHaveLength(0);
  expect((await store.getRunSnapshot(run.id))).toBeUndefined();

  // Nothing references the blob anymore → the next GC pass reclaims the bytes.
  expect(await retention.gcBlobs(blobs, FORCE)).toBe(1);
  expect(await blobs.has(hash)).toBe(false);
  expect((await store.blobExists(hash))).toBe(false);
});

test("maintainStorage skips a concurrent pass while one is already running (in-flight guard)", async () => {
  // One garbage blob with the grace forced open so gcBlobs awaits its byte delete.
  process.env.PIEVO_BLOB_GC_GRACE_MS = "1";
  const base = new MemoryBlobStore();
  const content = "garbage bytes";
  const hash = sha256(content);
  await base.put(hash, Buffer.from(content));
  await store.recordBlob(hash, content.length);
  await new Promise((r) => setTimeout(r, 5)); // elapse the 1ms grace

  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let deletes = 0;
  const blocking = {
    has: (h: string) => base.has(h),
    put: (h: string, b: Buffer) => base.put(h, b),
    get: (h: string) => base.get(h),
    async delete(h: string): Promise<void> {
      deletes++;
      await gate; // hold the FIRST pass inside its delete await
      return base.delete(h);
    },
  };
  const gw = new gatewayMod.MachineGateway(scheduler, blocking as any);

  try {
    const p1 = gw.maintainStorage(); // enters and blocks in delete()
    await new Promise((r) => setTimeout(r, 5));
    // A second tick fired while the first is in-flight must SKIP, not run a second
    // pass concurrently (which would re-scan + race the same deletes).
    const r2 = await gw.maintainStorage();
    expect(r2).toEqual({ snapshotsPruned: 0, blobsReclaimed: 0 });
    expect(deletes).toBe(1); // only the first pass attempted a delete

    release();
    const r1 = await p1;
    expect(r1.blobsReclaimed).toBe(1);
    expect(await base.has(hash)).toBe(false);
    // After it settles the latch is released → a fresh pass runs normally again.
    const r3 = await gw.maintainStorage();
    expect(r3).toEqual({ snapshotsPruned: 0, blobsReclaimed: 0 });
  } finally {
    delete process.env.PIEVO_BLOB_GC_GRACE_MS;
  }
});

test("maintainStorage is idempotent and safe with no garbage", async () => {
  const { gw } = gatewayWithStore();
  const r1 = await gw.maintainStorage();
  expect(r1).toEqual({ snapshotsPruned: 0, blobsReclaimed: 0 });
  const r2 = await gw.maintainStorage();
  expect(r2).toEqual({ snapshotsPruned: 0, blobsReclaimed: 0 });
});

test("maintainStorage prunes snapshots then reclaims the blobs they freed", async () => {
  const { loop, machineId } = (await seed());
  const { gw, blobs } = gatewayWithStore();

  // Two runs, each snapshotting its own (now unreferenced — no live file) blob.
  const old = await putBlob(blobs, "old run content");
  const recent = await putBlob(blobs, "recent run content");
  const r1 = (await store.addRun({ loopId: loop.id, machineId, phase: "done", ts: new Date().toISOString() }));
  (await store.putRunSnapshot(r1.id, loop.id, { "f.md": { hash: old, size: 15, binary: false, oversize: false } }));
  await new Promise((r) => setTimeout(r, 5));
  const r2 = (await store.addRun({ loopId: loop.id, machineId, phase: "done", ts: new Date().toISOString() }));
  (await store.putRunSnapshot(r2.id, loop.id, { "f.md": { hash: recent, size: 18, binary: false, oversize: false } }));

  // Window of 1: prune the older snapshot → its blob `old` becomes collectable.
  // (Use a forced grace via the lower-level call after pruning, since maintainStorage
  // uses the configured grace; here we drive the env knob to elapse the window.)
  process.env.PIEVO_BLOB_GC_GRACE_MS = "1"; // ~immediate
  process.env.PIEVO_SNAPSHOT_RETENTION = "1";
  await new Promise((r) => setTimeout(r, 5));
  try {
    const res = await gw.maintainStorage();
    expect(res.snapshotsPruned).toBe(1);
    expect(res.blobsReclaimed).toBe(1);
    expect(await blobs.has(old)).toBe(false); // freed
    expect(await blobs.has(recent)).toBe(true); // still snapshot-referenced
  } finally {
    delete process.env.PIEVO_BLOB_GC_GRACE_MS;
    delete process.env.PIEVO_SNAPSHOT_RETENTION;
  }
});
