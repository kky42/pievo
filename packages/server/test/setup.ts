import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

const inheritedDeploymentKeys = [
  "DATABASE_URL",
  "DIRECT_DATABASE_URL",
  "PIEVO_DB_POOL_MODE",
  "PIEVO_BLOB_STORE",
  "PIEVO_R2_ACCOUNT_ID",
  "PIEVO_R2_BUCKET",
  "PIEVO_R2_ACCESS_KEY_ID",
  "PIEVO_R2_SECRET_ACCESS_KEY",
  "PIEVO_R2_ENDPOINT",
  "PIEVO_R2_REGION",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "PIEVO_AUTH_SECRET",
  "PIEVO_ALLOWED_LOGINS",
] as const;
for (const key of inheritedDeploymentKeys) delete process.env[key];
process.env.PIEVO_DB = "pglite";

// A static import can open PGlite before a test's own hooks run. Per-worker state
// prevents inherited deployment configuration from reaching a live database or
// blob store; individual tests may still replace it before dynamic imports.
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-server-test-"));
process.env.PIEVO_DATA_DIR = testDataDir;

afterAll(async () => {
  const client = (globalThis as typeof globalThis & {
    __pievoClient?: { close?: () => Promise<void>; end?: (options?: { timeout?: number }) => Promise<void> };
  }).__pievoClient;
  try {
    if (client?.close) await client.close();
    else if (client?.end) await client.end({ timeout: 1 });
  } catch {
    // Cleanup still removes state for tests that already closed their client.
  }
  fs.rmSync(testDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});
