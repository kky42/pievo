import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { PendingReportOutbox, sendTerminalReport, type TerminalReport } from "./report-outbox.js";

let root = "";
afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); root = ""; });

function report(overrides: Partial<TerminalReport> = {}): TerminalReport {
  return { reportId: "11111111-1111-4111-8111-111111111111", runId: "run-1", result: "success", durationMs: 10, exitCode: 0, ...overrides };
}

describe("PendingReportOutbox", () => {
  test("persists the exact terminal payload and token across a restart", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-outbox-"));
    const file = path.join(root, "pending.sqlite");
    const first = new PendingReportOutbox(file);
    const stored = first.put("rk_secret", report());
    first.close();

    const reopened = new PendingReportOutbox(file);
    expect(reopened.peek()).toMatchObject({ runId: "run-1", runToken: "rk_secret", payloadJson: stored.payloadJson, payloadDigest: stored.payloadDigest });
    expect(JSON.parse(reopened.peek()!.payloadJson)).toEqual(report());
    expect(fs.statSync(file).mode & 0o077).toBe(0);
    reopened.close();
  });

  test("only a matching structured ACK or RETIRED removes a report", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-outbox-"));
    const box = new PendingReportOutbox(path.join(root, "pending.sqlite"));
    box.put("rk_secret", report());
    const responses = [
      new Response("{}", { status: 500 }),
      new Response(JSON.stringify({ reportId: "other" }), { status: 200 }),
      new Response(JSON.stringify({ reportId: report().reportId }), { status: 200 }),
    ];
    for (let i = 0; i < responses.length; i++) {
      const ack = await sendTerminalReport("https://example.test", box.peek()!, async () => responses[i]);
      box.applyAck(ack);
      expect(Boolean(box.peek())).toBe(i < 2);
    }
    box.put("rk_retired", report({ reportId: "22222222-2222-4222-8222-222222222222", runId: "run-2" }));
    box.applyAck(await sendTerminalReport("https://example.test", box.peek()!, async () => new Response(JSON.stringify({ code: "RETIRED", reportId: "wrong" }), { status: 410 })));
    expect(box.peek()).toBeDefined();
    box.applyAck(await sendTerminalReport("https://example.test", box.peek()!, async () => new Response(JSON.stringify({ code: "RETIRED", reportId: "22222222-2222-4222-8222-222222222222" }), { status: 410 })));
    expect(box.peek()).toBeUndefined();
    box.close();
  });

  test("a lost ACK retries the byte-identical report without losing it", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-outbox-"));
    const box = new PendingReportOutbox(path.join(root, "pending.sqlite"));
    box.put("rk_secret", report());
    const sent: string[] = [];
    const first = await sendTerminalReport("https://example.test", box.peek()!, async (_url, init) => {
      sent.push(String(init.body));
      throw new Error("connection dropped after server commit");
    });
    box.applyAck(first, 0);
    expect(box.peek()).toBeDefined();
    const second = await sendTerminalReport("https://example.test", box.peek()!, async (_url, init) => {
      sent.push(String(init.body));
      return new Response(JSON.stringify({ reportId: report().reportId }), { status: 200 });
    });
    box.applyAck(second);
    expect(sent[1]).toBe(sent[0]);
    expect(box.peek()).toBeUndefined();
    box.close();
  });

  test("REPORT_CONFLICT poisons the report and blocks retry without deleting it", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-outbox-"));
    const box = new PendingReportOutbox(path.join(root, "pending.sqlite"));
    box.put("rk_secret", report());
    box.applyAck(await sendTerminalReport("https://example.test", box.peek()!, async () => new Response(JSON.stringify({ code: "REPORT_CONFLICT", reportId: "wrong" }), { status: 409 })));
    expect(box.diagnostics()).toMatchObject({ pendingRunId: "run-1", poisoned: false });
    box.applyAck(await sendTerminalReport("https://example.test", box.peek()!, async () => new Response(JSON.stringify({ code: "REPORT_CONFLICT", reportId: report().reportId }), { status: 409 })));
    expect(box.diagnostics()).toMatchObject({ pendingRunId: "run-1", poisoned: true });
    expect(box.peek()).toBeDefined();
    box.close();
  });

  test("matching REPORT_INVALID poisons the report while a mismatched id remains retryable", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-outbox-"));
    const box = new PendingReportOutbox(path.join(root, "pending.sqlite"));
    box.put("rk_secret", report());
    box.applyAck(await sendTerminalReport("https://example.test", box.peek()!, async () => new Response(JSON.stringify({ code: "REPORT_INVALID", reportId: "wrong", issues: ["result"] }), { status: 422 })));
    expect(box.diagnostics().poisoned).toBe(false);
    box.applyAck(await sendTerminalReport("https://example.test", box.peek()!, async () => new Response(JSON.stringify({ code: "REPORT_INVALID", reportId: report().reportId, issues: ["result"] }), { status: 422 })));
    expect(box.diagnostics()).toMatchObject({ poisoned: true, pendingRunId: "run-1" });
    expect(box.diagnostics().lastError).toContain("REPORT_INVALID");
    box.close();
  });
});
