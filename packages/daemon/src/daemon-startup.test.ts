import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

let home = "";
const saved = { home: process.env.PIEVO_HOME, token: process.env.PIEVO_TOKEN, server: process.env.PIEVO_SERVER_URL, pollMs: process.env.PIEVO_POLL_MS };

afterEach(() => {
  for (const [key, value] of [["PIEVO_HOME", saved.home], ["PIEVO_TOKEN", saved.token], ["PIEVO_SERVER_URL", saved.server], ["PIEVO_POLL_MS", saved.pollMs]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  if (home) fs.rmSync(home, { recursive: true, force: true });
  home = "";
  vi.doUnmock("./http.js");
  vi.doUnmock("./runner.js");
  vi.resetModules();
});

describe("runDaemon startup ordering", () => {
  test("rejects an invalid delivery without execution and retries polling", async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-startup-invalid-"));
    process.env.PIEVO_HOME = home;
    process.env.PIEVO_TOKEN = "dk_startup";
    process.env.PIEVO_SERVER_URL = "https://server.test";
    process.env.PIEVO_POLL_MS = "1";
    const { saveActiveConnection } = await import("./config.js");
    saveActiveConnection("https://server.test", "dk_startup");
    const execute = vi.fn();
    let polls = 0;

    vi.doMock("./runner.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./runner.js")>()),
      executeDelivery: execute,
    }));
    vi.doMock("./http.js", () => ({
      boundedFetch: async (url: string) => {
        if (!url.endsWith("/api/machine/poll")) throw new Error(`unexpected request ${url}`);
        polls += 1;
        if (polls === 1) {
          return new Response(JSON.stringify({
            delivery: {
              runId: "run-invalid",
              runIndex: 1,
              runToken: "rk_00000000000000000000000000000000",
              loop: { id: "loop-1", name: "bad", workdir: home, model: null, reasoningEffort: null, agent: "unknown" },
              roots: [],
              task: "must not execute",
              artifacts: [],
            },
            cancelRunIds: [],
          }), { status: 200 });
        }
        setTimeout(() => process.emit("SIGTERM"), 0);
        return new Response(JSON.stringify({ delivery: null, cancelRunIds: [] }), { status: 200 });
      },
    }));

    const { runDaemon } = await import("./daemon.js");
    expect(await runDaemon()).toBe(0);
    expect(polls).toBeGreaterThanOrEqual(2);
    expect(execute).not.toHaveBeenCalled();
  }, 15000);

  test("attempts a persisted report replay before its first machine poll", async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-startup-"));
    process.env.PIEVO_HOME = home;
    process.env.PIEVO_TOKEN = "dk_startup";
    process.env.PIEVO_SERVER_URL = "https://server.test";
    const { saveActiveConnection, serverOutboxPath } = await import("./config.js");
    saveActiveConnection("https://server.test", "dk_startup");
    const events: string[] = [];

    vi.doMock("./http.js", () => ({
      boundedFetch: async (url: string, init: RequestInit) => {
        if (url.endsWith("/machine/report")) {
          events.push("report");
          const body = JSON.parse(String(init.body));
          return new Response(JSON.stringify({ reportId: body.reportId }), { status: 200 });
        }
        if (url.endsWith("/api/machine/poll")) {
          events.push("poll");
          setTimeout(() => process.emit("SIGTERM"), 0);
          return new Response(JSON.stringify({ delivery: null, cancelRunIds: [] }), { status: 200 });
        }
        throw new Error(`unexpected request ${url}`);
      },
    }));

    const { PendingReportOutbox } = await import("./report-outbox.js");
    const box = new PendingReportOutbox(serverOutboxPath("https://server.test"));
    box.put("rk_pending", {
      reportId: "55555555-5555-4555-8555-555555555555",
      runId: "run-pending",
      result: "success",
      durationMs: 1,
      exitCode: 0,
    });
    box.close();

    const { runDaemon } = await import("./daemon.js");
    expect(await runDaemon()).toBe(0);
    expect(events.slice(0, 2)).toEqual(["report", "poll"]);
  }, 15000);
});
