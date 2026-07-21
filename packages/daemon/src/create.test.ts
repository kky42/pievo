/**
 * Agent recording at `pievo new`: the env-fingerprint detector and the
 * resolution precedence (measured env > declared --agent/config > undefined).
 * Pure functions, no network — they decide the `agent` field the create POST
 * carries (or omits, letting the server default it to claude-code).
 *
 * Plus the skill-install trigger at create: that the USER-scope install fires only
 * after a confirmed create, never blocking it (both with the fetch + installer seams
 * injected, so nothing hits the network or spawns npx).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { canonicalJson, coerceAgent, cronLooksValid, detectAgentFromEnv, idempotencyKey, resolveAgent, runCreate } from "./create.js";
import type { InstallOutcome } from "./skill-install.js";

const okResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const errResponse = (status: number, body: unknown) =>
  ({ ok: false, status, json: async () => body }) as unknown as Response;

/** The inline `--json '<config>'` string (batch 2 replaced the `--config <file>` ritual). */
function cfgJson(cfg: object): string {
  return JSON.stringify(cfg);
}

/** An absolute path under a fresh temp dir that does NOT yet exist — so a test can
 *  prove the installer's cwd is created before the install spawns (the ENOENT fix). */
function tmpWorkdir(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-workdir-"));
  return path.join(base, "loop", "run");
}

describe("cronLooksValid (local pre-check only — the server/croner is the sole validator)", () => {
  test("accepts the 5-field, 6-field (seconds), and @-shortcut forms croner supports", () => {
    expect(cronLooksValid("0 8 * * *")).toBe(true);
    expect(cronLooksValid("0 0 8 * * *")).toBe(true);
    expect(cronLooksValid("@daily")).toBe(true);
    expect(cronLooksValid("  @hourly  ")).toBe(true);
  });

  test("rejects only the obviously-wrong shapes", () => {
    expect(cronLooksValid("")).toBe(false);
    expect(cronLooksValid("   ")).toBe(false);
    expect(cronLooksValid("* *")).toBe(false);
    expect(cronLooksValid("1 2 3 4 5 6 7")).toBe(false);
    expect(cronLooksValid(42)).toBe(false);
    expect(cronLooksValid(undefined)).toBe(false);
  });
});

describe("detectAgentFromEnv", () => {
  test("fingerprints Claude Code from CLAUDECODE (verified live)", () => {
    expect(detectAgentFromEnv({ CLAUDECODE: "1" })).toBe("claude-code");
    expect(detectAgentFromEnv({ CLAUDE_CODE_ENTRYPOINT: "cli" })).toBe("claude-code");
  });

  test("fingerprints Codex from its sandbox env (per current Codex CLI docs)", () => {
    expect(detectAgentFromEnv({ CODEX_SANDBOX: "seatbelt" })).toBe("codex");
    expect(detectAgentFromEnv({ CODEX_SANDBOX_NETWORK_DISABLED: "1" })).toBe("codex");
  });

  test("ignores CODEX_COMPANION_* (a Claude Code session can export it — would misattribute)", () => {
    expect(detectAgentFromEnv({ CODEX_COMPANION_SESSION_ID: "abc" })).toBeNull();
  });

  test("returns null when no host marker is present (undetectable → caller falls back)", () => {
    expect(detectAgentFromEnv({ PATH: "/usr/bin" })).toBeNull();
  });

  test("Claude Code wins when both markers are present (its session is the real host)", () => {
    expect(detectAgentFromEnv({ CLAUDECODE: "1", CODEX_SANDBOX: "seatbelt" })).toBe("claude-code");
  });
});

describe("coerceAgent", () => {
  test("passes through known agents, rejects everything else", () => {
    expect(coerceAgent("claude-code")).toBe("claude-code");
    expect(coerceAgent("codex")).toBe("codex");
    expect(coerceAgent("unknown")).toBeNull();
    expect(coerceAgent("")).toBeNull();
    expect(coerceAgent(undefined)).toBeNull();
  });
});

describe("resolveAgent (precedence: measured > declared > undefined)", () => {
  test("a measured host overrides a conflicting declaration (can't be fooled)", () => {
    // Dialog/skill said codex, but we were pasted into a Claude Code session.
    expect(resolveAgent({ CLAUDECODE: "1" }, "codex")).toBe("claude-code");
  });

  test("falls back to the declared value when the env is undetectable", () => {
    expect(resolveAgent({ PATH: "/usr/bin" }, "codex")).toBe("codex");
    expect(resolveAgent({ PATH: "/usr/bin" }, "claude-code")).toBe("claude-code");
  });

  test("returns undefined when neither measured nor declared (server defaults it)", () => {
    expect(resolveAgent({ PATH: "/usr/bin" }, undefined)).toBeUndefined();
    expect(resolveAgent({ PATH: "/usr/bin" }, "")).toBeUndefined();
    expect(resolveAgent({ PATH: "/usr/bin" }, "garbage")).toBeUndefined();
  });
});


describe("idempotencyKey / canonicalJson (F8 — `new` retry-safety, design §8.1)", () => {
  test("canonicalJson sorts object keys recursively, preserves array order", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
    // Nested objects also canonicalize; arrays keep order (order is meaningful).
    expect(canonicalJson({ x: { d: 4, c: 3 }, y: [1, 2] })).toBe('{"x":{"c":3,"d":4},"y":[1,2]}');
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  test("the key is STABLE across retries (same token + config, any key order)", () => {
    const k1 = idempotencyKey("dk_test", { name: "Docs", cron: "0 6 * * 1", taskFile: "x" });
    const k2 = idempotencyKey("dk_test", { taskFile: "x", cron: "0 6 * * 1", name: "Docs" });
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^[0-9a-f]{64}$/); // a sha256 hex digest
  });

  test("the key DIFFERS across configs and across machines (tokens)", () => {
    const base = { name: "Docs", cron: "0 6 * * 1", taskFile: "x" };
    expect(idempotencyKey("dk_test", base)).not.toBe(idempotencyKey("dk_test", { ...base, cron: "0 7 * * 1" }));
    // A different device token ⇒ a different machine id in the hash ⇒ a different key.
    expect(idempotencyKey("dk_a", base)).not.toBe(idempotencyKey("dk_b", base));
  });

  test("hashing the FULL resolved body closes the envelope-collision class (timezone/claim/agent all count)", () => {
    // The body is the exact outgoing request payload (config + envelope), so any field difference splits the key.
    const body = { name: "Docs", cron: "0 6 * * 1", taskFile: "x", timezone: "Europe/Paris" };
    // Same body ⇒ same key (a genuine retry with identical argv+env still collapses).
    expect(idempotencyKey("dk_test", body)).toBe(idempotencyKey("dk_test", { ...body }));
    // A different --tz (envelope) ⇒ different keys — the tz-collision the previous cherry-pick missed.
    expect(idempotencyKey("dk_test", body)).not.toBe(idempotencyKey("dk_test", { ...body, timezone: "America/New_York" }));
    // A different connect-key/team (rides in `claim`) ⇒ different keys (no cross-team collapse).
    expect(idempotencyKey("dk_test", { ...body, claim: "dk_teamA" })).not.toBe(idempotencyKey("dk_test", { ...body, claim: "dk_teamB" }));
    // A different recorded agent ⇒ different keys.
    expect(idempotencyKey("dk_test", { ...body, agent: "claude-code" })).not.toBe(idempotencyKey("dk_test", { ...body, agent: "codex" }));
    // The idempotencyKey nonce itself is EXCLUDED from the hash (its presence/value can't change the key).
    expect(idempotencyKey("dk_test", body)).toBe(idempotencyKey("dk_test", { ...body, idempotencyKey: "whatever" }));
  });
});

describe("runCreate — sends the idempotency key on a real create, omits it on --dry-run", () => {
  const prevToken = process.env.PIEVO_TOKEN;
  beforeEach(() => {
    process.env.PIEVO_TOKEN = "dk_test";
  });
  afterEach(() => {
    if (prevToken === undefined) delete process.env.PIEVO_TOKEN;
    else process.env.PIEVO_TOKEN = prevToken;
  });

  // NB: the daemon resolves its token from ~/.pievo/device-token first (env is the
  // fallback), so the integration test can't pin the exact key to a fixed token — it
  // asserts the CONTRACT (present, 64-hex, stable across retries, differs by config).
  // The exact `sha256(machineId + canonicalJSON(resolvedBody))` value is pinned by the
  // pure idempotencyKey tests above.
  const keyOf = (sent: any[]) => JSON.parse(sent[sent.length - 1].argv[2]).idempotencyKey as string | undefined;

  test("a real create stamps a 64-hex `idempotencyKey`, stable across a retry of the same config", async () => {
    const cfg = cfgJson({ cron: "0 5 * * *", taskFile: "pievo/x/README.md" });
    const sent: any[] = [];
    const run = (json: string) =>
      runCreate(["--json", json, "--server-url", "http://test"], {
        fetchImpl: async (_url: any, init: any) => {
          sent.push(JSON.parse((init as any).body as string));
          return okResponse({ ok: true, id: "loop-1", name: "X", text: "created: X (loop-1)", exitCode: 0 });
        },
        installer: async () => ({ ok: true, line: "" }),
        stdout: () => {},
      });
    expect(await run(cfg)).toBe(0);
    const first = keyOf(sent);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await run(cfg)).toBe(0); // a retry (same argv)
    expect(keyOf(sent)).toBe(first); // stable across the retry
    // A different config ⇒ a different key (an intentional twin isn't collapsed).
    expect(await run(cfgJson({ cron: "0 6 * * *", taskFile: "pievo/x/README.md" }))).toBe(0);
    expect(keyOf(sent)).not.toBe(first);
  });

  test("--dry-run carries NO idempotency key (a preview creates nothing to dedupe)", async () => {
    const cfg = cfgJson({ cron: "0 5 * * *", taskFile: "pievo/x/README.md" });
    let payload: any = null;
    const code = await runCreate(["--json", cfg, "--dry-run", "--server-url", "http://test"], {
      fetchImpl: async (_url: any, init: any) => {
        payload = JSON.parse(JSON.parse((init as any).body as string).argv[2]);
        return okResponse({ ok: true, dryRun: true, text: "dry-run:\n  cron: 0 5 * * *", exitCode: 0 });
      },
      installer: async () => ({ ok: true, line: "" }),
      stdout: () => {},
    });
    expect(code).toBe(0);
    expect(payload.idempotencyKey).toBeUndefined();
    expect(payload.dryRun).toBe(true);
  });
});
