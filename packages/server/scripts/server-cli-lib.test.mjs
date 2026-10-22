import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  acquireStartLock,
  buildEnvPlan,
  pidStatus,
  processStartTime,
  readinessReady,
  recordedProcessState,
  terminateRecordedProcess,
} from "./server-cli-lib.mjs";

const tempDirs = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-server-cli-"));
  tempDirs.push(dir);
  return dir;
};

describe("launcher environment plan", () => {
  test("published defaults remain user-level and production-only", () => {
    const plan = buildEnvPlan({ command: "start" }, {});
    expect(plan.dataDir).toBe(path.join(os.homedir(), ".pievo-server"));
    expect(plan.port).toBe(3000);
    expect(plan.env.NODE_ENV).toBe("production");
  });

});

describe("nonce-bound readiness", () => {
  test("accepts only a successful ready response carrying this launch nonce", async () => {
    const response = (body, ok = true) => ({ ok, json: async () => body });
    expect(await readinessReady("http://example/ready", "new-launch", {
      fetch: vi.fn().mockResolvedValue(response({ ok: true, nonce: "new-launch" })),
      signal: new AbortController().signal,
    })).toBe(true);
    expect(await readinessReady("http://example/ready", "new-launch", {
      fetch: vi.fn().mockResolvedValue(response({ ok: true, nonce: "other-process" })),
      signal: new AbortController().signal,
    })).toBe(false);
    expect(await readinessReady("http://example/ready", "new-launch", {
      fetch: vi.fn().mockResolvedValue(response({ ok: true, nonce: "new-launch" }, false)),
      signal: new AbortController().signal,
    })).toBe(false);
  });
});

describe("safe pid identity", () => {
  const record = { version: 2, pid: 42, startTime: "start-42", host: "127.0.0.1", port: 3000, state: "running", launchNonce: "nonce", managedGroup: false };

  test("can identify the current process without relying on cwd", () => {
    expect(processStartTime(process.pid)).toEqual(expect.any(String));
  });

  test("accepts only a live process with the same start time", () => {
    expect(pidStatus("unused", {
      read: () => record,
      probe: () => "alive",
      startTime: () => record.startTime,
      clear: vi.fn(),
    })).toMatchObject({ state: "running", record });
  });

  test("treats exit between the liveness probe and start-time lookup as gone", () => {
    const probe = vi.fn()
      .mockReturnValueOnce("alive")
      .mockReturnValueOnce("gone");

    expect(recordedProcessState(record, {
      probe,
      startTime: () => undefined,
    })).toEqual({ state: "gone" });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  test("clears records only after death or verified pid reuse", () => {
    const clearDead = vi.fn();
    expect(pidStatus("unused", { read: () => record, probe: () => "gone", clear: clearDead })).toMatchObject({ state: "stopped", stale: true });
    expect(clearDead).toHaveBeenCalledOnce();

    const clearReused = vi.fn();
    expect(pidStatus("unused", {
      read: () => record,
      probe: () => "alive",
      startTime: () => "different",
      clear: clearReused,
    })).toMatchObject({ state: "stopped", stale: true });
    expect(clearReused).toHaveBeenCalledOnce();
  });

  test("retains malformed, non-v2, and unverifiable live records", () => {
    const dir = tempDir();
    const pidFile = path.join(dir, "server.pid");
    fs.writeFileSync(pidFile, "not json");
    expect(pidStatus(pidFile)).toMatchObject({ state: "unsafe", error: expect.stringMatching(/malformed/) });
    expect(fs.existsSync(pidFile)).toBe(true);

    fs.writeFileSync(pidFile, JSON.stringify({ ...record, version: 1 }));
    expect(pidStatus(pidFile)).toMatchObject({ state: "unsafe", error: expect.stringMatching(/malformed/) });
    expect(fs.existsSync(pidFile)).toBe(true);

    expect(pidStatus("unused", {
      read: () => record,
      probe: () => "alive",
      startTime: () => undefined,
      clear: vi.fn(),
    })).toMatchObject({ state: "unsafe", record });
  });
});

describe("verified stop", () => {
  const record = { pid: 42, startTime: "start-42", managedGroup: false };

  test("uses SIGKILL only after a graceful timeout and returns only after proven exit", async () => {
    const signal = vi.fn();
    const states = [{ state: "same" }, { state: "gone" }];
    const result = await terminateRecordedProcess(record, {
      probe: () => "alive",
      startTime: () => "start-42",
      signal,
      waitForGone: vi.fn().mockImplementation(async () => states.shift()),
    });
    expect(result).toEqual({ forced: true });
    expect(signal.mock.calls).toEqual([[42, "SIGTERM"], [42, "SIGKILL"]]);
  });

  test("treats an ESRCH signal race as success only after re-verifying death", async () => {
    let alive = true;
    const gone = Object.assign(new Error("gone"), { code: "ESRCH" });
    const result = await terminateRecordedProcess(record, {
      probe: () => alive ? "alive" : "gone",
      startTime: () => "start-42",
      signal: () => { alive = false; throw gone; },
      waitForGone: vi.fn(),
    });
    expect(result).toEqual({ forced: false });
  });

  test("fails closed without SIGKILL when identity becomes unverifiable", async () => {
    const signal = vi.fn();
    await expect(terminateRecordedProcess(record, {
      probe: () => "alive",
      startTime: () => "start-42",
      signal,
      waitForGone: async () => ({ state: "unsafe", error: "cannot verify identity" }),
    })).rejects.toThrow(/cannot verify identity/);
    expect(signal.mock.calls).toEqual([[42, "SIGTERM"]]);
  });

  test("fails when SIGKILL times out instead of claiming success", async () => {
    const signal = vi.fn();
    await expect(terminateRecordedProcess(record, {
      probe: () => "alive",
      startTime: () => "start-42",
      signal,
      waitForGone: async () => ({ state: "same" }),
    })).rejects.toThrow(/did not exit after SIGKILL/);
    expect(signal).toHaveBeenCalledTimes(2);
  });
});

describe("lifecycle lock recovery", () => {
  test("recovers dead and old malformed locks but keeps recent malformed locks", () => {
    const dataDir = tempDir();
    const plan = buildEnvPlan({ command: "start", dataDir }, {});
    fs.writeFileSync(plan.lockFile, JSON.stringify({ pid: 999_999_999, startTime: "gone" }));
    const releaseDead = acquireStartLock(plan);
    releaseDead();

    fs.writeFileSync(plan.lockFile, "partial");
    const old = new Date(Date.now() - 10_000);
    fs.utimesSync(plan.lockFile, old, old);
    const releaseMalformed = acquireStartLock(plan);
    releaseMalformed();

    fs.writeFileSync(plan.lockFile, "partial");
    expect(() => acquireStartLock(plan)).toThrow(/still being written/);
  });
});
