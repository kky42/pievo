import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Isolate ~/.pievo BEFORE config.ts loads (PIEVO_DIR is read at import) so the
// shim never touches a real daemon home.
vi.hoisted(() => {
  process.env.PIEVO_HOME = "/tmp/pievo-callback-test-home-does-not-exist";
});

import { runCallback } from "./callback.js";

describe("runCallback — in-run read-only pievo", () => {
  let outSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => vi.restoreAllMocks());

  const stdout = () => outSpy.mock.calls.map((call) => String(call[0])).join("");

  test("forwards argv with the run context token, never the device credential", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ text: "runs: 0", exitCode: 0 }), { status: 200 }));
    const env = { PIEVO_RUN_CONTEXT: `rc_${"a".repeat(32)}`, PIEVO_SERVER_URL: "http://127.0.0.1:3001" };
    expect(await runCallback(["log", "--since", "2026-10-01T00:00:00Z"], env, fetchImpl as unknown as typeof fetch)).toBe(0);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:3001/api/machine/cli");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${env.PIEVO_RUN_CONTEXT}`);
    expect(JSON.parse(String(init.body))).toEqual({ argv: ["log", "--since", "2026-10-01T00:00:00Z"] });
    expect(stdout()).toContain("runs: 0");
  });

  test("help needs no server, and a run without context makes no request", async () => {
    const fetchImpl = vi.fn();
    expect(await runCallback([], {}, fetchImpl as unknown as typeof fetch)).toBe(0);
    expect(stdout()).toContain("read-only");
    expect(await runCallback(["log"], {}, fetchImpl as unknown as typeof fetch)).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
