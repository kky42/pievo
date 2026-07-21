import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { buildPollBody, nextRunConflict, persistenceRetryDelayMs, SingleFlightRuntime } from "./daemon.js";
import { RUN_CANCEL_REASON, executeDelivery, type Delivery } from "./runner.js";
import { PendingReportOutbox } from "./report-outbox.js";
import { isAlive } from "./pidfile.js";

let root = "";
afterEach(() => { delete process.env.PIEVO_CLAUDE_BIN; delete process.env.PIEVO_CODEX_BIN; if (root) fs.rmSync(root, { recursive: true, force: true }); root = ""; });

function delivery(): Delivery {
  root ||= fs.mkdtempSync(path.join(os.tmpdir(), "pievo-v2-"));
  return { runId: "run-1", runToken: "rk_1", role: "exec", loop: { id: "loop-1", name: "one", workdir: root, taskFile: null, model: null, allowControl: false }, systemPrompt: "", task: "do it" };
}

describe("poll protocol v2", () => {
  test("advertises exactly one current run and only idles without a slot", () => {
    expect(buildPollBody({ host: "mac" }, null, "watch")).toEqual({ protocolVersion: 2, host: "mac", watchDigest: "watch" });
    expect(buildPollBody({ host: "mac" }, { runId: "r1", stage: "executing" }, undefined)).toEqual({ protocolVersion: 2, host: "mac", currentRun: { runId: "r1", stage: "executing" } });
  });

  test("keeps a run conflict until the local run has a definitive end", () => {
    const conflict = { daemonRunId: "run-a", serverRunId: "run-b" };
    expect(nextRunConflict(undefined, conflict, { runId: "run-a", stage: "executing" })).toEqual(conflict);
    expect(nextRunConflict(conflict, undefined, { runId: "run-a", stage: "reporting" })).toEqual(conflict);
    expect(nextRunConflict(conflict, undefined, null)).toBeUndefined();
  });
});

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  expect(check()).toBe(true);
}

function stubbornTreeSource(files: { ready: string; pids: string; terms: string }): string {
  const child = [
    `const fs=require('node:fs')`,
    `process.on('SIGTERM',()=>fs.appendFileSync(${JSON.stringify(files.terms)},'child\\n'))`,
    `fs.writeFileSync(${JSON.stringify(files.ready)},'ready')`,
    `setInterval(()=>{},1000)`,
  ].join(";");
  return [
    `const {spawn}=await import('node:child_process')`,
    `const fs=await import('node:fs')`,
    `process.on('SIGTERM',()=>fs.appendFileSync(${JSON.stringify(files.terms)},'parent\\n'))`,
    `const child=spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'})`,
    `fs.writeFileSync(${JSON.stringify(files.pids)},process.pid+','+child.pid)`,
    `await new Promise(()=>{})`,
  ].join(";");
}


describe("single-flight persistence boundary", () => {
  test("permanent local persistence failures back off to a fixed 30s ceiling", () => {
    expect([1, 2, 3, 4, 5, 99].map(persistenceRetryDelayMs)).toEqual([250, 1_000, 5_000, 30_000, 30_000, 30_000]);
  });
  test("persists before releasing the slot and replays reporting before accepting delivery", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-v2-"));
    const box = new PendingReportOutbox(path.join(root, "outbox.sqlite"));
    const events: string[] = [];
    const runtime = new SingleFlightRuntime(box, async () => {
      events.push("execute");
      return { reportId: "11111111-1111-4111-8111-111111111111", runId: "run-1", result: "success", durationMs: 1, exitCode: 0 };
    });
    await runtime.accept(delivery(), "https://example.test", []);
    expect(events).toEqual(["execute"]);
    expect(runtime.currentRun()).toEqual({ runId: "run-1", stage: "reporting" });
    expect(box.peek()?.runId).toBe("run-1");
    expect(await runtime.accept({ ...delivery(), runId: "run-2" }, "https://example.test", [])).toBe(false);
    box.close();
  });

  test("graceful shutdown waits for the interrupted run's report to become durable", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-v2-"));
    const box = new PendingReportOutbox(path.join(root, "outbox.sqlite"));
    const runtime = new SingleFlightRuntime(box, async (d, _server, _roots, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      // Report construction/cleanup can outlive the old fixed drain deadline.
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { reportId: "33333333-3333-4333-8333-333333333333", runId: d.runId, result: "failure", durationMs: 2, exitCode: null };
    });
    expect(runtime.start(delivery(), "https://example.test", [])).toBe(true);
    runtime.shutdown();
    await runtime.waitForPersistence();
    expect(runtime.currentRun()).toEqual({ runId: "run-1", stage: "reporting" });
    expect(box.peek()?.reportId).toBe("33333333-3333-4333-8333-333333333333");
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
    const runtime = new SingleFlightRuntime(
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
    const runtime = new SingleFlightRuntime(box, async () => ({ reportId: "44444444-4444-4444-8444-444444444444", runId: "run-1", result: "success", durationMs: 1, exitCode: 0 }));
    await runtime.accept(delivery(), "https://example.test", []);
    expect(runtime.cancel("run-1")).toBe(false);
    expect(JSON.parse(box.peek()!.payloadJson).result).toBe("success");
    box.close();
  });
});
