import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

import { createBlobStore, LocalBlobStore } from "./blobstore.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-local-blobs-"));
  roots.push(root);
  return root;
}

function hash(bytes: string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test("local blob bytes survive constructing a new store for the same directory", async () => {
  const root = tempRoot();
  const content = "durable artifact";
  const key = hash(content);

  await new LocalBlobStore(root).put(key, Buffer.from(content));

  const restarted = new LocalBlobStore(root);
  expect(await restarted.has(key)).toBe(true);
  expect((await restarted.get(key))?.toString()).toBe(content);
});

test("local blob deletion is idempotent and invalid hashes cannot escape the store", async () => {
  const root = tempRoot();
  const store = new LocalBlobStore(root);
  const key = hash("delete me");
  await store.put(key, Buffer.from("delete me"));

  await store.delete(key);
  await store.delete(key);
  await store.delete("f".repeat(64)); // absent shard is also an idempotent no-op

  expect(await store.get(key)).toBeNull();
  await expect(store.put("../outside", Buffer.from("bad"))).rejects.toThrow(/sha256/i);
  expect(fs.existsSync(path.join(root, "..", "outside"))).toBe(false);
});

test("a new local adapter removes temp files stranded by a crashed writer", async () => {
  const root = tempRoot();
  const key = hash("interrupted");
  const shard = path.join(root, key.slice(0, 2));
  const temp = path.join(shard, `.${key}.123.11111111-1111-1111-1111-111111111111.tmp`);
  fs.mkdirSync(shard, { recursive: true });
  fs.writeFileSync(temp, "partial");

  expect(await new LocalBlobStore(root).has(key)).toBe(false);
  expect(fs.existsSync(temp)).toBe(false);
});

test("concurrent writes of the same content-addressed blob are safe", async () => {
  const root = tempRoot();
  const store = new LocalBlobStore(root);
  const content = "same bytes";
  const key = hash(content);

  await Promise.all(Array.from({ length: 8 }, () => store.put(key, Buffer.from(content))));

  expect((await store.get(key))?.toString()).toBe(content);
});

test("the blob store is local at PIEVO_DATA_DIR/blobs", () => {
  const root = tempRoot();
  const previousDataDir = process.env.PIEVO_DATA_DIR;
  process.env.PIEVO_DATA_DIR = root;
  try {
    const store = createBlobStore();
    expect(store).toBeInstanceOf(LocalBlobStore);
    expect((store as LocalBlobStore).root).toBe(path.join(root, "blobs"));
  } finally {
    if (previousDataDir === undefined) delete process.env.PIEVO_DATA_DIR;
    else process.env.PIEVO_DATA_DIR = previousDataDir;
  }
});
