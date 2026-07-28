import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

let tmp: string;
let boot: typeof import("./boot.js");
let store: typeof import("../db/store.js");

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-boot-"));
  process.env.PIEVO_DATA_DIR = tmp;
  process.env.PIEVO_LOG_LEVEL = "silent";
  boot = await import("./boot.js");
  store = await import("../db/store.js");
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("ensureServer migrates + boots the scheduler, idempotently", async () => {
  const a = await boot.ensureServer();
  const b = await boot.ensureServer();
  expect(a).toBe(b);
  expect(a.scheduler).toBeDefined();
  expect(await store.listLoops()).toEqual([]);
  expect(await store.listMachines()).toEqual([]);
});
