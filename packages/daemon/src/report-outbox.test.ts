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

  test("multiple reports retry independently and a poisoned row does not block another loop", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-outbox-"));
    const box = new PendingReportOutbox(path.join(root, "pending.sqlite"));
    const first = box.put("rk_1", report());
    const second = box.put("rk_2", report({ reportId: "22222222-2222-4222-8222-222222222222", runId: "run-2" }));

    box.applyAck({ kind: "conflict", reportId: first.reportId, error: "different payload" });
    expect(box.ready().map((row) => row.runId)).toEqual(["run-2"]);
    box.applyAck({ kind: "ack", reportId: second.reportId });
    expect(box.all().map((row) => row.runId)).toEqual(["run-1"]);
    expect(box.diagnostics()).toMatchObject({ pendingRunIds: ["run-1"], poisonedRunIds: ["run-1"] });
    box.close();
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

  test("a handled rejection ACK must match the exact payload digest and disposition", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-outbox-"));
    const box = new PendingReportOutbox(path.join(root, "pending.sqlite"));
    box.put("rk_secret", report());
    const pending = box.peek()!;
    const response = (payloadDigest: string, disposition: string) => new Response(JSON.stringify({
      ok: true, accepted: false, terminal: true, reportId: pending.reportId, payloadDigest, disposition, extra: "additive-ok",
    }), { status: 200 });

    box.applyAck(await sendTerminalReport("https://example.test", pending, async () => response("wrong", "run-error")));
    expect(box.peek()).toBeDefined();
    box.applyAck(await sendTerminalReport("https://example.test", pending, async () => response(pending.payloadDigest, "unknown")));
    expect(box.peek()).toBeDefined();
    box.applyAck(await sendTerminalReport("https://example.test", pending, async () => response(pending.payloadDigest, "run-error")));
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
    expect(box.diagnostics()).toMatchObject({ pendingRunIds: ["run-1"], poisonedRunIds: [] });
    box.applyAck(await sendTerminalReport("https://example.test", box.peek()!, async () => new Response(JSON.stringify({ code: "REPORT_CONFLICT", reportId: report().reportId }), { status: 409 })));
    expect(box.diagnostics()).toMatchObject({ pendingRunIds: ["run-1"], poisonedRunIds: ["run-1"] });
    expect(box.peek()).toBeDefined();
    box.close();
  });

  test("matching REPORT_INVALID poisons the report while a mismatched id remains retryable", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-outbox-"));
    const box = new PendingReportOutbox(path.join(root, "pending.sqlite"));
    box.put("rk_secret", report());
    box.applyAck(await sendTerminalReport("https://example.test", box.peek()!, async () => new Response(JSON.stringify({ code: "REPORT_INVALID", reportId: "wrong", issues: ["result"] }), { status: 422 })));
    expect(box.diagnostics().poisonedRunIds).toEqual([]);
    box.applyAck(await sendTerminalReport("https://example.test", box.peek()!, async () => new Response(JSON.stringify({ code: "REPORT_INVALID", reportId: report().reportId, issues: ["result"] }), { status: 422 })));
    expect(box.diagnostics()).toMatchObject({ poisonedRunIds: ["run-1"], pendingRunIds: ["run-1"] });
    expect(box.diagnostics().lastError).toContain("REPORT_INVALID");
    box.close();
  });
});
