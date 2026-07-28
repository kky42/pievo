/**
 * spawn helpers — the child-env allowlists (allowlistEnv / execEnv) and the
 * process-GROUP kill: a timed-out child's grandchildren must not survive the timeout.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { isAlive } from "./pidfile.js";
import { allowlistEnv, execEnv, runProcess } from "./spawn.js";

// Save/restore every env key a test touches so nothing leaks across tests.
const saved = new Map<string, string | undefined>();
function setEnv(k: string, v: string): void {
  if (!saved.has(k)) saved.set(k, process.env[k]);
  process.env[k] = v;
}
afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
});

describe("execEnv", () => {
  test("unknown agents fail closed instead of inheriting Claude credentials", () => {
    expect(() => execEnv("unknown" as any)).toThrow("unsupported coding agent: unknown");
  });

  test("keeps claude auth/config keys — incl. the ANTHROPIC_* proxy family and CLAUDE_CONFIG_DIR", () => {
    setEnv("ANTHROPIC_API_KEY", "sk-x");
    setEnv("ANTHROPIC_BASE_URL", "https://gw.example"); // proxy/gateway users
    setEnv("ANTHROPIC_AUTH_TOKEN", "tok");
    setEnv("CLAUDE_CONFIG_DIR", "/tmp/claude-config"); // relocated Claude config
    const env = execEnv("claude-code");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-x");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://gw.example");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("tok");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/tmp/claude-config");
    expect(env.PATH).toBe(process.env.PATH);
  });

  test("drops unrelated shell secrets", () => {
    setEnv("AWS_SECRET_ACCESS_KEY", "leak-me-not");
    setEnv("GITHUB_TOKEN", "leak-me-not");
    setEnv("PIEVO_TOKEN", "dk_secret"); // the device token never reaches claude
    const env = execEnv("claude-code");
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.PIEVO_TOKEN).toBeUndefined();
  });

  test("codex path forwards OPENAI_API_KEY / CODEX_API_KEY / CODEX_HOME, not Claude keys", () => {
    setEnv("OPENAI_API_KEY", "sk-openai");
    setEnv("CODEX_API_KEY", "codex-secret");
    setEnv("CODEX_HOME", "/tmp/codex-home");
    setEnv("ANTHROPIC_API_KEY", "sk-x");
    setEnv("CLAUDE_CODE_OAUTH_TOKEN", "claude-tok");
    const env = execEnv("codex");
    expect(env.OPENAI_API_KEY).toBe("sk-openai");
    expect(env.CODEX_API_KEY).toBe("codex-secret");
    expect(env.CODEX_HOME).toBe("/tmp/codex-home");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    // OAuth/session files under ~/.codex stay reachable via HOME (BASE_ALLOW).
    expect(env.HOME).toBe(process.env.HOME);
  });

  test("pi forwards reviewed config/provider keys without arbitrary custom-provider env", () => {
    setEnv("PI_CODING_AGENT_DIR", "/tmp/pi-agent");
    setEnv("PI_OFFLINE", "1");
    setEnv("ANTHROPIC_API_KEY", "anthropic-secret");
    setEnv("OPENROUTER_API_KEY", "openrouter-secret");
    setEnv("GOOGLE_APPLICATION_CREDENTIALS", "/tmp/google.json");
    setEnv("AWS_ACCESS_KEY_ID", "aws-key");
    setEnv("MY_CUSTOM_PROVIDER_KEY", "must-not-leak");
    const env = execEnv("pi");
    expect(env).toMatchObject({
      HOME: process.env.HOME,
      PI_CODING_AGENT_DIR: "/tmp/pi-agent",
      PI_OFFLINE: "1",
      ANTHROPIC_API_KEY: "anthropic-secret",
      OPENROUTER_API_KEY: "openrouter-secret",
      GOOGLE_APPLICATION_CREDENTIALS: "/tmp/google.json",
      AWS_ACCESS_KEY_ID: "aws-key",
    });
    expect(env.MY_CUSTOM_PROVIDER_KEY).toBeUndefined();
  });

  test("claude path does NOT forward OpenAI/Codex keys", () => {
    setEnv("OPENAI_API_KEY", "sk-openai");
    setEnv("CODEX_API_KEY", "codex-secret");
    const env = execEnv("claude-code");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CODEX_API_KEY).toBeUndefined();
  });
});


async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

describe("runProcess stdin", () => {
  test("round-trips stdin exactly", async () => {
    const input = "  leading\ntrailing  \n";
    const r = await runProcess(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { cwd: os.tmpdir(), stdin: input });
    expect(r).toMatchObject({ code: 0, stdout: input });
  });

  test("does not crash when a child exits before consuming stdin", async () => {
    const r = await runProcess(process.execPath, ["-e", "process.exit(0)"], { cwd: os.tmpdir(), stdin: "x".repeat(1_000_000) });
    expect(r.code).toBe(0);
  });
});

describe("runProcess — process-group kill (posix)", () => {
  test("an already-aborted run never spawns a child", async () => {
    const marker = path.join(os.tmpdir(), `pievo-spawned-${process.pid}-${Date.now()}`);
    const ac = new AbortController();
    ac.abort("cancel");
    const r = await runProcess(process.execPath, ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'yes')`], { cwd: os.tmpdir(), signal: ac.signal });
    expect(fs.existsSync(marker)).toBe(false);
    expect(r.signal).toBe("SIGTERM");
  });

  test("an earlier abort remains authoritative when the timeout elapses during TERM cleanup", async () => {
    if (process.platform === "win32") return;
    const ready = path.join(os.tmpdir(), `pievo-abort-first-${process.pid}-${Date.now()}`);
    const script = [
      'const fs = require("node:fs");',
      `fs.writeFileSync(${JSON.stringify(ready)}, "ready");`,
      'process.on("SIGTERM", () => setTimeout(() => process.exit(143), 200));',
      'setInterval(() => {}, 1000);',
    ].join("\n");
    const ac = new AbortController();
    const running = runProcess(process.execPath, ["-e", script], { cwd: os.tmpdir(), timeoutMs: 100, signal: ac.signal });
    expect(await waitFor(() => fs.existsSync(ready), 2000)).toBe(true);
    ac.abort("server-cancel");
    const result = await running;
    fs.rmSync(ready, { force: true });
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  test("a timed-out child's grandchild dies with it", async () => {
    if (process.platform === "win32") return; // no process groups on win32 (plain kill fallback)
    // The child spawns a long-sleeping grandchild, prints its pid, then idles
    // until the runProcess timeout SIGTERMs the whole group.
    const script = [
      'const { spawn } = require("node:child_process");',
      'const g = spawn("sleep", ["120"], { stdio: "ignore" });',
      'console.log("GRANDCHILD=" + g.pid);',
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const r = await runProcess(process.execPath, ["-e", script], { cwd: os.tmpdir(), timeoutMs: 1000 });
    expect(r.timedOut).toBe(true);
    const m = r.stdout.match(/GRANDCHILD=(\d+)/);
    expect(m).toBeTruthy();
    const gpid = Number(m![1]);
    expect(await waitFor(() => !isAlive(gpid), 5000)).toBe(true);
  }, 20000);
});
