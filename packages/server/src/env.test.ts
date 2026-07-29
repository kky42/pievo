import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import { dataDir } from "./env.js";

// Harness-isolation guard: static imports must never reach user-level state
// before a test file can install its own temporary directory.
test("tests never resolve the real ~/.pievo data dir", () => {
  expect(dataDir()).not.toBe(path.join(os.homedir(), ".pievo"));
  expect(process.env.PIEVO_DATA_DIR).toBeTruthy();
});

test("tests discard inherited deployment storage credentials", () => {
  expect(process.env.DATABASE_URL).toBeUndefined();
  expect(process.env.DIRECT_DATABASE_URL).toBeUndefined();
  expect(process.env.PIEVO_R2_SECRET_ACCESS_KEY).toBeUndefined();
  expect(process.env.PIEVO_DB).toBe("pglite");
});
