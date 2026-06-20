import test from "node:test";
import assert from "node:assert/strict";

import { assertExpectations, assertTextExpectations } from "../e2e/scenario-assertions.js";

test("assertExpectations accepts replies, tool calls, schedules, attachments, and budgets", () => {
  const stepResult = {
    id: "one",
    durationMs: 1_500,
    events: [
      { kind: "text", text: "Here is the report" },
      { kind: "tool_call", tool: "send_reply", params: { text: "Here is the report" } },
      { kind: "tool_call", tool: "send_attachment", params: { path: "reports/out.txt" } },
      { kind: "attachment", payload: { entry: { path: "reports/out.txt", kind: "document" } } }
    ]
  };

  assert.doesNotThrow(() => assertExpectations({
    scenario: { mode: "group" },
    step: {
      expect: {
        replies: [{ contains: "report" }],
        toolCalls: {
          send_reply: 1,
          send_attachment: { min: 1, max: 1 }
        },
        attachments: { count: 1, pathContains: "out", kind: "document" },
        schedules: { contains: { name: "daily", mode: "heartbeat" } },
        budgets: { maxSeconds: 2 }
      }
    },
    stepResult,
    session: { schedules: [{ name: "daily", mode: "heartbeat", cron: "0 9 * * *" }] }
  }));
});

test("assertExpectations treats private final text as visible and rejects noReply", () => {
  assert.throws(
    () => assertExpectations({
      scenario: { mode: "private" },
      step: { expect: { noReply: true } },
      stepResult: { durationMs: 10, events: [{ kind: "final", text: "visible" }] },
      session: { schedules: [] }
    }),
    /noReply expected no visible texts/
  );
});

test("assertTextExpectations matches expectations in order", () => {
  assert.doesNotThrow(() => assertTextExpectations(
    ["first reply", "second reply"],
    [{ contains: "first" }, { matches: "second\\s+reply" }],
    "replies"
  ));
  assert.throws(
    () => assertTextExpectations(["second reply", "first reply"], [{ contains: "first" }, { contains: "second" }], "replies"),
    /replies: no text matched/
  );
});
