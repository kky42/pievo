/**
 * `pievo up`, exercised with every external touch INJECTED (status fetch,
 * spawn, kill, sleep, local pidfile check, persistence, output) so nothing hits
 * the network, spawns a process, or writes the real ~/.pievo.
 */
import { describe, expect, test } from "vitest";

import { buildDaemonSpawn, runEnsure, type EnsureDeps } from "./ensure.js";
import type { InstallOpts } from "./skill-install.js";

type Cap = EnsureDeps & {
  stdout: () => string;
  stderr: () => string;
  spawned: () => number;
  killed: () => Array<[number, string]>;
  skillInstalls: () => InstallOpts[];
};

/** Baseline seams: nothing running, server unreachable, spawn returns pid 555. The
 *  skill refresh is stubbed so no test spawns npx / hits the network. */
function seams(extra: EnsureDeps = {}): Cap {
  let out = "";
  let err = "";
  let spawned = 0;
  const killed: Array<[number, string]> = [];
  const skillInstalls: InstallOpts[] = [];
  return {
    fetchStatus: async () => undefined,
    spawnDaemon: () => { spawned += 1; return 555; },
    kill: (pid, sig) => { killed.push([pid, sig]); },
    sleep: async () => {},
    localPid: () => undefined,
    persist: () => {},
    readToken: () => "dk_stored",
    installSkill: async (opts) => { skillInstalls.push(opts); return { ok: true, line: "pievo skill: installed → ~/.claude/skills/pievo" }; },
    // No-op the PATH shim so no test writes the real ~/.local/bin.
    ensureBinShim: () => {},
    out: (s) => { out += s; },
    err: (s) => { err += s; },
    stdout: () => out,
    stderr: () => err,
    spawned: () => spawned,
    killed: () => killed,
    skillInstalls: () => skillInstalls,
    ...extra,
  };
}

describe("runEnsure — local pidfile first (no daemon leaks)", () => {
  test("a live local daemon short-circuits: never spawns a second one even when the server is unreachable", async () => {
    const cap = seams({ localPid: () => 4242, fetchStatus: async () => undefined });
    const code = await runEnsure(["--server-url", "http://srv"], cap);
    expect(code).toBe(0);
    expect(cap.spawned()).toBe(0);
    expect(cap.stdout()).toContain("already running locally (pid 4242)");
  });

  test("a live local daemon that the server also sees online → the classic already-running message", async () => {
    const cap = seams({ localPid: () => 4242, fetchStatus: async () => ({ online: true, name: "MacBook" }) });
    const code = await runEnsure(["--server-url", "http://srv"], cap);
    expect(code).toBe(0);
    expect(cap.spawned()).toBe(0);
    expect(cap.stdout()).toContain("daemon already running for this machine (MacBook)");
  });
});

describe("runEnsure — readiness", () => {
  test("daemon comes online with a fresh heartbeat → success, spawned once, never killed", async () => {
    let calls = 0;
    const cap = seams({
      // Pre-spawn check is offline, then the spawned daemon advances lastSeen.
      fetchStatus: async () => (++calls >= 2
        ? { online: true, name: "MacBook", lastSeen: "2026-07-19T10:00:01.000Z" }
        : { online: false, name: null, lastSeen: "2026-07-19T10:00:00.000Z" }),
    });
    const code = await runEnsure(["--server-url", "http://srv"], cap);
    expect(code).toBe(0);
    expect(cap.spawned()).toBe(1);
    expect(cap.killed()).toEqual([]);
    expect(cap.stdout()).toContain("daemon online");
  });

  test("stale server presence neither suppresses spawn nor satisfies readiness", async () => {
    const stale = { online: true, name: "MacBook", lastSeen: "2026-07-19T10:00:00.000Z" };
    const cap = seams({ fetchStatus: async () => stale });
    const code = await runEnsure(["--server-url", "http://srv"], cap);
    expect(code).toBe(1);
    expect(cap.spawned()).toBe(1);
    expect(cap.killed()).toEqual([[555, "SIGTERM"]]);
  });

  test("a missing lastSeen never satisfies readiness", async () => {
    const cap = seams({ fetchStatus: async () => ({ online: true, name: null }) });
    const code = await runEnsure(["--server-url", "http://srv"], cap);
    expect(code).toBe(1);
    expect(cap.spawned()).toBe(1);
    expect(cap.killed()).toEqual([[555, "SIGTERM"]]);
  });

  test("an invalid lastSeen never satisfies readiness", async () => {
    let calls = 0;
    const cap = seams({ fetchStatus: async () => (++calls === 1
      ? { online: false, name: null, lastSeen: null }
      : { online: true, name: null, lastSeen: "not-a-date" }) });
    const code = await runEnsure(["--server-url", "http://srv"], cap);
    expect(code).toBe(1);
    expect(cap.spawned()).toBe(1);
    expect(cap.killed()).toEqual([[555, "SIGTERM"]]);
  });

  test("an unavailable or invalid baseline must be established before a later heartbeat advances it", async () => {
    const first = { online: true, name: null, lastSeen: "not-a-date" };
    const baseline = { online: true, name: null, lastSeen: "2026-07-19T10:00:00.000Z" };
    const fresh = { ...baseline, lastSeen: "2026-07-19T10:00:01.000Z" };
    let calls = 0;
    const cap = seams({ fetchStatus: async () => [first, baseline, fresh][calls++] });
    const code = await runEnsure(["--server-url", "http://srv"], cap);
    expect(code).toBe(0);
    expect(calls).toBe(3);
    expect(cap.spawned()).toBe(1);
  });

  test("readiness timeout → kills exactly the daemon it spawned, exits 1", async () => {
    const cap = seams(); // server never reports online
    const code = await runEnsure(["--server-url", "http://srv"], cap);
    expect(code).toBe(1);
    expect(cap.spawned()).toBe(1);
    expect(cap.killed()).toEqual([[555, "SIGTERM"]]); // no orphaned detached daemon
    expect(cap.stderr()).toContain("did not come online");
  });

  test("kill racing the daemon's own exit (throws) is swallowed", async () => {
    const cap = seams({
      kill: () => { const e = new Error("no such process") as NodeJS.ErrnoException; e.code = "ESRCH"; throw e; },
    });
    const code = await runEnsure(["--server-url", "http://srv"], cap);
    expect(code).toBe(1);
  });
});

describe("runEnsure — force (update's replace path)", () => {
  test("force waits for a heartbeat newer than the daemon it replaced", async () => {
    const stale = { online: true, name: "Mac", lastSeen: "2026-07-19T10:00:00.000Z" };
    const fresh = { ...stale, lastSeen: "2026-07-19T10:00:01.000Z" };
    let calls = 0;
    const cap = seams({
      localPid: () => 4242,
      // Baseline, unchanged stale response, then evidence from the replacement.
      fetchStatus: async () => (++calls >= 3 ? fresh : stale),
    });
    const code = await runEnsure(["--server-url", "http://srv"], cap, { force: true });
    expect(code).toBe(0);
    expect(cap.spawned()).toBe(1);
    expect(calls).toBe(3);
    expect(cap.stdout()).toContain("starting daemon");
    expect(cap.skillInstalls()).toEqual([{ global: true }]);
  });
});

describe("runEnsure — user-scope skill refresh on every success path", () => {
  test("live local daemon + server online → refreshes the skill (global), announced", async () => {
    const cap = seams({ localPid: () => 4242, fetchStatus: async () => ({ online: true, name: "Mac" }) });
    const code = await runEnsure(["--server-url", "http://srv"], cap);
    expect(code).toBe(0);
    expect(cap.skillInstalls()).toEqual([{ global: true }]);
    expect(cap.stdout()).toContain("pievo skill: installed → ~/.claude/skills/pievo");
  });

  test("live local daemon + server unreachable → still refreshes the skill", async () => {
    const cap = seams({ localPid: () => 4242, fetchStatus: async () => undefined });
    const code = await runEnsure(["--server-url", "http://srv"], cap);
    expect(code).toBe(0);
    expect(cap.skillInstalls()).toEqual([{ global: true }]);
  });

  test("stale server presence (no local pid) → spawns, then refreshes the skill once fresh", async () => {
    const stale = { online: true, name: null, lastSeen: "2026-07-19T10:00:00.000Z" };
    const fresh = { ...stale, lastSeen: "2026-07-19T10:00:01.000Z" };
    let calls = 0;
    const cap = seams({ fetchStatus: async () => (++calls >= 2 ? fresh : stale) });
    const code = await runEnsure(["--server-url", "http://srv"], cap);
    expect(code).toBe(0);
    expect(cap.spawned()).toBe(1);
    expect(cap.skillInstalls()).toEqual([{ global: true }]);
  });

  test("freshly spawned daemon comes online → refreshes the skill", async () => {
    let calls = 0;
    const cap = seams({ fetchStatus: async () => (++calls >= 2
      ? { online: true, name: null, lastSeen: "2026-07-19T10:00:01.000Z" }
      : { online: false, name: null, lastSeen: null }) });
    const code = await runEnsure(["--server-url", "http://srv"], cap);
    expect(code).toBe(0);
    expect(cap.skillInstalls()).toEqual([{ global: true }]);
  });

  test("readiness timeout (up FAILS) → does NOT refresh the skill", async () => {
    const cap = seams(); // never online
    const code = await runEnsure(["--server-url", "http://srv"], cap);
    expect(code).toBe(1);
    expect(cap.skillInstalls()).toEqual([]);
  });

  test("a throwing skill refresh never fails up (best-effort)", async () => {
    let calls = 0;
    const cap = seams({
      fetchStatus: async () => (++calls >= 2
        ? { online: true, name: null, lastSeen: "2026-07-19T10:00:01.000Z" }
        : { online: false, name: null, lastSeen: null }),
      installSkill: async () => { throw new Error("npx ENOENT"); },
    });
    const code = await runEnsure(["--server-url", "http://srv"], cap);
    expect(code).toBe(0); // up still succeeds
  });
});

describe("buildDaemonSpawn — the token travels via env, never argv", () => {
  test("argv carries only --server-url; the token rides PIEVO_TOKEN", () => {
    const { args, env } = buildDaemonSpawn("http://srv", "dk_secret_token");
    expect(args.join(" ")).not.toContain("dk_secret_token"); // never visible in `ps`
    expect(args).not.toContain("--api-key");
    expect(env.PIEVO_TOKEN).toBe("dk_secret_token");
    // cli.ts's DAEMON_FLAGS fallback keys on the LEADING flag after the entry
    // script — `--server-url <url>` must be the trailing pair so the re-exec
    // still routes to daemon mode.
    expect(args[args.length - 2]).toBe("--server-url");
    expect(args[args.length - 1]).toBe("http://srv");
  });
});
