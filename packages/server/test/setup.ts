import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

// A static import can open PGlite before a test's own hooks run. Per-worker state
// keeps tests off the user's data dir; individual tests may still replace it
// before dynamic imports.
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-server-test-"));
process.env.PIEVO_DATA_DIR = testDataDir;

afterAll(async () => {
  const client = (globalThis as typeof globalThis & { __pievoClient?: { close(): Promise<void> } }).__pievoClient;
  try {
    await client?.close();
  } catch {
    // Cleanup still removes state for tests that already closed their client.
  }
  fs.rmSync(testDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});
