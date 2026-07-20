import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

import { createBlobStore, LocalBlobStore, MemoryBlobStore, R2BlobStore } from "./blobstore.js";

const roots: string[] = [];
const R2_KEYS = [
  "PIEVO_R2_ACCOUNT_ID",
  "PIEVO_R2_ACCESS_KEY_ID",
  "PIEVO_R2_SECRET_ACCESS_KEY",
  "PIEVO_R2_BUCKET",
  "PIEVO_R2_ENDPOINT",
  "PIEVO_R2_REGION",
] as const;

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

test("the default blob store is local at PIEVO_DATA_DIR/blobs", () => {
  const root = tempRoot();
  const previousDataDir = process.env.PIEVO_DATA_DIR;
  const previousSelection = process.env.PIEVO_BLOB_STORE;
  const previousR2 = Object.fromEntries(R2_KEYS.map((key) => [key, process.env[key]]));
  process.env.PIEVO_DATA_DIR = root;
  delete process.env.PIEVO_BLOB_STORE;
  for (const key of R2_KEYS) delete process.env[key];

  try {
    const store = createBlobStore();
    expect(store).toBeInstanceOf(LocalBlobStore);
    expect((store as LocalBlobStore).root).toBe(path.join(root, "blobs"));
  } finally {
    if (previousDataDir === undefined) delete process.env.PIEVO_DATA_DIR;
    else process.env.PIEVO_DATA_DIR = previousDataDir;
    if (previousSelection === undefined) delete process.env.PIEVO_BLOB_STORE;
    else process.env.PIEVO_BLOB_STORE = previousSelection;
    for (const key of R2_KEYS) {
      const value = previousR2[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("complete R2 credentials preserve the existing R2 selection behavior", () => {
  const root = tempRoot();
  const previousDataDir = process.env.PIEVO_DATA_DIR;
  const previousSelection = process.env.PIEVO_BLOB_STORE;
  const previousR2 = Object.fromEntries(R2_KEYS.map((key) => [key, process.env[key]]));
  process.env.PIEVO_DATA_DIR = root;
  delete process.env.PIEVO_BLOB_STORE;
  process.env.PIEVO_R2_ENDPOINT = "https://example.invalid";
  process.env.PIEVO_R2_BUCKET = "bucket";
  process.env.PIEVO_R2_ACCESS_KEY_ID = "key";
  process.env.PIEVO_R2_SECRET_ACCESS_KEY = "secret";

  try {
    expect(createBlobStore()).toBeInstanceOf(R2BlobStore);
  } finally {
    if (previousDataDir === undefined) delete process.env.PIEVO_DATA_DIR;
    else process.env.PIEVO_DATA_DIR = previousDataDir;
    if (previousSelection === undefined) delete process.env.PIEVO_BLOB_STORE;
    else process.env.PIEVO_BLOB_STORE = previousSelection;
    for (const key of R2_KEYS) {
      const value = previousR2[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("memory storage is an explicit opt-in even in production", () => {
  const previousSelection = process.env.PIEVO_BLOB_STORE;
  const previousNodeEnv = process.env.NODE_ENV;
  try {
    process.env.PIEVO_BLOB_STORE = "memory";
    process.env.NODE_ENV = "production";
    expect(createBlobStore()).toBeInstanceOf(MemoryBlobStore);
  } finally {
    if (previousSelection === undefined) delete process.env.PIEVO_BLOB_STORE;
    else process.env.PIEVO_BLOB_STORE = previousSelection;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test("explicit R2 selection requires complete credentials", () => {
  const previousSelection = process.env.PIEVO_BLOB_STORE;
  const previousR2 = Object.fromEntries(R2_KEYS.map((key) => [key, process.env[key]]));
  try {
    process.env.PIEVO_BLOB_STORE = "r2";
    for (const key of R2_KEYS) delete process.env[key];
    expect(() => createBlobStore()).toThrow(/requires complete/i);
    process.env.PIEVO_R2_ENDPOINT = "https://example.invalid";
    process.env.PIEVO_R2_BUCKET = "bucket";
    process.env.PIEVO_R2_ACCESS_KEY_ID = "key";
    process.env.PIEVO_R2_SECRET_ACCESS_KEY = "secret";
    expect(createBlobStore()).toBeInstanceOf(R2BlobStore);
  } finally {
    if (previousSelection === undefined) delete process.env.PIEVO_BLOB_STORE;
    else process.env.PIEVO_BLOB_STORE = previousSelection;
    for (const key of R2_KEYS) {
      const value = previousR2[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("explicit partial R2 configuration fails instead of falling back to local", () => {
  const previousSelection = process.env.PIEVO_BLOB_STORE;
  const previousR2 = Object.fromEntries(R2_KEYS.map((key) => [key, process.env[key]]));
  process.env.PIEVO_BLOB_STORE = "r2";
  for (const key of R2_KEYS) delete process.env[key];
  process.env.PIEVO_R2_BUCKET = "configured-without-credentials";

  try {
    expect(() => createBlobStore()).toThrow(/incomplete R2 configuration/i);
  } finally {
    if (previousSelection === undefined) delete process.env.PIEVO_BLOB_STORE;
    else process.env.PIEVO_BLOB_STORE = previousSelection;
    for (const key of R2_KEYS) {
      const value = previousR2[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
