import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import { readRuntimeDiagnostics, writeRuntimeDiagnostics } from "./runtime-diagnostics.js";

let root = "";
afterEach(() => {
  vi.restoreAllMocks();
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = "";
});

test("an ENOSPC temp-file failure reuses the reserved status block", () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-runtime-status-"));
  const file = path.join(root, "runtime-status.json");
  writeRuntimeDiagnostics(file, { protocolVersion: 3, outboxPath: "/tmp/reports.sqlite" });
  expect(fs.statSync(file).size).toBe(4096);

  const realWrite = fs.writeFileSync.bind(fs);
  vi.spyOn(fs, "writeFileSync").mockImplementation(((target: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: unknown) => {
    if (String(target).endsWith(".tmp")) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    return realWrite(target, data, options as never);
  }) as typeof fs.writeFileSync);

  writeRuntimeDiagnostics(file, {
    protocolVersion: 3,
    persistenceError: "SQLITE_FULL: database or disk is full",
    outboxPath: "/tmp/reports.sqlite",
  });
  expect(readRuntimeDiagnostics(file)).toMatchObject({
    persistenceError: "SQLITE_FULL: database or disk is full",
    outboxPath: "/tmp/reports.sqlite",
  });
  expect(fs.statSync(file).size).toBe(4096);
});
