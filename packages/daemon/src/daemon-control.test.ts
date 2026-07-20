/**
 * `pievo daemon status` / `pievo daemon stop`, exercised with every external touch INJECTED
 * (pidfile read, liveness probe, start-time lookup, kill, server fetch, output) so
 * nothing reads a real ~/.pievo, signals a real process, or hits the network.
 */
import { describe, expect, test } from "vitest";

import { runDaemonStatus, runDaemonStop, type DaemonControlDeps } from "./daemon-control.js";

/** Capture stdout/stderr into strings for assertions. */
function capture(extra: DaemonControlDeps = {}): DaemonControlDeps & { stdout: () => string; stderr: () => string } {
  let out = "";
  let err = "";
  return {
    out: (s) => { out += s; },
    err: (s) => { err += s; },
    stdout: () => out,
    stderr: () => err,
    ...extra,
  };
}

describe("runDaemonStatus", () => {
  test("rejects arguments without reading or signaling the daemon", async () => {
    let read = false;
    const cap = capture({ readPid: () => { read = true; return undefined; } });
    expect(await runDaemonStatus(["--force"], cap)).toBe(2);
    expect(read).toBe(false);
    expect(cap.stderr()).toContain("pievo daemon status");
  });

  test("daemon running → reports pid", async () => {
    const cap = capture({ readPid: () => ({ pid: 4242 }), alive: () => true, server: "", token: undefined });
    const code = await runDaemonStatus([], cap);
    expect(code).toBe(0);
    expect(cap.stdout()).toContain("running (pid 4242)");
    expect(cap.stdout()).not.toContain("not running");
  });

  test("no pidfile → not running + hint", async () => {
    const cap = capture({ readPid: () => undefined, server: "", token: undefined });
    await runDaemonStatus([], cap);
    expect(cap.stdout()).toContain("not running");
    expect(cap.stdout()).toContain("pievo daemon start");
  });

  test("stale pidfile (pid dead) → not running, clears the stale file", async () => {
    let cleared = false;
    const cap = capture({
      readPid: () => ({ pid: 999 }),
      alive: () => false,
      clearPid: () => { cleared = true; },
      server: "",
      token: undefined,
    });
    await runDaemonStatus([], cap);
    expect(cleared).toBe(true);
    expect(cap.stdout()).toContain("not running");
  });

  test("pid alive but start-time mismatch (reused pid) → not running, clears stale file", async () => {
    let cleared = false;
    const cap = capture({
      readPid: () => ({ pid: 4242, startTime: "Mon Jun 30 09:00:00 2026" }),
      alive: () => true,
      startTime: () => "Mon Jun 30 17:30:00 2026",
      clearPid: () => { cleared = true; },
      server: "",
      token: undefined,
    });
    await runDaemonStatus([], cap);
    expect(cleared).toBe(true);
    expect(cap.stdout()).toContain("not running");
  });

  test("start-time unavailable at check time → degrades to alive-only, reports running", async () => {
    const cap = capture({
      readPid: () => ({ pid: 4242, startTime: "Mon Jun 30 09:00:00 2026" }),
      alive: () => true,
      startTime: () => undefined,
      server: "",
      token: undefined,
    });
    await runDaemonStatus([], cap);
    expect(cap.stdout()).toContain("running (pid 4242)");
  });

  test("server + token present → queries connection, shows online + name", async () => {
    let asked: [string, string] | undefined;
    const cap = capture({
      readPid: () => ({ pid: 1 }),
      alive: () => true,
      server: "https://srv.example",
      token: "dk_secret_abcdef",
      fetchOnline: async (s, t) => { asked = [s, t]; return { online: true, name: "MacBook" }; },
    });
    await runDaemonStatus([], cap);
    expect(asked).toEqual(["https://srv.example", "dk_secret_abcdef"]);
    expect(cap.stdout()).toContain("online (MacBook)");
    expect(cap.stdout()).toContain("https://srv.example");
    // Status is actionable-only: the credential is used, never displayed.
    expect(cap.stdout()).not.toContain("dk_secret_abcdef");
    expect(cap.stdout()).not.toContain("…abcdef");
  });

  test("server unreachable → connection unknown, never throws", async () => {
    const cap = capture({
      readPid: () => undefined,
      server: "https://srv.example",
      token: "dk_x",
      fetchOnline: async () => undefined,
    });
    await runDaemonStatus([], cap);
    expect(cap.stdout()).toContain("unknown — server unreachable");
  });

  test("no server/token → skips the server query entirely", async () => {
    let called = false;
    const cap = capture({
      readPid: () => undefined,
      server: "",
      token: undefined,
      fetchOnline: async () => { called = true; return undefined; },
    });
    await runDaemonStatus([], cap);
    expect(called).toBe(false);
    expect(cap.stdout()).toContain("no device token");
  });

  test("a poisoned durable report is actionable and visibly blocks work", async () => {
    const cap = capture({
      readPid: () => undefined, server: "", token: undefined,
      reportDiagnostics: () => ({ pendingRunId: "run-7", poisoned: true, lastError: "REPORT_CONFLICT: payload differs" }),
    });
    await runDaemonStatus([], cap);
    expect(cap.stdout()).toContain("terminal report: needs attention (run-7)");
    expect(cap.stdout()).toContain("REPORT_CONFLICT");
    expect(cap.stdout()).toContain("new work is blocked");
  });

  test("uses durable local runtime diagnostics for the truthful stage and blocked prior run", async () => {
    const cap = capture({
      readPid: () => ({ pid: 12 }), alive: () => true,
      server: "https://srv.example", token: "dk_x",
      runtimeDiagnostics: () => ({ currentRun: { runId: "run-local", stage: "reporting" }, cancelPending: true, blockedRunId: "run-old" }),
      fetchOnline: async () => ({ online: true, name: "MacBook", daemonProtocol: 2, currentRun: { runId: "run-local", stage: "executing" } }),
    });
    await runDaemonStatus([], cap);
    expect(cap.stdout()).toContain("current run: run-local (reporting)");
    expect(cap.stdout()).not.toContain("run-local (executing)");
    expect(cap.stdout()).toContain("cancel pending");
    expect(cap.stdout()).toContain("blocked prior run: run-old");
  });

  test("surfaces run conflicts and local report persistence failures actionably", async () => {
    const cap = capture({
      readPid: () => ({ pid: 12 }), alive: () => true,
      server: "", token: undefined,
      runtimeDiagnostics: () => ({
        protocolVersion: 2,
        currentRun: { runId: "run-local", stage: "reporting" },
        runConflict: { daemonRunId: "run-local", serverRunId: "run-server" },
        persistenceError: "SQLITE_FULL: database or disk is full",
        outboxPath: "/home/me/.pievo/pending-reports.sqlite",
      }),
    });
    await runDaemonStatus([], cap);
    expect(cap.stdout()).toContain("run conflict: daemon run-local, server run-server");
    expect(cap.stdout()).toContain("SQLITE_FULL");
    expect(cap.stdout()).toContain("/home/me/.pievo/pending-reports.sqlite");
    expect(cap.stdout()).toContain("new work is blocked");
  });

  test("shows protocol, current run, cancellation, and blocked-prior diagnostics from the server", async () => {
    const cap = capture({
      readPid: () => ({ pid: 12 }), alive: () => true,
      server: "https://srv.example", token: "dk_x",
      fetchOnline: async () => ({
        online: false, name: "MacBook", daemonProtocol: 1,
        currentRun: { runId: "run-9", stage: "executing", cancelPending: true },
        blockedRunId: "run-old",
      }),
    });
    await runDaemonStatus([], cap);
    expect(cap.stdout()).toContain("daemon upgrade required: protocol 1 -> 2");
    expect(cap.stdout()).toContain("current run: run-9 (executing)");
    expect(cap.stdout()).toContain("cancel pending");
    expect(cap.stdout()).toContain("previous run state is unknown");
    expect(cap.stdout()).toContain("no new work will start");
  });
});

describe("runDaemonStop", () => {
  test("running daemon → waits for verified old pid exit before clearing pidfile", async () => {
    const events: string[] = [];
    let running = true;
    const cap = capture({
      readPid: () => ({ pid: 4242, startTime: "old-start" }),
      alive: () => running,
      startTime: () => "old-start",
      kill: (_pid, sig) => { events.push(sig); },
      sleep: async () => { events.push("wait"); running = false; },
      clearPid: () => { events.push("clear"); },
    });
    const code = await runDaemonStop([], cap);
    expect(code).toBe(0);
    expect(events).toEqual(["SIGTERM", "wait", "clear"]);
    expect(cap.stdout()).toContain("stopped daemon (pid 4242)");
  });

  test("never SIGKILLs a daemon that is still persisting before handoff", async () => {
    const events: string[] = [];
    let running = true;
    let waits = 0;
    const cap = capture({
      readPid: () => ({ pid: 4242, startTime: "old-start" }),
      alive: () => running,
      startTime: () => "old-start",
      kill: (_pid, sig) => { events.push(sig); },
      sleep: async () => { waits += 1; if (waits === 105) running = false; },
      clearPid: () => { events.push("clear"); },
    });
    expect(await runDaemonStop([], cap)).toBe(0);
    expect(events).toEqual(["SIGTERM", "clear"]);
    expect(waits).toBe(105);
  });

  test("--force gives TERM a bounded drain window, then warns and SIGKILLs", async () => {
    const signals: NodeJS.Signals[] = [];
    let running = true;
    let waits = 0;
    const cap = capture({
      readPid: () => ({ pid: 4242, startTime: "old-start" }),
      alive: () => running,
      startTime: () => "old-start",
      kill: (_pid, signal) => { signals.push(signal); if (signal === "SIGKILL") running = false; },
      sleep: async () => { waits += 1; },
    });
    expect(await runDaemonStop(["--force"], cap)).toBe(0);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(waits).toBe(100);
    expect(cap.stderr()).toContain("may discard a terminal result");
  });

  test("--force refuses every signal without positive process identity", async () => {
    const signals: NodeJS.Signals[] = [];
    const cap = capture({
      readPid: () => ({ pid: 4242 }),
      alive: () => true,
      startTime: () => undefined,
      kill: (_pid, signal) => { signals.push(signal); },
      sleep: async () => {},
    });
    expect(await runDaemonStop(["--force"], cap)).toBe(1);
    expect(signals).toEqual([]);
    expect(cap.stderr()).toContain("identity cannot be confirmed");
  });

  test("rejects unknown stop flags without signaling", async () => {
    let killed = false;
    const cap = capture({ readPid: () => ({ pid: 4242 }), kill: () => { killed = true; } });
    expect(await runDaemonStop(["--wat"], cap)).toBe(2);
    expect(killed).toBe(false);
    expect(cap.stderr()).toContain("pievo daemon stop [--force]");
  });

  test("no daemon → clean no-op, never signals", async () => {
    let killed = false;
    const cap = capture({ readPid: () => undefined, kill: () => { killed = true; } });
    const code = await runDaemonStop([], cap);
    expect(code).toBe(0);
    expect(killed).toBe(false);
    expect(cap.stdout()).toContain("no daemon running");
  });

  test("reused pid (start-time mismatch) → never signaled, clears stale file", async () => {
    let killed = false;
    let cleared = false;
    const cap = capture({
      readPid: () => ({ pid: 4242, startTime: "Mon Jun 30 09:00:00 2026" }),
      alive: () => true,
      startTime: () => "Mon Jun 30 17:30:00 2026",
      clearPid: () => { cleared = true; },
      kill: () => { killed = true; },
    });
    const code = await runDaemonStop([], cap);
    expect(code).toBe(0);
    expect(killed).toBe(false);
    expect(cleared).toBe(true);
    expect(cap.stdout()).toContain("no daemon running");
  });

  test("race: pid dies between probe and signal (ESRCH) → clean no-op", async () => {
    let cleared = false;
    const cap = capture({
      readPid: () => ({ pid: 4242, startTime: "old-start" }),
      alive: () => true,
      startTime: () => "old-start",
      clearPid: () => { cleared = true; },
      kill: () => { const e = new Error("no such process") as NodeJS.ErrnoException; e.code = "ESRCH"; throw e; },
    });
    const code = await runDaemonStop([], cap);
    expect(code).toBe(0);
    expect(cleared).toBe(true);
    expect(cap.stdout()).toContain("no daemon running");
  });

  test("kill fails (EPERM) → reports error, exits non-zero", async () => {
    const cap = capture({
      readPid: () => ({ pid: 4242, startTime: "old-start" }),
      alive: () => true,
      startTime: () => "old-start",
      kill: () => { const e = new Error("operation not permitted") as NodeJS.ErrnoException; e.code = "EPERM"; throw e; },
    });
    const code = await runDaemonStop([], cap);
    expect(code).toBe(1);
    expect(cap.stderr()).toContain("could not stop daemon");
  });
});
