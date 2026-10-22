// Use the booted local store so read helpers resolve the same bytes the writes stored.
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
let files: Awaited<ReturnType<typeof import("./boot.js")["getLoopFiles"]>>;

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
  files = await boot.getLoopFiles();
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
  await store.createMachine({ id: machineId, name: "M", tokenHash: tokens.sha256(token), online: true });
  const loop = await store.createLoop({ workdir: "/work", machineId, name: "L", cron: "0 0 1 1 *", enabled: true,
    artifacts: ["z.md", "report.html", "keep.md"],
  });
  return { token, machineId, loop };
}

async function writeFile(loopId: string, name: string, bytes: Buffer) {
  const hash = await files.putBlob(bytes);
  if (bytes.length) await store.recordBlob(hash, bytes.length);
  expect(await store.writeLoopFile(loopId, name, hash, bytes.length)).toBe(true);
  return hash;
}

test("listLoopArtifacts returns name-sorted summaries; readLoopArtifact decodes text", async () => {
  const { loop } = await seed();
  await writeFile(loop.id, "z.md", Buffer.from("# Z"));
  await writeFile(loop.id, "MEMORY.md", Buffer.from("hello"));

  const list = await artifacts.listLoopArtifacts(loop.id);
  expect(list.map((f) => f.path)).toEqual(["MEMORY.md", "keep.md", "report.html", "z.md"]);
  expect(list[0]).toMatchObject({ path: "MEMORY.md", size: 5, binary: false, oversize: false });
  expect(typeof list[0]!.updatedAt).toBe("string");

  expect(await artifacts.readLoopArtifact(loop.id, "MEMORY.md")).toEqual({ text: "hello" });
});

test("configured files without a stored version appear as empty and read as empty", async () => {
  const { loop } = await seed();
  const list = await artifacts.listLoopArtifacts(loop.id);
  expect(list.map((f) => f.path)).toEqual(["MEMORY.md", "keep.md", "report.html", "z.md"]);
  for (const file of list) expect(file).toMatchObject({ size: 0, binary: false, oversize: false });

  expect(await artifacts.readLoopArtifact(loop.id, "MEMORY.md")).toEqual({ text: "" });
  expect(await artifacts.readLoopArtifact(loop.id, "z.md")).toEqual({ text: "" });

  const bytes = await artifacts.readLoopArtifactBytes(loop.id, "z.md");
  expect(bytes.status).toBe(200);
  expect(bytes.bytes!.length).toBe(0);
});

test("an empty loop file reads as empty text without a stored blob", async () => {
  const { loop } = await seed();
  const hash = await writeFile(loop.id, "keep.md", Buffer.alloc(0));
  expect(await store.blobExists(hash)).toBe(false);
  expect(await artifacts.readLoopArtifact(loop.id, "keep.md")).toEqual({ text: "" });
});

test("writeLoopFile refuses unconfigured names", async () => {
  const { loop } = await seed();
  expect(await store.writeLoopFile(loop.id, "other.md", sha256("x"), 1)).toBe(false);
});

test("readLoopArtifact reports not-found for unknown + unconfigured files", async () => {
  const { loop } = await seed();
  await writeFile(loop.id, "keep.md", Buffer.from("a"));
  expect(await artifacts.readLoopArtifact(loop.id, "nope.md")).toEqual({ error: "file not found" });

  await store.updateLoop(loop.id, { artifacts: ["z.md"] });
  expect(await artifacts.readLoopArtifact(loop.id, "keep.md")).toEqual({ error: "file not found" });
});

test("unconfiguring artifacts never tombstones MEMORY.md", async () => {
  const { loop } = await seed();
  await writeFile(loop.id, "MEMORY.md", Buffer.from("lesson"));
  await store.updateLoop(loop.id, { artifacts: [] });
  expect(await artifacts.readLoopArtifact(loop.id, "MEMORY.md")).toEqual({ text: "lesson" });
});

test("deleting a loop removes its MEMORY.md row", async () => {
  const { loop } = await seed();
  await writeFile(loop.id, "MEMORY.md", Buffer.from("memory"));
  expect((await store.listAllArtifactFiles(loop.id)).map((file) => file.path)).toContain("MEMORY.md");
  expect(await store.deleteLoop(loop.id)).toBe(true);
  expect(await store.listAllArtifactFiles(loop.id)).toHaveLength(0);
});

test("readLoopArtifactBytes: missing (404), valid bytes (200)", async () => {
  const { loop } = await seed();
  await writeFile(loop.id, "report.html", Buffer.from("<h1>hi</h1>"));

  const ok = await artifacts.readLoopArtifactBytes(loop.id, "report.html");
  expect(ok.status).toBe(200);
  expect(ok.bytes!.toString()).toBe("<h1>hi</h1>");
  expect(ok.filename).toBe("report.html");

  expect((await artifacts.readLoopArtifactBytes(loop.id, "../../etc/passwd")).status).toBe(404);
  expect((await artifacts.readLoopArtifactBytes(loop.id, "ghost.md")).status).toBe(404);
});
