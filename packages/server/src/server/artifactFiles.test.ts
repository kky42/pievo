// Use the booted local store so read helpers resolve the same bytes sync wrote.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";

import { testStore, type TestStore } from "../../test/store.js";

let tmp: string;
let db: typeof import("../db/index.js");
let store: TestStore;
let boot: typeof import("./boot.js");
let tokens: typeof import("../gateway/tokens.js");
let artifacts: typeof import("./artifactFiles.js");
let auth: typeof import("../auth.js");
let art: Awaited<ReturnType<typeof import("./boot.js")["getArtifactSync"]>>;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-art2-"));
  process.env.PIEVO_DATA_DIR = tmp;
  process.env.PIEVO_LOG_LEVEL = "silent";
  db = await import("../db/index.js");
  await db.runMigrations();
  store = testStore(await import("../db/store.js"));
  boot = await import("./boot.js");
  tokens = await import("../gateway/tokens.js");
  artifacts = await import("./artifactFiles.js");
  auth = await import("../auth.js");
  art = await boot.getArtifactSync();
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

beforeEach(async () => {
  await (db.client as { exec(q: string): Promise<unknown> }).exec("DELETE FROM artifact_files; DELETE FROM blobs; DELETE FROM runs; DELETE FROM loops; DELETE FROM machines;");
});

function sha256(s: string | Buffer): string {
  return createHash("sha256").update(s).digest("hex");
}

async function seed() {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await store.createMachine({ id: machineId, userId: "u1", teamId: "team-u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const loop = await store.createLoop({ workdir: "/work",
    userId: "u1", teamId: "team-u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true,
    artifacts: ["z.md", "a/b.txt", "logo.png", "big.bin", "keep.md", "data/raw.json", "huge.bin"],
  });
  return { token, machineId, loop };
}

async function syncFile(token: string, loopId: string, p: string, bytes: Buffer, binary = false) {
  const hash = sha256(bytes);
  await art.sync(token, {
    loopId,
    manifest: [{ path: p, hash, size: bytes.length, binary, oversize: false }],
  });
  expect((await art.putBlob(token, hash, bytes)).status).toBe(200);
  return hash;
}

test("listLoopArtifacts returns path-sorted summaries; readLoopArtifact decodes text", async () => {
  const { token, loop } = await seed();
  const z = Buffer.from("# Z");
  const b = Buffer.from("hello");
  await art.sync(token, {
    loopId: loop.id,
    manifest: [
      { path: "z.md", hash: sha256(z), size: z.length, binary: false, oversize: false },
      { path: "a/b.txt", hash: sha256(b), size: b.length, binary: false, oversize: false },
    ],
  });
  expect((await art.putBlob(token, sha256(z), z)).status).toBe(200);
  expect((await art.putBlob(token, sha256(b), b)).status).toBe(200);

  const list = await artifacts.listLoopArtifacts(loop.id);
  expect(list.map((f) => f.path)).toEqual(["a/b.txt", "z.md"]);
  expect(list[0]).toMatchObject({ path: "a/b.txt", size: 5, binary: false, oversize: false });
  expect(typeof list[0]!.updatedAt).toBe("string");

  const content = await artifacts.readLoopArtifact(loop.id, "a/b.txt");
  expect(content).toEqual({ text: "hello" });
});

test("readLoopArtifact returns a binary marker for binary files (download-only)", async () => {
  const { token, loop } = await seed();
  await syncFile(token, loop.id, "logo.png", Buffer.from([0x89, 0x50, 0x00, 0x4e]), true);
  const content = await artifacts.readLoopArtifact(loop.id, "logo.png");
  expect(content).toEqual({ binary: true, size: 4, oversize: false });
});

test("readLoopArtifact marks oversize (metadata-only) files; no bytes are read", async () => {
  const { token, loop } = await seed();
  await art.sync(token, {
    loopId: loop.id,
    manifest: [{ path: "big.bin", hash: null, size: 20 * 1024 * 1024, binary: false, oversize: true }],
  });
  const content = await artifacts.readLoopArtifact(loop.id, "big.bin");
  expect(content).toEqual({ binary: true, size: 20 * 1024 * 1024, oversize: true });
});

test("readLoopArtifact reports not-found for unknown + tombstoned paths", async () => {
  const { token, loop } = await seed();
  await syncFile(token, loop.id, "keep.md", Buffer.from("a"));
  expect(await artifacts.readLoopArtifact(loop.id, "nope.md")).toEqual({ error: "file not found" });

  await art.sync(token, { loopId: loop.id, manifest: [] });
  expect(await artifacts.readLoopArtifact(loop.id, "keep.md")).toEqual({ error: "file not found" });
});

test("readLoopArtifactBytes: path-safe (400), oversize/missing (404), valid bytes (200)", async () => {
  const { token, loop } = await seed();
  const bytes = Buffer.from("downloadable");
  await syncFile(token, loop.id, "data/raw.json", bytes, false);

  expect((await artifacts.readLoopArtifactBytes(loop.id, "../../etc/passwd")).status).toBe(400);
  expect((await artifacts.readLoopArtifactBytes(loop.id, "/abs")).status).toBe(400);

  const ok = await artifacts.readLoopArtifactBytes(loop.id, "data/raw.json");
  expect(ok.status).toBe(200);
  expect(ok.bytes!.toString()).toBe("downloadable");
  expect(ok.filename).toBe("raw.json");

  await art.sync(token, {
    loopId: loop.id,
    manifest: [
      { path: "data/raw.json", hash: sha256(bytes), size: bytes.length, binary: false, oversize: false },
      { path: "huge.bin", hash: null, size: 20 * 1024 * 1024, binary: false, oversize: true },
    ],
  });
  expect((await art.putBlob(token, sha256(bytes), bytes)).status).toBe(200);
  expect((await artifacts.readLoopArtifactBytes(loop.id, "huge.bin")).status).toBe(404);
  expect((await artifacts.readLoopArtifactBytes(loop.id, "ghost.md")).status).toBe(404);
});

test("canAccessLoop authorizes by MEMBERSHIP, not the active team (cross-team-link fix)", async () => {
  await store.ensureTeam("team-cas-a", "A", "u1");
  await store.ensureTeam("team-cas-b", "B", "u1");
  await store.ensureTeam("team-cas-c", "C", "u2");

  const open = { enforce: false, userId: null, teamId: "team-shared" };
  expect(await auth.canAccessLoop("team-x", open)).toBe(true);

  const scoped = { enforce: true, userId: "u1", teamId: "team-cas-a" };
  expect(await auth.canAccessLoop("team-cas-a", scoped)).toBe(true);
  // The reported bug: a loop in team B, opened while active team = A. u1 IS a member
  // of B, so it must OPEN — not return not-found.
  expect(await auth.canAccessLoop("team-cas-b", scoped)).toBe(true);
  expect(await auth.canAccessLoop("team-cas-c", scoped)).toBe(false);

  const anon = { enforce: true, userId: null, teamId: "team-cas-a" };
  expect(await auth.canAccessLoop("team-cas-b", anon)).toBe(false);
});
