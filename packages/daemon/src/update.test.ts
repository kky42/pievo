/**
 * `pievo update`, exercised with every external touch INJECTED (pid check,
 * down, ensure, version reads, output) so nothing spawns a process or hits the
 * network.
 */
import { describe, expect, test } from "vitest";

import { runUpdate, type UpdateDeps } from "./update.js";

type Cap = UpdateDeps & { stdout: () => string; stderr: () => string; downCalls: () => number; ensureCalls: () => Array<{ force?: boolean }> };

function seams(extra: UpdateDeps = {}): Cap {
  let out = "";
  let err = "";
  let downCalls = 0;
  const ensureCalls: Array<{ force?: boolean }> = [];
  return {
    localPid: () => 4242,
    readServer: () => "http://srv",
    readToken: () => "dk_stored",
    currentVersion: () => "0.9.0",
    runningVersion: () => "0.8.0",
    down: async () => { downCalls += 1; return 0; },
    ensure: async (_args, _injected, opts) => { ensureCalls.push(opts ?? {}); return 0; },
    out: (s) => { out += s; },
    err: (s) => { err += s; },
    stdout: () => out,
    stderr: () => err,
    downCalls: () => downCalls,
    ensureCalls: () => ensureCalls,
    ...extra,
  };
}

describe("runUpdate", () => {
  test("not connected (no server/token) → usage error, exit 2, never stops/starts", async () => {
    const cap = seams({ readServer: () => "", readToken: () => undefined });
    const code = await runUpdate([], cap);
    expect(code).toBe(2);
    expect(cap.downCalls()).toBe(0);
    expect(cap.ensureCalls().length).toBe(0);
    expect(cap.stderr()).toContain("not connected");
  });

  test("no daemon running → behaves like up (ensure, no force), never stops", async () => {
    const cap = seams({ localPid: () => undefined });
    const code = await runUpdate([], cap);
    expect(code).toBe(0);
    expect(cap.downCalls()).toBe(0);
    expect(cap.ensureCalls()).toEqual([{}]); // plain up, not forced
    expect(cap.stdout()).toContain("no daemon running — starting v0.9.0");
  });

  test("daemon running → stop then force-start, old→new summary", async () => {
    const cap = seams();
    const code = await runUpdate([], cap);
    expect(code).toBe(0);
    expect(cap.downCalls()).toBe(1);
    expect(cap.ensureCalls()).toEqual([{ force: true }]);
    expect(cap.stdout()).toContain("updating v0.8.0 → v0.9.0 (pid 4242)");
    expect(cap.stdout()).toContain("terminal-report persistence is awaited");
    expect(cap.stdout()).toContain("updated: v0.8.0 → v0.9.0");
  });

  test("--force forwards the explicit data-loss escape hatch to down", async () => {
    let downArgs: string[] | undefined;
    const cap = seams({ down: async (args) => { downArgs = args; return 0; } });
    expect(await runUpdate(["--force"], cap)).toBe(0);
    expect(downArgs).toEqual(["--force"]);
  });

  test("rejects unknown update flags without stopping or starting", async () => {
    const cap = seams();
    expect(await runUpdate(["--wat"], cap)).toBe(2);
    expect(cap.downCalls()).toBe(0);
    expect(cap.ensureCalls()).toHaveLength(0);
    expect(cap.stderr()).toContain("pievo update [--force]");
  });

  test("replacement starts only after down has verified the old daemon exited", async () => {
    const events: string[] = [];
    const cap = seams({
      down: async () => { events.push("term"); await Promise.resolve(); events.push("old-exited"); return 0; },
      ensure: async () => { events.push("replacement-start"); return 0; },
    });
    expect(await runUpdate([], cap)).toBe(0);
    expect(events).toEqual(["term", "old-exited", "replacement-start"]);
  });

  test("old version unknown (older daemon, no version file) → honest wording, still updates", async () => {
    const cap = seams({ runningVersion: () => undefined });
    const code = await runUpdate([], cap);
    expect(code).toBe(0);
    expect(cap.stdout()).toContain("updating the running daemon → v0.9.0");
    expect(cap.stdout()).toContain("updated to v0.9.0");
  });

  test("stop fails → abort, never starts a new daemon", async () => {
    const cap = seams({ down: async () => 1 });
    const code = await runUpdate([], cap);
    expect(code).toBe(1);
    expect(cap.ensureCalls().length).toBe(0);
    expect(cap.stderr()).toContain("could not stop");
  });

  test("start fails after stop → returns the ensure code, no summary line", async () => {
    const cap = seams({ ensure: async (_a, _i, opts) => { void opts; return 1; } });
    const code = await runUpdate([], cap);
    expect(code).toBe(1);
    expect(cap.downCalls()).toBe(1);
    expect(cap.stdout()).not.toContain("updated");
  });
});
