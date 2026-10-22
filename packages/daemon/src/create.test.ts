import { describe, expect, test } from "vitest";

import { idempotencyKey, runCreate } from "./create.js";

const okResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
function cfgJson(cfg: object): string {
  return JSON.stringify(cfg);
}

const validConfig = (overrides: Record<string, unknown> = {}) => ({
  name: "Docs",
  tags: ["daily", "docs"],
  schedule: { mode: "cron", cron: "0 5 * * *", timezone: "UTC", overlap: "skip" },
  workdir: "/tmp/docs",
  agent: "claude-code",
  prompt: "Review the docs.",
  statusDefinitions: { keep: "updated", noChange: "already current", block: "needs owner input" },
  artifacts: [],
  enabled: true,
  ...overrides,
});

describe("idempotencyKey", () => {
  test("the key is STABLE across retries (same token + config, any key order)", () => {
    const k1 = idempotencyKey("dk_test", { name: "Docs", prompt: "Check docs", schedule: { mode: "cron" } });
    const k2 = idempotencyKey("dk_test", { schedule: { mode: "cron" }, prompt: "Check docs", name: "Docs" });
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the key DIFFERS across configs and across machines (tokens)", () => {
    const base = { name: "Docs", prompt: "Check docs", schedule: { mode: "cron", cron: "0 6 * * 1" } };
    expect(idempotencyKey("dk_test", base)).not.toBe(idempotencyKey("dk_test", { ...base, schedule: { ...base.schedule, cron: "0 7 * * 1" } }));
    expect(idempotencyKey("dk_a", base)).not.toBe(idempotencyKey("dk_b", base));
  });

  test("hashing the full resolved body covers every transport and config field", () => {
    const body = { name: "Docs", prompt: "Check docs", schedule: { mode: "cron", timezone: "Europe/Paris" } };
    expect(idempotencyKey("dk_test", body)).toBe(idempotencyKey("dk_test", { ...body }));
    expect(idempotencyKey("dk_test", body)).not.toBe(idempotencyKey("dk_test", { ...body, schedule: { ...body.schedule, timezone: "America/New_York" } }));
    expect(idempotencyKey("dk_test", body)).not.toBe(idempotencyKey("dk_test", { ...body, dryRun: true }));
    expect(idempotencyKey("dk_test", { ...body, agent: "claude-code" })).not.toBe(idempotencyKey("dk_test", { ...body, agent: "codex" }));
    expect(idempotencyKey("dk_test", body)).toBe(idempotencyKey("dk_test", { ...body, idempotencyKey: "whatever" }));
  });
});

describe("runCreate", () => {
  const readActiveConnection = () => ({ serverUrl: "http://test", deviceToken: "dk_test" });
  const keyOf = (sent: any[]) => JSON.parse(sent[sent.length - 1].argv[2]).idempotencyKey as string | undefined;

  test("a real create stamps a 64-hex `idempotencyKey`, stable across a retry of the same config", async () => {
    const cfg = cfgJson(validConfig());
    const sent: any[] = [];
    const run = (json: string) =>
      runCreate(["--json", json], {
        readActiveConnection,
        fetchImpl: async (_url: any, init: any) => {
          sent.push(JSON.parse((init as any).body as string));
          return okResponse({ ok: true, id: "loop-1", name: "X", text: "created: X (loop-1)", exitCode: 0 });
        },
        stdout: () => {},
      });
    expect(await run(cfg)).toBe(0);
    const first = keyOf(sent);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await run(cfg)).toBe(0);
    expect(keyOf(sent)).toBe(first);
    expect(await run(cfgJson(validConfig({ schedule: { mode: "cron", cron: "0 6 * * *", timezone: "UTC", overlap: "skip" } })))).toBe(0);
    expect(keyOf(sent)).not.toBe(first);
  });
});
