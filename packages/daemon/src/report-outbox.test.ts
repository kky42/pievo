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
    expect(reopened.all()[0]).toMatchObject({ runId: "run-1", runToken: "rk_secret", payloadJson: stored.payloadJson, payloadDigest: stored.payloadDigest });
    expect(JSON.parse(reopened.all()[0]!.payloadJson)).toEqual(report());
    expect(fs.statSync(file).mode & 0o077).toBe(0);
    reopened.close();
  });

  test("multiple reports retry independently and one failed row does not block another loop", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-outbox-"));
    const box = new PendingReportOutbox(path.join(root, "pending.sqlite"));
    const first = box.put("rk_1", report(), 0);
    const second = box.put("rk_2", report({ reportId: "22222222-2222-4222-8222-222222222222", runId: "run-2" }), 0);

    box.applyAck({ kind: "retry", reportId: first.reportId, error: "unrecognized acknowledgement" }, 0);
    expect(box.ready(0).map((row) => row.runId)).toEqual(["run-2"]);
    box.applyAck({ kind: "ack", reportId: second.reportId });
    expect(box.all().map((row) => row.runId)).toEqual(["run-1"]);
    expect(box.diagnostics()).toMatchObject({ pendingRunIds: ["run-1"], lastError: "unrecognized acknowledgement" });
    expect(box.ready(1_000).map((row) => row.runId)).toEqual(["run-1"]);
    box.close();
  });

  test("only a matching structured ACK or RETIRED removes a report", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-outbox-"));
    const box = new PendingReportOutbox(path.join(root, "pending.sqlite"));
    box.put("rk_secret", report());
    const responses = [
      new Response("{}", { status: 500 }),
      new Response(JSON.stringify({ reportId: "other" }), { status: 200 }),
      new Response(JSON.stringify({ ok: true, reportId: report().reportId }), { status: 200 }),
    ];
    for (let i = 0; i < responses.length; i++) {
      const ack = await sendTerminalReport("https://example.test", box.all()[0]!, async () => responses[i]);
      box.applyAck(ack);
      expect(box.all().length > 0).toBe(i < 2);
    }
    box.put("rk_retired", report({ reportId: "22222222-2222-4222-8222-222222222222", runId: "run-2" }));
    box.applyAck(await sendTerminalReport("https://example.test", box.all()[0]!, async () => new Response(JSON.stringify({ error: "execution authority retired", code: "RETIRED", reportId: "wrong" }), { status: 410 })));
    expect(box.all()).toHaveLength(1);
    box.applyAck(await sendTerminalReport("https://example.test", box.all()[0]!, async () => new Response(JSON.stringify({ error: "execution authority retired", code: "RETIRED", reportId: "22222222-2222-4222-8222-222222222222" }), { status: 410 })));
    expect(box.all()).toHaveLength(0);
    box.close();
  });

  test("a handled rejection ACK must exactly match the current digest-bound contract", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-outbox-"));
    const box = new PendingReportOutbox(path.join(root, "pending.sqlite"));
    box.put("rk_secret", report());
    const pending = box.all()[0]!;
    const response = (payloadDigest: string, disposition: string, extra = false) => new Response(JSON.stringify({
      ok: true, accepted: false, terminal: true, reportId: pending.reportId,
      code: "REPORT_INVALID", issues: ["usage.inputTokens must be an integer"],
      payloadDigest, disposition, ...(extra ? { extra: "not-current" } : {}),
    }), { status: 200 });

    box.applyAck(await sendTerminalReport("https://example.test", pending, async () => response("wrong", "run-error")));
    expect(box.all()).toHaveLength(1);
    box.applyAck(await sendTerminalReport("https://example.test", pending, async () => response(pending.payloadDigest, "unknown")));
    expect(box.all()).toHaveLength(1);
    box.applyAck(await sendTerminalReport("https://example.test", pending, async () => response(pending.payloadDigest, "run-error", true)));
    expect(box.all()).toHaveLength(1);
    box.applyAck(await sendTerminalReport("https://example.test", pending, async () => response(pending.payloadDigest, "run-error")));
    expect(box.all()).toHaveLength(0);
    box.close();
  });

  test("a lost ACK retries the byte-identical report without losing it", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-outbox-"));
    const box = new PendingReportOutbox(path.join(root, "pending.sqlite"));
    box.put("rk_secret", report());
    const sent: string[] = [];
    const first = await sendTerminalReport("https://example.test", box.all()[0]!, async (_url, init) => {
      sent.push(String(init.body));
      throw new Error("connection dropped after server commit");
    });
    box.applyAck(first, 0);
    expect(box.all()).toHaveLength(1);
    const second = await sendTerminalReport("https://example.test", box.all()[0]!, async (_url, init) => {
      sent.push(String(init.body));
      return new Response(JSON.stringify({ ok: true, reportId: report().reportId }), { status: 200 });
    });
    box.applyAck(second);
    expect(sent[1]).toBe(sent[0]);
    expect(box.all()).toHaveLength(0);
    box.close();
  });

  test.each([
    [409, "REPORT_CONFLICT"],
    [422, "REPORT_INVALID"],
  ])("non-current %i %s is diagnostic and retryable, never a terminal ACK", async (status, code) => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-outbox-"));
    const box = new PendingReportOutbox(path.join(root, "pending.sqlite"));
    box.put("rk_secret", report());
    const ack = await sendTerminalReport("https://example.test", box.all()[0]!, async () => new Response(JSON.stringify({ code, reportId: report().reportId }), { status }));
    expect(ack).toMatchObject({ kind: "retry", error: expect.stringContaining(`${status} ${code}`) });
    box.applyAck(ack, 0);
    expect(box.diagnostics()).toMatchObject({ pendingRunIds: ["run-1"], lastError: expect.stringContaining(code) });
    expect(box.ready(1_000).map((row) => row.runId)).toEqual(["run-1"]);
    box.close();
  });
});
