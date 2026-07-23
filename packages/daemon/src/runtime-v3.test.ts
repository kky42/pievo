import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { buildPollBody, ConcurrentRuntime, persistenceRetryDelayMs } from "./daemon.js";
import type { Delivery } from "./runner.js";
import { PendingReportOutbox } from "./report-outbox.js";

let root = "";
afterEach(() => { delete process.env.PIEVO_CLAUDE_BIN; delete process.env.PIEVO_CODEX_BIN; if (root) fs.rmSync(root, { recursive: true, force: true }); root = ""; });

function delivery(overrides: Partial<Delivery> = {}): Delivery {
  root ||= fs.mkdtempSync(path.join(os.tmpdir(), "pievo-v3-"));
  return { runId: "run-1", runIndex: 1, runToken: "rk_1", role: "exec", loop: { id: "loop-1", name: "one", workdir: root, taskFile: null, model: null, allowControl: false }, systemPrompt: "", task: "do it", ...overrides };
}

describe("poll protocol v3", () => {
  test("advertises every current run in one canonical shape", () => {
    expect(buildPollBody({ host: "mac" }, [], "watch")).toEqual({ protocolVersion: 3, host: "mac", currentRuns: [], watchDigest: "watch" });
    const runs = [{ runId: "r1", stage: "executing" as const }, { runId: "r2", stage: "reporting" as const }];
    expect(buildPollBody({ host: "mac" }, runs, undefined)).toEqual({ protocolVersion: 3, host: "mac", currentRuns: runs });
  });
});

describe("concurrent persistence boundary", () => {
  test("permanent local persistence failures back off to a fixed 30s ceiling", () => {
    expect([1, 2, 3, 4, 5, 99].map(persistenceRetryDelayMs)).toEqual([250, 1_000, 5_000, 30_000, 30_000, 30_000]);
  });
  test("persists each report before its run leaves reporting and accepts another loop concurrently", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-v2-"));
    const box = new PendingReportOutbox(path.join(root, "outbox.sqlite"));
    const events: string[] = [];
    const runtime = new ConcurrentRuntime(box, async (d) => {
      events.push(d.runId);
      return { reportId: d.runId === "run-1" ? "11111111-1111-4111-8111-111111111111" : "22222222-2222-4222-8222-222222222222", runId: d.runId, result: "success", durationMs: 1, exitCode: 0 };
    });
    await Promise.all([
      runtime.accept(delivery(), "https://example.test", []),
      runtime.accept(delivery({ runId: "run-2", runToken: "rk_2", loop: { ...delivery().loop, id: "loop-2" } }), "https://example.test", []),
    ]);
    expect(new Set(events)).toEqual(new Set(["run-1", "run-2"]));
    expect(new Set(runtime.currentRuns().map((run) => run.runId))).toEqual(new Set(["run-1", "run-2"]));
    expect(box.all().map((row) => row.runId)).toHaveLength(2);
    expect(await runtime.accept(delivery(), "https://example.test", [])).toBe(false);
    expect(await runtime.accept(delivery({ runId: "run-3", runToken: "rk_3" }), "https://example.test", [])).toBe(false);
    box.close();
  });

  test("drains durable reports sequentially and releases only their matching runs", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-v3-"));
    const box = new PendingReportOutbox(path.join(root, "outbox.sqlite"));
    box.put("rk_1", { reportId: "11111111-1111-4111-8111-111111111111", runId: "run-1", result: "success", durationMs: 1, exitCode: 0 });
    box.put("rk_2", { reportId: "22222222-2222-4222-8222-222222222222", runId: "run-2", result: "success", durationMs: 1, exitCode: 0 });
    let inFlight = 0;
    let maxInFlight = 0;
    const sent: string[] = [];
    const runtime = new ConcurrentRuntime(box, undefined, undefined, async (_server, report) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      sent.push(report.runId);
      await Promise.resolve();
      inFlight -= 1;
      return { kind: "ack", reportId: report.reportId };
    });
    await runtime.sendPending("https://example.test", true);
    expect(sent).toEqual(["run-1", "run-2"]);
    expect(maxInFlight).toBe(1);
    expect(runtime.currentRuns()).toEqual([]);
    box.close();
  });

  test("shutdown aborts report transport without consuming its durable row", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-v3-"));
    const box = new PendingReportOutbox(path.join(root, "outbox.sqlite"));
    box.put("rk_1", { reportId: "77777777-7777-4777-8777-777777777777", runId: "run-1", result: "success", durationMs: 1, exitCode: 0 });
    const runtime = new ConcurrentRuntime(box, undefined, undefined, async (_server, report, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { kind: "retry", reportId: report.reportId, error: "aborted" };
    });
    const sending = runtime.sendPending("https://example.test", true);
    runtime.shutdown();
    await runtime.waitForReportStop();
    await sending;
    expect(box.all().map((row) => row.runId)).toEqual(["run-1"]);
    box.close();
  });

  test("graceful shutdown waits for every interrupted run's report to become durable", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-v2-"));
    const box = new PendingReportOutbox(path.join(root, "outbox.sqlite"));
    const runtime = new ConcurrentRuntime(box, async (d, _server, _roots, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      // Report construction/cleanup can outlive the old fixed drain deadline.
      await new Promise((resolve) => setTimeout(resolve, 30));
      const reportId = d.runId === "run-1"
        ? "33333333-3333-4333-8333-333333333333"
        : "55555555-5555-4555-8555-555555555555";
      return { reportId, runId: d.runId, result: "failure", durationMs: 2, exitCode: null };
    });
    expect(runtime.start(delivery(), "https://example.test", [])).toBe(true);
    expect(runtime.start(delivery({ runId: "run-2", runToken: "rk_2", loop: { ...delivery().loop, id: "loop-2" } }), "https://example.test", [])).toBe(true);
    runtime.shutdown();
    await runtime.waitForPersistence();
    expect(new Set(runtime.currentRuns().map((run) => `${run.runId}:${run.stage}`))).toEqual(new Set(["run-1:reporting", "run-2:reporting"]));
    expect(new Set(box.all().map((row) => row.runId))).toEqual(new Set(["run-1", "run-2"]));
    box.close();
  });

  test("transient local persistence failure is retried instead of letting shutdown exit", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-v2-"));
    const box = new PendingReportOutbox(path.join(root, "outbox.sqlite"));
    const put = box.put.bind(box);
    let attempts = 0;
    box.put = ((...args: Parameters<typeof box.put>) => {
      attempts += 1;
      if (attempts === 1) throw new Error("database temporarily busy");
      return put(...args);
    }) as typeof box.put;
    const states: Array<{ persistenceError?: string; outboxPath: string }> = [];
    const runtime = new ConcurrentRuntime(
      box,
      async () => ({ reportId: "66666666-6666-4666-8666-666666666666", runId: "run-1", result: "failure", durationMs: 1, exitCode: null }),
      (state) => states.push(state),
    );
    await runtime.accept(delivery(), "https://example.test", []);
    expect(attempts).toBe(2);
    expect(states.some((state) => state.persistenceError === "database temporarily busy" && state.outboxPath.endsWith("outbox.sqlite"))).toBe(true);
    expect(states.at(-1)?.persistenceError).toBeUndefined();
    expect(box.peek()?.reportId).toBe("66666666-6666-4666-8666-666666666666");
    box.close();
  });

  test("a late cancel cannot rewrite a report already in reporting", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-v2-"));
    const box = new PendingReportOutbox(path.join(root, "outbox.sqlite"));
    const runtime = new ConcurrentRuntime(box, async () => ({ reportId: "44444444-4444-4444-8444-444444444444", runId: "run-1", result: "success", durationMs: 1, exitCode: 0 }));
    await runtime.accept(delivery(), "https://example.test", []);
    expect(runtime.cancel("run-1")).toBe(false);
    expect(JSON.parse(box.peek()!.payloadJson).result).toBe("success");
    box.close();
  });
});
