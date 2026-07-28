/** `pievo daemon start/restart`, with external touches injected. */
import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, test } from "vitest";

import { buildDaemonSpawn, runDaemonConnect, runDaemonConnections, runDaemonRestart, runDaemonStart, type DaemonStartDeps } from "./daemon-lifecycle.js";
type Cap = DaemonStartDeps & {
  stdout: () => string;
  stderr: () => string;
  spawned: () => number;
  killed: () => Array<[number, string]>;
  skillInstalls: () => number;
};

/** Baseline seams: nothing running, server unreachable, spawn returns pid 555. The
 *  skill refresh is stubbed so no test spawns npx / hits the network. */
function seams(extra: DaemonStartDeps = {}): Cap {
  let out = "";
  let err = "";
  let spawned = 0;
  const killed: Array<[number, string]> = [];
  let skillInstalls = 0;
  return {
    fetchStatus: async () => undefined,
    spawnDaemon: () => { spawned += 1; return 555; },
    kill: (pid, sig) => { killed.push([pid, sig]); },
    sleep: async () => {},
    localPid: () => undefined,
    readConnection: () => ({ serverUrl: "http://srv", deviceToken: "dk_stored" }),
    installSkill: async () => { skillInstalls += 1; return { ok: true, line: "pievo skill: installed → ~/.claude/skills/pievo" }; },
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
    const code = await runDaemonStart([], cap);
    expect(code).toBe(0);
    expect(cap.spawned()).toBe(0);
    expect(cap.stdout()).toContain("already running locally (pid 4242)");
  });

  test("a deleted saved identity fails fast with server-neutral reconnect guidance", async () => {
    const cap = seams({
      localPid: () => undefined,
      fetchStatus: async () => ({ registered: false, claimValid: false, online: false, name: null }),
    });
    expect(await runDaemonStart([], cap)).toBe(1);
    expect(cap.spawned()).toBe(0);
    expect(cap.stderr()).toContain("connect to a server with `pievo daemon connect --server-url <url> --connect-key <dk_…>`");
  });

  test("a fresh valid connect key may register its machine", async () => {
    let calls = 0;
    const cap = seams({
      fetchStatus: async () => (++calls === 1
        ? { registered: false, claimValid: true, online: false, name: null, lastSeen: null }
        : { registered: true, online: true, name: "MacBook", lastSeen: "2026-07-19T10:00:01.000Z" }),
    });
    expect(await runDaemonStart([], cap)).toBe(0);
    expect(cap.spawned()).toBe(1);
  });

  test("a live local daemon that the server also sees online → the classic already-running message", async () => {
    const cap = seams({ localPid: () => 4242, fetchStatus: async () => ({ online: true, name: "MacBook" }) });
    const code = await runDaemonStart([], cap);
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
    const code = await runDaemonStart([], cap);
    expect(code).toBe(0);
    expect(cap.spawned()).toBe(1);
    expect(cap.killed()).toEqual([]);
    expect(cap.stdout()).toContain("daemon online");
  });

  test("stale server presence neither suppresses spawn nor satisfies readiness", async () => {
    const stale = { online: true, name: "MacBook", lastSeen: "2026-07-19T10:00:00.000Z" };
    const cap = seams({ fetchStatus: async () => stale });
    const code = await runDaemonStart([], cap);
    expect(code).toBe(1);
    expect(cap.spawned()).toBe(1);
    expect(cap.killed()).toEqual([[555, "SIGTERM"]]);
  });

  test("a missing lastSeen never satisfies readiness", async () => {
    const cap = seams({ fetchStatus: async () => ({ online: true, name: null }) });
    const code = await runDaemonStart([], cap);
    expect(code).toBe(1);
    expect(cap.spawned()).toBe(1);
    expect(cap.killed()).toEqual([[555, "SIGTERM"]]);
  });

  test("an invalid lastSeen never satisfies readiness", async () => {
    let calls = 0;
    const cap = seams({ fetchStatus: async () => (++calls === 1
      ? { online: false, name: null, lastSeen: null }
      : { online: true, name: null, lastSeen: "not-a-date" }) });
    const code = await runDaemonStart([], cap);
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
    const code = await runDaemonStart([], cap);
    expect(code).toBe(0);
    expect(calls).toBe(3);
    expect(cap.spawned()).toBe(1);
  });

  test("readiness timeout → kills exactly the daemon it spawned, exits 1", async () => {
    const cap = seams(); // server never reports online
    const code = await runDaemonStart([], cap);
    expect(code).toBe(1);
    expect(cap.spawned()).toBe(1);
    expect(cap.killed()).toEqual([[555, "SIGTERM"]]); // no orphaned detached daemon
    expect(cap.stderr()).toContain("did not come online");
  });

  test("kill racing the daemon's own exit (throws) is swallowed", async () => {
    const cap = seams({
      kill: () => { const e = new Error("no such process") as NodeJS.ErrnoException; e.code = "ESRCH"; throw e; },
    });
    const code = await runDaemonStart([], cap);
    expect(code).toBe(1);
  });
});

describe("runDaemonStart — foreground", () => {
  test("active connection runs attached without spawning", async () => {
    const foreground: string[][] = [];
    const cap = seams({ foreground: async (args) => { foreground.push(args); return 0; } });
    expect(await runDaemonStart(["--foreground"], cap)).toBe(0);
    expect(cap.spawned()).toBe(0);
    expect(foreground).toEqual([[]]);
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
    expect(await runDaemonStart(["--foreground"], cap)).toBe(0);
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
    expect(await runDaemonStart(["--foreground"], cap)).toBe(0);
    expect(cap.skillInstalls()).toBe(0);
    expect(shimCalls).toBe(0);
  });
});

describe("runDaemonConnect", () => {
  const config = (active: string | null, entries: Record<string, { deviceToken: string }> = {}) => ({ active, connections: entries });

  test("first connection requires a key, saves it, and starts", async () => {
    const events: string[] = [];
    const code = await runDaemonConnect(["--server-url", "https://one.test", "--connect-key", "dk_one"], {
      readConfig: () => config(null),
      stop: async (args) => { events.push(`stop ${args.join(" ")}`); return 0; },
      save: (url, token) => { events.push(`save ${url} ${token}`); },
      start: async (args) => { events.push(`start ${args.join(" ")}`); return 0; },
    });
    expect(code).toBe(0);
    expect(events).toEqual(["save https://one.test dk_one", "start "]);
  });

  test("saved active server needs no key and only ensures start", async () => {
    const events: string[] = [];
    const code = await runDaemonConnect(["--server-url", "https://one.test"], {
      readConfig: () => config("https://one.test", { "https://one.test": { deviceToken: "dk_saved" } }),
      stop: async () => { events.push("stop"); return 0; },
      save: (url, token) => { events.push(`save ${url} ${token}`); },
      start: async () => { events.push("start"); return 0; },
    });
    expect(code).toBe(0);
    expect(events).toEqual(["save https://one.test dk_saved", "start"]);
  });

  test("a new explicit key replaces a saved identity and restarts the daemon", async () => {
    const events: string[] = [];
    await runDaemonConnect(["--server-url", "https://one.test", "--connect-key", "dk_new"], {
      readConfig: () => config("https://one.test", { "https://one.test": { deviceToken: "dk_old" } }),
      probeSaved: async () => "invalid",
      stop: async (args) => { events.push(`stop ${args.join(" ")}`); return 0; },
      save: (url, token) => { events.push(`save ${url} ${token}`); },
      start: async () => { events.push("start"); return 0; },
      out: (line) => { events.push(line.trim()); },
    });
    expect(events).toEqual([
      "stop --force",
      "save https://one.test dk_new",
      "replaced saved identity for https://one.test",
      "start",
    ]);
  });

  test("an explicit key replaces a saved identity that the server says is no longer registered", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ registered: false, online: false, name: null, daemonProtocol: null }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP test server");
    const url = `http://127.0.0.1:${address.port}`;
    const events: string[] = [];
    try {
      expect(await runDaemonConnect(["--server-url", url, "--connect-key", "dk_new"], {
        readConfig: () => config(url, { [url]: { deviceToken: "dk_deleted" } }),
        stop: async (args) => { events.push(`stop ${args.join(" ")}`); return 0; },
        save: (_target, token) => { events.push(`save ${token}`); },
        start: async () => { events.push("start"); return 0; },
        out: (line) => { events.push(line.trim()); },
      })).toBe(0);
    } finally {
      server.close();
      await once(server, "close");
    }
    expect(events).toEqual(["stop --force", "save dk_new", `replaced saved identity for ${url}`, "start"]);
  });

  test("a new loop claim does not replace a valid saved machine identity", async () => {
    const events: string[] = [];
    await runDaemonConnect(["--server-url", "https://one.test", "--connect-key", "dk_claim"], {
      readConfig: () => config("https://one.test", { "https://one.test": { deviceToken: "dk_machine" } }),
      probeSaved: async () => "valid",
      stop: async () => { events.push("stop"); return 0; },
      save: (url, token) => { events.push(`save ${url} ${token}`); },
      start: async () => { events.push("start"); return 0; },
      out: (line) => { events.push(line.trim()); },
    });
    expect(events).toEqual([
      "using saved identity for https://one.test; the supplied key remains available for loop creation",
      "save https://one.test dk_machine",
      "start",
    ]);
  });

  test("switch force-stops before activating and starting the target", async () => {
    const events: string[] = [];
    await runDaemonConnect(["--server-url", "https://two.test"], {
      readConfig: () => config("https://one.test", {
        "https://one.test": { deviceToken: "dk_one" },
        "https://two.test": { deviceToken: "dk_two" },
      }),
      stop: async (args) => { events.push(`stop ${args.join(" ")}`); return 0; },
      save: () => { events.push("activate"); },
      start: async () => { events.push("start"); return 0; },
    });
    expect(events).toEqual(["stop --force", "activate", "start"]);
  });

  test("connections marks active and never prints tokens", () => {
    let output = "";
    expect(runDaemonConnections([], {
      readConfig: () => config("https://one.test", {
        "https://one.test": { deviceToken: "dk_secret" },
        "https://two.test": { deviceToken: "dk_other" },
      }),
      out: (s) => { output += s; },
    })).toBe(0);
    expect(output).toContain("* https://one.test");
    expect(output).not.toContain("dk_secret");
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
  test("live local daemon + server online → refreshes the user skill, announced", async () => {
    const cap = seams({ localPid: () => 4242, fetchStatus: async () => ({ online: true, name: "Mac" }) });
    const code = await runDaemonStart([], cap);
    expect(code).toBe(0);
    expect(cap.skillInstalls()).toBe(1);
    expect(cap.stdout()).toContain("pievo skill: installed → ~/.claude/skills/pievo");
  });

  test("live local daemon + server unreachable → still refreshes the skill", async () => {
    const cap = seams({ localPid: () => 4242, fetchStatus: async () => undefined });
    const code = await runDaemonStart([], cap);
    expect(code).toBe(0);
    expect(cap.skillInstalls()).toBe(1);
  });

  test("stale server presence (no local pid) → spawns, then refreshes the skill once fresh", async () => {
    const stale = { online: true, name: null, lastSeen: "2026-07-19T10:00:00.000Z" };
    const fresh = { ...stale, lastSeen: "2026-07-19T10:00:01.000Z" };
    let calls = 0;
    const cap = seams({ fetchStatus: async () => (++calls >= 2 ? fresh : stale) });
    const code = await runDaemonStart([], cap);
    expect(code).toBe(0);
    expect(cap.spawned()).toBe(1);
    expect(cap.skillInstalls()).toBe(1);
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
    expect(await runDaemonStart([], cap)).toBe(0);
    expect(events).toEqual(["status-1", "spawn", "status-2", "skill", "shim"]);
  });

  test("freshly spawned daemon comes online → refreshes the skill", async () => {
    let calls = 0;
    const cap = seams({ fetchStatus: async () => (++calls >= 2
      ? { online: true, name: null, lastSeen: "2026-07-19T10:00:01.000Z" }
      : { online: false, name: null, lastSeen: null }) });
    const code = await runDaemonStart([], cap);
    expect(code).toBe(0);
    expect(cap.skillInstalls()).toBe(1);
  });

  test("readiness timeout (start FAILS) → does NOT refresh the skill", async () => {
    const cap = seams(); // never online
    const code = await runDaemonStart([], cap);
    expect(code).toBe(1);
    expect(cap.skillInstalls()).toBe(0);
  });

  test("a throwing skill refresh never fails daemon start (best-effort)", async () => {
    let calls = 0;
    const cap = seams({
      fetchStatus: async () => (++calls >= 2
        ? { online: true, name: null, lastSeen: "2026-07-19T10:00:01.000Z" }
        : { online: false, name: null, lastSeen: null }),
      installSkill: async () => { throw new Error("npx ENOENT"); },
    });
    const code = await runDaemonStart([], cap);
    expect(code).toBe(0); // start still succeeds
  });
});

describe("buildDaemonSpawn — nested re-exec with env-only token", () => {
  test("argv uses daemon start --foreground and the token rides PIEVO_TOKEN", () => {
    const { args, env } = buildDaemonSpawn("dk_secret_token");
    expect(args.join(" ")).not.toContain("dk_secret_token"); // never visible in `ps`
    expect(env.PIEVO_TOKEN).toBe("dk_secret_token");
    expect(env.PIEVO_INTERNAL_DAEMON_CHILD).toBe("1");
    expect(args).toContain("daemon");
    expect(args).toContain("start");
    expect(args).toContain("--foreground");
    expect(args).not.toContain("--server-url");
  });
});
