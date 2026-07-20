import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

let home = "";
const saved = { home: process.env.PIEVO_HOME, token: process.env.PIEVO_TOKEN, server: process.env.PIEVO_SERVER_URL };

afterEach(() => {
  for (const [key, value] of [["PIEVO_HOME", saved.home], ["PIEVO_TOKEN", saved.token], ["PIEVO_SERVER_URL", saved.server]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  if (home) fs.rmSync(home, { recursive: true, force: true });
  home = "";
  vi.doUnmock("./http.js");
  vi.resetModules();
});

describe("runDaemon startup ordering", () => {
  test("attempts a persisted report replay before its first machine poll", async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-startup-"));
    process.env.PIEVO_HOME = home;
    process.env.PIEVO_TOKEN = "dk_startup";
    process.env.PIEVO_SERVER_URL = "https://server.test";
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
          return new Response(JSON.stringify({ delivery: null }), { status: 200 });
        }
        throw new Error(`unexpected request ${url}`);
      },
    }));

    const { PendingReportOutbox } = await import("./report-outbox.js");
    const box = new PendingReportOutbox(path.join(home, "pending-reports.sqlite"));
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
