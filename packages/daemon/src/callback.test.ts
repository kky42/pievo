/**
 * Callback mode — the in-run `pievo <verb>` path (run token in env). Proves it now
 * posts through `/api/machine/cli` carrying the run token. Global `fetch` is
 * stubbed and the run env is set, so nothing hits the network.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Isolate ~/.pievo BEFORE config.ts loads (PIEVO_DIR is read at import) so the
// not-configured test can't accidentally resolve a real stored server url.
vi.hoisted(() => {
  process.env.PIEVO_HOME = "/tmp/pievo-callback-test-home-does-not-exist";
});

import { runCallback } from "./callback.js";

type Call = { url: string; init: any };

/** Stub global fetch with a per-request handler; record every call. */
function stubFetch(handler: (url: string, init: any) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    const r = handler(String(url), init);
    return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body } as Response;
  });
  return calls;
}

describe("runCallback — unified dispatch", () => {
  const prevToken = process.env.PIEVO_RUN_TOKEN;
  const prevServer = process.env.PIEVO_SERVER_URL;
  let outSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.PIEVO_RUN_TOKEN = "run-tok-1";
    process.env.PIEVO_SERVER_URL = "https://srv.test";
    outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (prevToken === undefined) delete process.env.PIEVO_RUN_TOKEN;
    else process.env.PIEVO_RUN_TOKEN = prevToken;
    if (prevServer === undefined) delete process.env.PIEVO_SERVER_URL;
    else process.env.PIEVO_SERVER_URL = prevServer;
  });

  const stdout = () => outSpy.mock.calls.map((c) => String(c[0])).join("");
  const stderr = () => errSpy.mock.calls.map((c) => String(c[0])).join("");

  test("posts argv to /api/machine/cli with the RUN token; renders text + exitCode", async () => {
    const calls = stubFetch(() => ({ status: 200, body: { text: "reported.", exitCode: 0 } }));
    const code = await runCallback(["report", "--status", "no-change", "--message", "nothing changed"]);
    expect(code).toBe(0);
    expect(calls[0]!.url).toBe("https://srv.test/api/machine/cli");
    expect(JSON.parse(calls[0]!.init.body).argv).toEqual(["report", "--status", "no-change", "--message", "nothing changed"]);
    expect(calls[0]!.init.headers.Authorization).toBe("Bearer run-tok-1");
    expect(stdout()).toContain("reported.");
  });

  test("a non-zero server exitCode is propagated to the process exit code", async () => {
    stubFetch(() => ({ status: 200, body: { text: "pievo: bad flag", exitCode: 2 } }));
    expect(await runCallback(["report", "--bogus"])).toBe(2);
    expect(stdout()).toContain("bad flag");
  });

  test("run credentials expose only report", async () => {
    const calls = stubFetch(() => ({ status: 200, body: { text: "should not run", exitCode: 0 } }));
    expect(await runCallback(["log"])).toBe(2);
    expect(stderr()).toContain("only `report` is available");
    expect(calls).toHaveLength(0);
  });

  test("a response without rendered text fails loudly", async () => {
    stubFetch(() => ({ status: 200, body: { ok: true } }));
    expect(await runCallback(["report"])).toBe(1);
    expect(stdout()).toContain("code: INVALID_SERVER_RESPONSE");
  });

  test("no server url → run callback not configured (exit 2, no fetch)", async () => {
    delete process.env.PIEVO_SERVER_URL;
    const calls = stubFetch(() => ({ status: 200, body: {} }));
    const code = await runCallback(["report"]);
    expect(code).toBe(2);
    expect(stderr()).toContain("run callback not configured");
    expect(calls).toHaveLength(0);
  });
});
