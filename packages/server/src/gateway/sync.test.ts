import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";

import { LocalBlobStore, MemoryBlobStore } from "./blobstore.js";
import { testStore, type TestStore } from "../../test/store.js";

let tmp: string;
let db: typeof import("../db/index.js");
let store: TestStore;
let syncMod: typeof import("./sync.js");
let tokens: typeof import("./tokens.js");

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-sync-"));
  process.env.PIEVO_DATA_DIR = tmp;
  process.env.PIEVO_LOG_LEVEL = "silent";
  db = await import("../db/index.js");
  await db.runMigrations();
  store = testStore(await import("../db/store.js"));
  syncMod = await import("./sync.js");
  tokens = await import("./tokens.js");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  await (db.client as any).exec("DELETE FROM artifact_files; DELETE FROM blobs; DELETE FROM runs; DELETE FROM loops; DELETE FROM machines;");
});

function sha256(s: string | Buffer): string {
  return createHash("sha256").update(s).digest("hex");
}

function manifestEntry(path: string, hash: string, size: number, binary = false) {
  return { path, hash, size, binary, oversize: false };
}

function oversizeEntry(path: string, size: number, binary = false) {
  return { path, hash: null, size, binary, oversize: true };
}

function syncWithStore(): { art: InstanceType<typeof syncMod.ArtifactSync>; blobs: MemoryBlobStore } {
  const blobs = new MemoryBlobStore();
  return { art: new syncMod.ArtifactSync(blobs), blobs };
}

const TEST_ARTIFACTS = [
  "report.md", "note.txt", "f.txt", "big.bin", "huge.dat", ".git/config",
  "node_modules/dep/index.js", ".worktrees/2026-07-07-fix/src/App.jsx", ".next/cache/blob",
  ".env", "secrets/server.pem", "nested/id_rsa", "ok/file.txt", "a.md", "b.md", "out.md",
  "real.txt", "a.txt", "idea.md", "copy.md", "broken.md", "plain.md", " spaced report.md ",
];

async function seed() {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const loop = (await store.createLoop({ workdir: "/work", userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, artifacts: TEST_ARTIFACTS }));
  return { token, machineId, loop };
}

test("sync and blob ingress reject a truncated-machine-id collision", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: "different-full-hash", online: true });
  const art = syncWithStore().art;

  expect((await art.sync(token, { loopId: "loop-any", manifest: [] })).status).toBe(401);
  expect((await art.putBlob(token, "a".repeat(64), Buffer.from("x"))).status).toBe(401);
});

test("negotiated upload: manifest → needHashes → PUT blob lands bytes in the store", async () => {
  const { token, loop } = (await seed());
  const { art, blobs } = syncWithStore();
  const content = "# Breakfast report\n4g dispensed\n";
  const hash = sha256(content);

  const r1 = await art.sync(token, {
    loopId: loop.id,
    manifest: [manifestEntry("report.md", hash, content.length)],
  });
  expect(r1.status).toBe(200);
  expect((r1.body as any).needHashes).toEqual([hash]);
  expect(await blobs.has(hash)).toBe(false);

  const files = (await store.listArtifacts(loop.id));
  expect(files.map((f) => f.path)).toEqual(["report.md"]);
  expect(files[0]!.hash).toBe(hash);
  expect(files[0]!.deleted).toBe(false);

  const put = await art.putBlob(token, hash, Buffer.from(content));
  expect(put.status).toBe(200);
  expect((await blobs.get(hash))!.toString()).toBe(content);
  expect((await store.blobExists(hash))).toBe(true);

  const r2 = await art.sync(token, {
    loopId: loop.id,
    manifest: [manifestEntry("report.md", hash, content.length)],
  });
  expect((r2.body as any).needHashes).toEqual([]);
});

test("manifest binary classification is retained for artifact viewer and run snapshots", async () => {
  const { token, loop } = await seed();
  const { art } = syncWithStore();
  const bytes = Buffer.from([0x41, 0x00, 0x42]);
  const hash = sha256(bytes);

  const synced = await art.sync(token, {
    loopId: loop.id,
    manifest: [manifestEntry("big.bin", hash, bytes.length, true)],
  });
  expect(synced.status).toBe(200);
  expect((await store.listArtifacts(loop.id))[0]).toMatchObject({ path: "big.bin", binary: true, oversize: false });
  expect(await store.buildLoopManifest(loop.id)).toMatchObject({ "big.bin": { binary: true, oversize: false } });
});

test("a missing local byte object is requested and restored even when its database metadata remains", async () => {
  const { token, loop } = await seed();
  const blobRoot = path.join(tmp, "missing-byte-recovery");
  const blobs = new LocalBlobStore(blobRoot);
  const art = new syncMod.ArtifactSync(blobs);
  const content = "restore after byte-store loss";
  const hash = sha256(content);
  const manifest = [manifestEntry("report.md", hash, content.length)];

  await art.sync(token, { loopId: loop.id, manifest });
  expect((await art.putBlob(token, hash, Buffer.from(content))).status).toBe(200);
  expect(await store.blobExists(hash)).toBe(true);
  await blobs.delete(hash);

  const replay = await art.sync(token, { loopId: loop.id, manifest });
  expect((replay.body as any).needHashes).toEqual([hash]);
  expect((await art.putBlob(token, hash, Buffer.from(content))).status).toBe(200);
  expect((await blobs.get(hash))?.toString()).toBe(content);
});

test("files over 10MB are recorded as metadata only (no bytes, no needHashes)", async () => {
  const { token, loop } = (await seed());
  const { art } = syncWithStore();
  const r = await art.sync(token, {
    loopId: loop.id,
    manifest: [oversizeEntry("big.bin", 11 * 1024 * 1024)],
  });
  expect((r.body as any).needHashes).toEqual([]);
  const file = (await store.getArtifactFile(loop.id, "big.bin"))!;
  expect(file.oversize).toBe(true);
  expect(file.hash).toBeNull();
  expect(file.size).toBe(11 * 1024 * 1024);
});

test("explicit artifacts are not classified by directory, filename, extension, or secret-like name", async () => {
  const { token, loop } = (await seed());
  const { art } = syncWithStore();
  const h = (s: string) => sha256(s);
  const r = await art.sync(token, {
    loopId: loop.id,
    manifest: [
      manifestEntry("report.md", h("ok"), 2),
      manifestEntry(".git/config", h("g"), 1),
      manifestEntry("node_modules/dep/index.js", h("n"), 1),
      manifestEntry(".worktrees/2026-07-07-fix/src/App.jsx", h("w"), 1),
      manifestEntry(".next/cache/blob", h("c"), 1),
      manifestEntry(".env", h("e"), 1),
      manifestEntry("secrets/server.pem", h("p"), 1),
      manifestEntry("nested/id_rsa", h("k"), 1),
    ],
  });
  expect(r.status).toBe(200);
  expect((await store.listArtifacts(loop.id)).map((f) => f.path)).toEqual([
    ".env", ".git/config", ".next/cache/blob", ".worktrees/2026-07-07-fix/src/App.jsx",
    "nested/id_rsa", "node_modules/dep/index.js", "report.md", "secrets/server.pem",
  ]);
  expect(new Set((r.body as any).needHashes)).toEqual(new Set(["ok", "g", "n", "w", "c", "e", "p", "k"].map(h)));
});

test("sync preserves an exact literal path configured on the loop", async () => {
  const { token, loop } = await seed();
  const { art } = syncWithStore();
  const configured = sha256("configured");
  const response = await art.sync(token, {
    loopId: loop.id,
    manifest: [manifestEntry(" spaced report.md ", configured, 10)],
  });
  expect(response.status).toBe(200);
  expect((await store.listArtifacts(loop.id)).map((file) => file.path)).toEqual([" spaced report.md "]);
});

test("removing a configured path tombstones it immediately and blocks its pending PUT", async () => {
  const { token, loop } = await seed();
  const { art, blobs } = syncWithStore();
  const content = "pending bytes";
  const hash = sha256(content);
  const handshake = await art.sync(token, { loopId: loop.id, manifest: [manifestEntry("report.md", hash, content.length)] });
  expect((handshake.body as any).needHashes).toEqual([hash]);
  await store.updateLoop(loop.id, { artifacts: TEST_ARTIFACTS.filter((path) => path !== "report.md") });
  expect(await store.listArtifacts(loop.id)).toEqual([]);
  expect((await art.putBlob(token, hash, Buffer.from(content))).status).toBe(403);
  expect(await blobs.has(hash)).toBe(false);
});

test("artifact ingress applies only the per-file byte cap", async () => {
  const { token, loop } = await seed();
  const { art, blobs } = syncWithStore();
  const a = Buffer.alloc(1024, "a");
  const b = Buffer.alloc(1024, "b");
  const response = await art.sync(token, {
    loopId: loop.id,
    manifest: [
      manifestEntry("a.md", sha256(a), a.length),
      manifestEntry("b.md", sha256(b), b.length),
    ],
  });
  expect(response.status).toBe(200);
  expect(new Set((response.body as any).needHashes)).toEqual(new Set([sha256(a), sha256(b)]));
  expect((await art.putBlob(token, sha256(a), a)).status).toBe(200);
  expect((await art.putBlob(token, sha256(b), b)).status).toBe(200);
  expect(await blobs.has(sha256(a))).toBe(true);
  expect(await blobs.has(sha256(b))).toBe(true);
});

test("path traversal and absolute paths reject the whole manifest", async () => {
  const { token, loop } = await seed();
  const { art } = syncWithStore();
  for (const hostile of ["../../etc/passwd", "/abs/path"]) {
    const response = await art.sync(token, {
      loopId: loop.id,
      manifest: [{ ...manifestEntry("ok/file.txt", sha256("c"), 1), path: hostile }],
    });
    expect(response.status).toBe(400);
    expect(await store.listArtifacts(loop.id)).toEqual([]);
  }
});

test("deletions: a path absent from the manifest is tombstoned, not hard-deleted", async () => {
  const { token, loop } = (await seed());
  const { art } = syncWithStore();
  const a = sha256("a-content");
  const b = sha256("b-content");

  await art.sync(token, {
    loopId: loop.id,
    manifest: [
      manifestEntry("a.md", a, 9),
      manifestEntry("b.md", b, 9),
    ],
  });
  expect((await store.listArtifacts(loop.id)).map((f) => f.path)).toEqual(["a.md", "b.md"]);

  await art.sync(token, { loopId: loop.id, manifest: [manifestEntry("a.md", a, 9)] });
  expect((await store.listArtifacts(loop.id)).map((f) => f.path)).toEqual(["a.md"]);
  const tomb = (await store.getArtifactFile(loop.id, "b.md"))!;
  expect(tomb.deleted).toBe(true);
  expect(tomb.hash).toBeNull();
});

test("device-token auth is exact: malformed/unknown credentials are 401; another machine's loop is 404", async () => {
  const { loop } = await seed();
  const { art } = syncWithStore();
  for (const malformed of ["", "dev-token", `rk_${"a".repeat(32)}`, `dk_${"A".repeat(30)}`]) {
    expect((await art.sync(malformed, { loopId: loop.id, manifest: [] })).status).toBe(401);
  }
  const stranger = tokens.mintDeviceToken();
  const unknown = await art.sync(stranger, { loopId: loop.id, manifest: [] });
  expect(unknown.status).toBe(401);

  const otherToken = tokens.mintDeviceToken();
  const otherId = tokens.machineIdFromToken(otherToken);
  (await store.createMachine({ id: otherId, userId: "u2", name: "B", tokenHash: tokens.sha256(otherToken), online: true }));
  const wrong = await art.sync(otherToken, { loopId: loop.id, manifest: [] });
  expect(wrong.status).toBe(404);
});

test("malformed sync envelopes are 400 and cannot mutate or tombstone artifacts", async () => {
  const { token, loop } = await seed();
  const { art } = syncWithStore();
  const original = manifestEntry("report.md", sha256("original"), 8);
  expect((await art.sync(token, { loopId: loop.id, manifest: [original] })).status).toBe(200);
  const before = await store.listAllArtifactFiles(loop.id);

  const malformed: unknown[] = [
    null,
    [],
    { loopId: 1, manifest: [] },
    { loopId: "", manifest: [] },
    { loopId: "bad\u0000id", manifest: [] },
    { loopId: "x".repeat(201), manifest: [] },
    { loopId: loop.id },
    { loopId: loop.id, manifest: {} },
    { loopId: loop.id, manifest: [], blobs: [] },
    { loopId: loop.id, manifest: [{ ...original, extra: true }] },
    { loopId: loop.id, manifest: [{ path: "report.md", hash: original.hash, size: 8 }] },
    { loopId: loop.id, manifest: [{ ...original, size: "8" }] },
    { loopId: loop.id, manifest: [{ ...original, size: 1.5 }] },
    { loopId: loop.id, manifest: [oversizeEntry("big.bin", 2_147_483_648)] },
    { loopId: loop.id, manifest: [{ ...original, binary: 0 }] },
    { loopId: loop.id, manifest: [{ ...original, oversize: 0 }] },
    { loopId: loop.id, manifest: [{ ...original, hash: original.hash.toUpperCase() }] },
    { loopId: loop.id, manifest: [{ ...original, hash: null }] },
    { loopId: loop.id, manifest: [oversizeEntry("big.bin", 8)] },
    { loopId: loop.id, manifest: [{ ...oversizeEntry("big.bin", 11 * 1024 * 1024), hash: original.hash }] },
    { loopId: loop.id, manifest: [{ ...original, size: 11 * 1024 * 1024 }] },
    { loopId: loop.id, manifest: [{ ...original, path: "../../etc/passwd" }] },
    { loopId: loop.id, manifest: [{ ...original, path: "unconfigured.txt" }] },
    { loopId: loop.id, manifest: [manifestEntry("note.txt", sha256("new"), 3), { path: "report.md" }] },
    { loopId: loop.id, manifest: [manifestEntry("note.txt", sha256("new"), 3), { ...original, path: "unconfigured.txt" }] },
    { loopId: loop.id, manifest: [original, original] },
  ];

  for (const body of malformed) {
    expect((await art.sync(token, body)).status, JSON.stringify(body)).toBe(400);
    expect(await store.listAllArtifactFiles(loop.id)).toEqual(before);
  }
});

test("putBlob rejects a hash that doesn't match the body, and a bad hash format", async () => {
  const { token, loop } = (await seed());
  const { art, blobs } = syncWithStore();
  const realHash = sha256("real");
  await art.sync(token, { loopId: loop.id, manifest: [manifestEntry("real.txt", realHash, 4)] });

  const mismatch = await art.putBlob(token, realHash, Buffer.from("tampered"));
  expect(mismatch.status).toBe(400);
  expect(await blobs.has(realHash)).toBe(false);

  const badFormat = await art.putBlob(token, "not-a-hash", Buffer.from("x"));
  expect(badFormat.status).toBe(400);

  const ok = await art.putBlob(token, realHash, Buffer.from("real"));
  expect(ok.status).toBe(200);
  expect((await store.blobExists(realHash))).toBe(true);
});

test("putBlob refuses a blob the sync handshake never asked this machine for (403, no write amplification)", async () => {
  const { token } = (await seed());
  const { art, blobs } = syncWithStore();

  // A well-formed, self-consistent blob that NO artifact_files row references —
  // accepting it would make any device token an uncapped R2 write channel.
  const content = "unsolicited bytes";
  const hash = sha256(content);
  const res = await art.putBlob(token, hash, Buffer.from(content));
  expect(res.status).toBe(403);
  expect(await blobs.has(hash)).toBe(false);
  expect((await store.blobExists(hash))).toBe(false);
});

test("putBlob refuses a hash only ANOTHER machine's loop references (per-machine scoping)", async () => {
  const { token: tokenA, loop } = (await seed());
  const { art, blobs } = syncWithStore();
  const content = "machine A's file";
  const hash = sha256(content);
  await art.sync(tokenA, { loopId: loop.id, manifest: [manifestEntry("a.txt", hash, content.length)] });

  const tokenB = tokens.mintDeviceToken();
  const machineB = tokens.machineIdFromToken(tokenB);
  (await store.createMachine({ id: machineB, userId: "u2", name: "B", tokenHash: tokens.sha256(tokenB), online: true }));
  const denied = await art.putBlob(tokenB, hash, Buffer.from(content));
  expect(denied.status).toBe(403);
  expect(await blobs.has(hash)).toBe(false);

  const ok = await art.putBlob(tokenA, hash, Buffer.from(content));
  expect(ok.status).toBe(200);
  expect(await blobs.has(hash)).toBe(true);
});
