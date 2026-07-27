/**
 * `buildPatch` / `parseFlags` — the `pievo edit` canonical JSON patch.
 * Proves the whole envelope travels via a single `--json '<obj>'`, and any
 * unknown flag fails loudly with "unknown flag … try --help". The server is the
 * sole validator, so these tests only assert the SHAPE the daemon sends.
 */
import { describe, expect, test } from "vitest";

import { buildPatch, type InteractiveDeps, parseFlags, runInteractive } from "./interactive.js";


/**
 * `runInteractive` fetch path with the token/server/fetch INJECTED so nothing touches
 * ~/.pievo. Proves `loops`/`edit` use canonical `/api/machine/cli` dispatch.
 */
function capture(extra: InteractiveDeps = {}): InteractiveDeps & { stdout: () => string; stderr: () => string } {
  let out = "";
  let err = "";
  return {
    out: (s) => { out += s; },
    err: (s) => { err += s; },
    server: "https://srv.test",
    token: "dk_test",
    stdout: () => out,
    stderr: () => err,
    ...extra,
  };
}

/** A fetch stub recording each {url, method, argv?, body?}; unified when argv present. */
function stub(handler: (req: { url: string; method: string; argv: string[]; parsedBody: any }) => { ok: boolean; status?: number; body: unknown }) {
  const calls: Array<{ url: string; method: string; argv: string[]; parsedBody: any }> = [];
  const fetchFn = (async (url: string, init: any) => {
    const parsedBody = init?.body ? JSON.parse(init.body) : undefined;
    const req = { url: String(url), method: init?.method ?? "GET", argv: parsedBody?.argv ?? [], parsedBody };
    calls.push(req);
    const r = handler(req);
    return { ok: r.ok, status: r.status ?? 200, json: async () => r.body };
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe("canonical edit envelope", () => {
  test("accepts schedule/prompt/status/artifacts JSON and rejects unknown flags", () => {
    const patch = buildPatch({ json: JSON.stringify({
      schedule: { mode: "continuous", delayMinutes: 5 },
      prompt: "do it",
      statusDefinitions: { keep: "yes", noChange: "none", block: "help" },
      artifacts: ["report.md"],
    }) });
    expect(patch).toMatchObject({ schedule: { mode: "continuous" }, prompt: "do it", artifacts: ["report.md"] });
    expect(() => buildPatch({ "unknown-file": "input.txt" })).toThrow(/unknown flag --unknown-file/);
  });
});

describe("runInteractive — text sink (new server renders TOON in `text`)", () => {
  test("loops → posts {argv:['loops']} and prints the server's `text` verbatim, exit `exitCode`", async () => {
    const toon = "count: 1\nloops[1]{id,name,cron,enabled,nextFire}:\n  loop-1,Cookie,\"0 8 * * *\",on,—";
    const { fetchFn, calls } = stub(({ url, argv }) =>
      url.includes("/api/machine/cli") && argv[0] === "loops"
        ? { ok: true, body: { ok: true, loops: [{ id: "loop-1" }], text: toon, exitCode: 0 } }
        : { ok: false, status: 404, body: {} },
    );
    const cap = capture({ fetchImpl: fetchFn });
    expect(await runInteractive(["loops"], cap)).toBe(0);
    expect(calls[0]!.url).toBe("https://srv.test/api/machine/cli");
    expect(calls[0]!.argv).toEqual(["loops"]);
    // The daemon is a dumb sink: it prints the server's `text`, not its own render.
    expect(cap.stdout()).toBe(toon + "\n");
  });

  test("edit → prints the server `text` and honors its `exitCode` (a rejection dry-run exits 1)", async () => {
    const toon = "dry-run: Cookie — 0 changes valid, 1 rejected\nrejections[1]{key,reason}:\n  artifacts,bad";
    const { fetchFn } = stub(({ url, argv }) =>
      url.includes("/api/machine/cli") && argv[0] === "edit"
        ? { ok: false, body: { text: toon, exitCode: 1 } }
        : { ok: false, status: 404, body: {} },
    );
    const cap = capture({ fetchImpl: fetchFn });
    expect(await runInteractive(["edit", "loop-1", "--json", '{"artifacts":["/absolute"]}', "--dry-run"], cap)).toBe(1);
    expect(cap.stdout()).toBe(toon + "\n");
  });

  test("a response without rendered text fails loudly", async () => {
    const { fetchFn } = stub(({ url, argv }) =>
      url.includes("/api/machine/cli") && argv[0] === "loops"
        ? { ok: true, body: { loops: [{ id: "loop-1", name: "Cookie" }] } }
        : { ok: false, status: 404, body: {} },
    );
    const cap = capture({ fetchImpl: fetchFn });
    expect(await runInteractive(["loops"], cap)).toBe(1);
    expect(cap.stdout()).toContain("code: INVALID_SERVER_RESPONSE");
  });
});

describe("runInteractive — loops forwards its flags (F1–F4: the old bug hardcoded ['loops'])", () => {
  test("--fields is forwarded verbatim so the server can honor it (F1)", async () => {
    const toon = "count: 1\nloops[1]{id,name,cron,enabled,nextFire,model,reasoningEffort}:\n  loop-1,Cookie,\"0 8 * * *\",on,—,default,default";
    const { fetchFn, calls } = stub(({ url, argv }) =>
      url.includes("/api/machine/cli") && argv[0] === "loops" ? { ok: true, body: { ok: true, loops: [{ id: "loop-1" }], text: toon, exitCode: 0 } } : { ok: false, status: 404, body: {} },
    );
    const cap = capture({ fetchImpl: fetchFn });
    expect(await runInteractive(["loops", "--fields", "model,reasoningEffort"], cap)).toBe(0);
    expect(calls[0]!.argv).toEqual(["loops", "--fields", "model,reasoningEffort"]);
  });

  test("--fields=… (equals form) is parsed and forwarded", async () => {
    const { fetchFn, calls } = stub(({ url, argv }) =>
      url.includes("/api/machine/cli") && argv[0] === "loops" ? { ok: true, body: { ok: true, loops: [], text: "count: 0\nloops: []", exitCode: 0 } } : { ok: false, status: 404, body: {} },
    );
    const cap = capture({ fetchImpl: fetchFn });
    expect(await runInteractive(["loops", "--fields=model,reasoningEffort"], cap)).toBe(0);
    expect(calls[0]!.argv).toEqual(["loops", "--fields", "model,reasoningEffort"]);
  });

  test("--json is forwarded and its (JSON) text printed verbatim (F4)", async () => {
    const json = JSON.stringify([{ id: "loop-1", name: "Cookie" }], null, 2);
    const { fetchFn, calls } = stub(({ url, argv }) =>
      url.includes("/api/machine/cli") && argv.includes("--json") ? { ok: true, body: { ok: true, loops: [{ id: "loop-1" }], text: json, exitCode: 0 } } : { ok: false, status: 404, body: {} },
    );
    const cap = capture({ fetchImpl: fetchFn });
    expect(await runInteractive(["loops", "--json"], cap)).toBe(0);
    expect(calls[0]!.argv).toEqual(["loops", "--json"]);
    expect(cap.stdout().trimStart()[0]).toBe("["); // real JSON, not TOON
  });

  test("extra positional arguments on loops are rejected before fetch", async () => {
    const { fetchFn, calls } = stub(() => ({ ok: true, body: {} }));
    const cap = capture({ fetchImpl: fetchFn });
    expect(await runInteractive(["loops", "extra"], cap)).toBe(2);
    expect(cap.stderr()).toContain("usage: pievo loops");
    expect(calls).toHaveLength(0);
  });

  test("an unknown flag on loops → exit 2, no fetch (F3)", async () => {
    const { fetchFn, calls } = stub(() => ({ ok: true, body: {} }));
    const cap = capture({ fetchImpl: fetchFn });
    expect(await runInteractive(["loops", "--bogusflag"], cap)).toBe(2);
    expect(cap.stderr()).toContain("unknown flag --bogusflag");
    expect(calls).toHaveLength(0);
  });


});

describe("runInteractive — edit no-op (F8) + input-required guard", () => {
  test("edit --json '{}' is forwarded (NOT short-circuited to usage), server reports the no-op", async () => {
    const toon = "nothing to change: Cookie (loop-1)\neditable[13]: name, cron, timezone";
    const { fetchFn, calls } = stub(({ url, argv }) =>
      url.includes("/api/machine/cli") && argv[0] === "edit" ? { ok: true, body: { ok: true, nothingToChange: true, text: toon, exitCode: 0 } } : { ok: false, status: 404, body: {} },
    );
    const cap = capture({ fetchImpl: fetchFn });
    expect(await runInteractive(["edit", "loop-1", "--json", "{}"], cap)).toBe(0);
    expect(calls[0]!.argv).toEqual(["edit", "loop-1", "--json", "{}"]);
    expect(cap.stdout()).toBe(toon + "\n");
  });

  test("edit rejects extra positional arguments before fetch", async () => {
    const { fetchFn, calls } = stub(() => ({ ok: true, body: {} }));
    const cap = capture({ fetchImpl: fetchFn });
    expect(await runInteractive(["edit", "loop-1", "extra", "--json", "{}"], cap)).toBe(2);
    expect(cap.stderr()).toContain("usage");
    expect(calls).toHaveLength(0);
  });

  test("edit <id> with NO input flags is still a usage error (exit 2, no fetch)", async () => {
    const { fetchFn, calls } = stub(() => ({ ok: true, body: {} }));
    const cap = capture({ fetchImpl: fetchFn });
    expect(await runInteractive(["edit", "loop-1"], cap)).toBe(2);
    expect(cap.stderr()).toContain("usage");
    expect(calls).toHaveLength(0);
  });
});

describe("runInteractive — lifecycle commands", () => {
  test("forwards pause/start/stop/delete and run stop exactly", async () => {
    const { fetchFn, calls } = stub(() => ({ ok: true, body: { text: "ok", exitCode: 0 } }));
    const cap = capture({ fetchImpl: fetchFn, confirmForceDelete: async () => true });
    expect(await runInteractive(["pause", "loop-1"], cap)).toBe(0);
    expect(await runInteractive(["start", "loop-1"], cap)).toBe(0);
    expect(await runInteractive(["stop", "loop-1"], cap)).toBe(0);
    expect(await runInteractive(["delete", "loop-1", "--force"], cap)).toBe(0);
    expect(await runInteractive(["run", "stop", "run-1"], cap)).toBe(0);
    expect(calls.map((c) => c.argv)).toEqual([
      ["pause", "loop-1"], ["start", "loop-1"], ["stop", "loop-1"],
      ["delete", "loop-1", "--force", "--confirmation", "delete-server-data-anyway"], ["run", "stop", "run-1"],
    ]);
  });

  test("force delete requires interactive double-confirmation before network mutation", async () => {
    let fetched = false;
    const cap = capture({
      fetchImpl: (async () => { fetched = true; throw new Error("must not fetch"); }) as typeof fetch,
      confirmForceDelete: async () => false,
    });
    expect(await runInteractive(["delete", "loop-1", "--force"], cap)).toBe(1);
    expect(fetched).toBe(false);
    expect(cap.stderr()).toContain("force delete canceled");
  });

  test("requires exact positional arity and rejects flags outside delete --force without fetching", async () => {
    let fetched = false;
    const cap = capture({ fetchImpl: (async () => { fetched = true; throw new Error("no"); }) as typeof fetch });
    expect(await runInteractive(["pause"], cap)).toBe(2);
    expect(await runInteractive(["pause", "loop-1", "extra"], cap)).toBe(2);
    expect(await runInteractive(["stop", "loop-1", "--force"], cap)).toBe(2);
    expect(await runInteractive(["delete", "loop-1", "--force", "extra"], cap)).toBe(2);
    expect(await runInteractive(["run", "stop"], cap)).toBe(2);
    expect(await runInteractive(["run", "stop", "run-1", "extra"], cap)).toBe(2);
    expect(fetched).toBe(false);
  });
});

describe("runInteractive — local guards (no fetch)", () => {
  test("not connected → exit 2 with a clear message, no fetch", async () => {
    const { fetchFn, calls } = stub(() => ({ ok: true, body: {} }));
    const cap = capture({ fetchImpl: fetchFn, server: "", token: undefined });
    expect(await runInteractive(["loops"], cap)).toBe(2);
    expect(cap.stderr()).toContain("isn't connected");
    expect(calls).toHaveLength(0);
  });

  test("edit with no id → usage, exit 2, no fetch", async () => {
    const { fetchFn, calls } = stub(() => ({ ok: true, body: {} }));
    const cap = capture({ fetchImpl: fetchFn });
    expect(await runInteractive(["edit"], cap)).toBe(2);
    expect(cap.stderr()).toContain("usage");
    expect(calls).toHaveLength(0);
  });

  test("an unknown interactive verb → exit 2", async () => {
    const { fetchFn } = stub(() => ({ ok: true, body: {} }));
    const cap = capture({ fetchImpl: fetchFn });
    expect(await runInteractive(["bogus"], cap)).toBe(2);
    expect(cap.stderr()).toContain("unknown command");
  });
});
