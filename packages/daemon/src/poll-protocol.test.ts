import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { parsePollResponse } from "./poll-protocol.js";

function delivery() {
  return {
    runId: "run-1",
    runIndex: 1,
    runToken: "rk_00000000000000000000000000000000",
    loop: {
      id: "loop-1",
      name: "Canonical loop",
      workdir: path.join(os.tmpdir(), "pievo-work"),
      model: null,
      reasoningEffort: null,
      agent: "claude-code",
    },
    roots: [os.tmpdir()],
    task: "Do the work and report.",
    artifacts: ["report.md"],
  };
}

function response(overrides: Record<string, unknown> = {}) {
  return { delivery: delivery(), cancelRunIds: [], ...overrides };
}

describe("protocol-v4 poll response runtime schema", () => {
  test("accepts the exact complete runner delivery, including Pi on protocol v4", () => {
    expect(parsePollResponse(response())).toEqual({ ok: true, value: response() });
    const pi = response();
    pi.delivery.loop.agent = "pi";
    pi.delivery.loop.reasoningEffort = "xhigh";
    expect(parsePollResponse(pi)).toEqual({ ok: true, value: pi });
    expect(parsePollResponse({ delivery: null, cancelRunIds: ["run-2"] })).toEqual({
      ok: true,
      value: { delivery: null, cancelRunIds: ["run-2"] },
    });
  });

  test.each([
    ["missing roots", () => { const value: any = delivery(); delete value.roots; return value; }],
    ["missing agent", () => { const value: any = delivery(); delete value.loop.agent; return value; }],
    ["unknown agent", () => ({ ...delivery(), loop: { ...delivery().loop, agent: "claude" } })],
    ["relative workdir", () => ({ ...delivery(), loop: { ...delivery().loop, workdir: "relative/project" } })],
    ["wrong nullable field", () => ({ ...delivery(), loop: { ...delivery().loop, model: 42 } })],
    ["missing task", () => { const value: any = delivery(); delete value.task; return value; }],
    ["unknown nested field", () => ({ ...delivery(), loop: { ...delivery().loop, fallbackAgent: "claude-code" } })],
    ["unknown delivery field", () => ({ ...delivery(), retry: true })],
  ])("rejects %s before execution", (_label, malformed) => {
    const parsed = parsePollResponse(response({ delivery: malformed() }));
    expect(parsed).toMatchObject({ ok: false, error: expect.any(String) });
  });

  test("requires the exact top-level response and update envelopes", () => {
    expect(parsePollResponse({ delivery: null })).toMatchObject({ ok: false, error: expect.stringContaining("cancelRunIds") });
    expect(parsePollResponse({ delivery: null, cancelRunIds: [], extra: true })).toMatchObject({ ok: false, error: expect.stringContaining("unknown") });
    expect(parsePollResponse({
      delivery: null,
      cancelRunIds: [],
      needsUpdate: { current: null, required: "2.4.0" },
    })).toMatchObject({ ok: false, error: expect.stringContaining("command") });
  });

  test("never accepts a delivery together with an update requirement", () => {
    expect(parsePollResponse(response({
      needsUpdate: { current: "2.3.0", required: "2.4.0", command: "npm install" },
    }))).toMatchObject({ ok: false, error: expect.stringContaining("must not deliver") });
  });
});
