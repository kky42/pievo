import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

describe("runDaemon", () => {
  const saved = {
    home: process.env.PIEVO_HOME,
    token: process.env.PIEVO_TOKEN,
    server: process.env.PIEVO_SERVER_URL,
  };
  let home: string | undefined;

  afterEach(() => {
    for (const [k, v] of [
      ["PIEVO_HOME", saved.home],
      ["PIEVO_TOKEN", saved.token],
      ["PIEVO_SERVER_URL", saved.server],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (home) fs.rmSync(home, { recursive: true, force: true });
    home = undefined;
    vi.resetModules();
  });

  test("refuses to boot when a verified daemon already owns the pidfile", async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-daemon-"));
    vi.resetModules();
    process.env.PIEVO_HOME = home;
    process.env.PIEVO_TOKEN = "dk_test";
    process.env.PIEVO_SERVER_URL = "http://127.0.0.1:1";
    const { saveActiveConnection } = await import("./config.js");
    saveActiveConnection("http://127.0.0.1:1", "dk_test");

    const pidfile = await import("./pidfile.js");
    pidfile.writePidFile(process.pid);

    const { runDaemon } = await import("./daemon.js");
    const code = await runDaemon();
    expect(code).toBe(1);
    expect(pidfile.readPidFile()?.pid).toBe(process.pid);
  }, 15000);
});

describe("poll transport helpers", () => {
  test("buildPollBody: protocol v4 reports all active runs", async () => {
    const { buildPollBody } = await import("./daemon.js");
    const info = { host: "mac", platform: "darwin" };
    expect(buildPollBody(info, [], "daemon-1")).toEqual({ protocolVersion: 4, host: "mac", platform: "darwin", daemonInstanceId: "daemon-1", recoveryComplete: true, currentRuns: [] });
    expect(buildPollBody(info, [{ runId: "r1", stage: "reporting" }, { runId: "r2", stage: "executing" }], "daemon-1")).toEqual({
      protocolVersion: 4, host: "mac", platform: "darwin", daemonInstanceId: "daemon-1", recoveryComplete: true,
      currentRuns: [{ runId: "r1", stage: "reporting" }, { runId: "r2", stage: "executing" }],
    });
  });

  test("nextPollDelayMs: a held long-poll re-polls immediately; a fast answer keeps the cadence", async () => {
    const { nextPollDelayMs } = await import("./daemon.js");
    expect(nextPollDelayMs(200, 3000)).toBe(2800);
    expect(nextPollDelayMs(20_000, 3000)).toBe(250);
    expect(nextPollDelayMs(3000, 3000)).toBe(250);
  });
});
