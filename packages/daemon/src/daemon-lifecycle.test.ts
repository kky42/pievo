/** `pievo daemon start/restart`, with external touches injected. */
import { describe, expect, test } from "vitest";

import { buildDaemonSpawn, runDaemonRestart, runDaemonStart, type DaemonStartDeps } from "./daemon-lifecycle.js";
import type { InstallOpts } from "./skill-install.js";

type Cap = DaemonStartDeps & {
  stdout: () => string;
  stderr: () => string;
  spawned: () => number;
  killed: () => Array<[number, string]>;
  skillInstalls: () => InstallOpts[];
};

/** Baseline seams: nothing running, server unreachable, spawn returns pid 555. The
 *  skill refresh is stubbed so no test spawns npx / hits the network. */
function seams(extra: DaemonStartDeps = {}): Cap {
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

describe("runDaemonStart — exact public flags", () => {
  test("rejects removed --api-key and unknown flags without spawning", async () => {
    for (const args of [["--api-key", "dk_old"], ["--wat"]]) {
      const cap = seams();
      expect(await runDaemonStart(args, cap)).toBe(2);
      expect(cap.spawned()).toBe(0);
      expect(cap.stderr()).toContain("pievo daemon start");
    }
  });
});

describe("runDaemonStart — local pidfile first (no daemon leaks)", () => {
  test("a live local daemon short-circuits: never spawns a second one even when the server is unreachable", async () => {
    const cap = seams({ localPid: () => 4242, fetchStatus: async () => undefined });
    const code = await runDaemonStart(["--server-url", "http://srv"], cap);
    expect(code).toBe(0);
    expect(cap.spawned()).toBe(0);
    expect(cap.stdout()).toContain("already running locally (pid 4242)");
  });

  test("a live local daemon that the server also sees online → the classic already-running message", async () => {
    const cap = seams({ localPid: () => 4242, fetchStatus: async () => ({ online: true, name: "MacBook" }) });
    const code = await runDaemonStart(["--server-url", "http://srv"], cap);
    expect(code).toBe(0);
    expect(cap.spawned()).toBe(0);
    expect(cap.stdout()).toContain("daemon already running for this machine (MacBook)");
  });
});

describe("runDaemonStart — readiness", () => {
  test("daemon comes online with a fresh heartbeat → success, spawned once, never killed", async () => {
    let calls = 0;
    const cap = seams({
      // Pre-spawn check is offline, then the spawned daemon advances lastSeen.
      fetchStatus: async () => (++calls >= 2
        ? { online: true, name: "MacBook", lastSeen: "2026-07-19T10:00:01.000Z" }
        : { online: false, name: null, lastSeen: "2026-07-19T10:00:00.000Z" }),
    });
    const code = await runDaemonStart(["--server-url", "http://srv"], cap);
    expect(code).toBe(0);
    expect(cap.spawned()).toBe(1);
    expect(cap.killed()).toEqual([]);
    expect(cap.stdout()).toContain("daemon online");
  });

  test("stale server presence neither suppresses spawn nor satisfies readiness", async () => {
    const stale = { online: true, name: "MacBook", lastSeen: "2026-07-19T10:00:00.000Z" };
    const cap = seams({ fetchStatus: async () => stale });
    const code = await runDaemonStart(["--server-url", "http://srv"], cap);
    expect(code).toBe(1);
    expect(cap.spawned()).toBe(1);
    expect(cap.killed()).toEqual([[555, "SIGTERM"]]);
  });

  test("a missing lastSeen never satisfies readiness", async () => {
    const cap = seams({ fetchStatus: async () => ({ online: true, name: null }) });
    const code = await runDaemonStart(["--server-url", "http://srv"], cap);
    expect(code).toBe(1);
    expect(cap.spawned()).toBe(1);
    expect(cap.killed()).toEqual([[555, "SIGTERM"]]);
  });

  test("an invalid lastSeen never satisfies readiness", async () => {
    let calls = 0;
    const cap = seams({ fetchStatus: async () => (++calls === 1
      ? { online: false, name: null, lastSeen: null }
      : { online: true, name: null, lastSeen: "not-a-date" }) });
    const code = await runDaemonStart(["--server-url", "http://srv"], cap);
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
    const code = await runDaemonStart(["--server-url", "http://srv"], cap);
    expect(code).toBe(0);
    expect(calls).toBe(3);
    expect(cap.spawned()).toBe(1);
  });

  test("readiness timeout → kills exactly the daemon it spawned, exits 1", async () => {
    const cap = seams(); // server never reports online
    const code = await runDaemonStart(["--server-url", "http://srv"], cap);
    expect(code).toBe(1);
    expect(cap.spawned()).toBe(1);
    expect(cap.killed()).toEqual([[555, "SIGTERM"]]); // no orphaned detached daemon
    expect(cap.stderr()).toContain("did not come online");
  });

  test("kill racing the daemon's own exit (throws) is swallowed", async () => {
    const cap = seams({
      kill: () => { const e = new Error("no such process") as NodeJS.ErrnoException; e.code = "ESRCH"; throw e; },
    });
    const code = await runDaemonStart(["--server-url", "http://srv"], cap);
    expect(code).toBe(1);
  });
});

describe("runDaemonStart — foreground", () => {
  test("first connection persists config and runs attached without spawning", async () => {
    const persisted: Array<[string, string]> = [];
    const foreground: string[][] = [];
    const cap = seams({
      readToken: () => undefined,
      persist: (file, value) => { persisted.push([file, value]); },
      foreground: async (args) => { foreground.push(args); return 0; },
    });
    expect(await runDaemonStart(["--foreground", "--server-url", "http://srv", "--connect-key", "dk_first"], cap)).toBe(0);
    expect(cap.spawned()).toBe(0);
    expect(persisted.map(([, value]) => value)).toEqual(["http://srv", "dk_first"]);
    expect(foreground).toEqual([["--server-url", "http://srv"]]);
  });

  test("direct foreground starts polling before the best-effort refresh and does not await it", async () => {
    const events: string[] = [];
    let releaseInstall!: () => void;
    const installPending = new Promise<void>((resolve) => { releaseInstall = resolve; });
    const cap = seams({
      foreground: async () => { events.push("foreground"); return 0; },
      installSkill: async () => {
        events.push("refresh");
        await installPending;
        return { ok: true, line: "installed" };
      },
    });
    expect(await runDaemonStart(["--foreground", "--server-url", "http://srv"], cap)).toBe(0);
    expect(events).toEqual(["foreground", "refresh"]);
    releaseInstall();
    await installPending;
  });

  test("detached child re-entry starts polling without skill or PATH refresh", async () => {
    let shimCalls = 0;
    const cap = seams({
      internalChild: true,
      ensureBinShim: () => { shimCalls += 1; },
      foreground: async () => 0,
    });
    expect(await runDaemonStart(["--foreground", "--server-url", "http://srv"], cap)).toBe(0);
    expect(cap.skillInstalls()).toEqual([]);
    expect(shimCalls).toBe(0);
  });
});

describe("runDaemonRestart", () => {
  test("rejects flags other than --force without stop/start side effects", async () => {
    let called = false;
    expect(await runDaemonRestart(["--foreground"], {
      stop: async () => { called = true; return 0; },
      start: async () => { called = true; return 0; },
      err: () => {},
    })).toBe(2);
    expect(called).toBe(false);
  });

  test("force applies only to stop, then start uses persisted config", async () => {
    const calls: Array<[string, string[]]> = [];
    const code = await runDaemonRestart(["--force"], {
      stop: async (args) => { calls.push(["stop", args]); return 0; },
      start: async (args) => { calls.push(["start", args]); return 0; },
    });
    expect(code).toBe(0);
    expect(calls).toEqual([["stop", ["--force"]], ["start", []]]);
  });

  test("does not start when stop fails", async () => {
    let started = false;
    expect(await runDaemonRestart([], { stop: async () => 1, start: async () => { started = true; return 0; } })).toBe(1);
    expect(started).toBe(false);
  });
});

describe("runDaemonStart — user-scope skill refresh on every success path", () => {
  test("live local daemon + server online → refreshes the skill (global), announced", async () => {
    const cap = seams({ localPid: () => 4242, fetchStatus: async () => ({ online: true, name: "Mac" }) });
    const code = await runDaemonStart(["--server-url", "http://srv"], cap);
    expect(code).toBe(0);
    expect(cap.skillInstalls()).toEqual([{ global: true }]);
    expect(cap.stdout()).toContain("pievo skill: installed → ~/.claude/skills/pievo");
  });

  test("live local daemon + server unreachable → still refreshes the skill", async () => {
    const cap = seams({ localPid: () => 4242, fetchStatus: async () => undefined });
    const code = await runDaemonStart(["--server-url", "http://srv"], cap);
    expect(code).toBe(0);
    expect(cap.skillInstalls()).toEqual([{ global: true }]);
  });

  test("stale server presence (no local pid) → spawns, then refreshes the skill once fresh", async () => {
    const stale = { online: true, name: null, lastSeen: "2026-07-19T10:00:00.000Z" };
    const fresh = { ...stale, lastSeen: "2026-07-19T10:00:01.000Z" };
    let calls = 0;
    const cap = seams({ fetchStatus: async () => (++calls >= 2 ? fresh : stale) });
    const code = await runDaemonStart(["--server-url", "http://srv"], cap);
    expect(code).toBe(0);
    expect(cap.spawned()).toBe(1);
    expect(cap.skillInstalls()).toEqual([{ global: true }]);
  });

  test("detached parent refreshes skill and PATH exactly once, only after readiness", async () => {
    const events: string[] = [];
    let calls = 0;
    const cap = seams({
      spawnDaemon: () => { events.push("spawn"); return 555; },
      fetchStatus: async () => {
        calls += 1;
        events.push(`status-${calls}`);
        return calls >= 2
          ? { online: true, name: null, lastSeen: "2026-07-19T10:00:01.000Z" }
          : { online: false, name: null, lastSeen: null };
      },
      installSkill: async () => { events.push("skill"); return { ok: true, line: "installed" }; },
      ensureBinShim: () => { events.push("shim"); },
    });
    expect(await runDaemonStart(["--server-url", "http://srv"], cap)).toBe(0);
    expect(events).toEqual(["status-1", "spawn", "status-2", "skill", "shim"]);
  });

  test("freshly spawned daemon comes online → refreshes the skill", async () => {
    let calls = 0;
    const cap = seams({ fetchStatus: async () => (++calls >= 2
      ? { online: true, name: null, lastSeen: "2026-07-19T10:00:01.000Z" }
      : { online: false, name: null, lastSeen: null }) });
    const code = await runDaemonStart(["--server-url", "http://srv"], cap);
    expect(code).toBe(0);
    expect(cap.skillInstalls()).toEqual([{ global: true }]);
  });

  test("readiness timeout (start FAILS) → does NOT refresh the skill", async () => {
    const cap = seams(); // never online
    const code = await runDaemonStart(["--server-url", "http://srv"], cap);
    expect(code).toBe(1);
    expect(cap.skillInstalls()).toEqual([]);
  });

  test("a throwing skill refresh never fails daemon start (best-effort)", async () => {
    let calls = 0;
    const cap = seams({
      fetchStatus: async () => (++calls >= 2
        ? { online: true, name: null, lastSeen: "2026-07-19T10:00:01.000Z" }
        : { online: false, name: null, lastSeen: null }),
      installSkill: async () => { throw new Error("npx ENOENT"); },
    });
    const code = await runDaemonStart(["--server-url", "http://srv"], cap);
    expect(code).toBe(0); // start still succeeds
  });
});

describe("buildDaemonSpawn — nested re-exec with env-only token", () => {
  test("argv uses daemon start --foreground and the token rides PIEVO_TOKEN", () => {
    const { args, env } = buildDaemonSpawn("http://srv", "dk_secret_token");
    expect(args.join(" ")).not.toContain("dk_secret_token"); // never visible in `ps`
    expect(env.PIEVO_TOKEN).toBe("dk_secret_token");
    expect(env.PIEVO_INTERNAL_DAEMON_CHILD).toBe("1");
    expect(args).toContain("daemon");
    expect(args).toContain("start");
    expect(args).toContain("--foreground");
    expect(args[args.length - 2]).toBe("--server-url");
    expect(args[args.length - 1]).toBe("http://srv");
  });
});
