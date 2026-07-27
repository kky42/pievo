import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { runLog, type LogDeps } from "./log.js";

function capture(extra: LogDeps = {}): LogDeps & { stdout: () => string; stderr: () => string } {
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

type LoopStub = { id: string; name: string; workdir: string };
function stub(loops: LoopStub[], render: (argv: string[]) => { status?: number; body: Record<string, unknown> }) {
  const calls: Array<{ url: string; argv: string[] }> = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const argv = JSON.parse(String(init.body)).argv as string[];
    calls.push({ url: String(url), argv });
    const response = argv[0] === "loops"
      ? { status: 200, body: { loops, text: "listed", exitCode: 0 } }
      : render(argv);
    return { status: response.status ?? 200, json: async () => response.body };
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const loopDir = path.join(os.tmpdir(), "pievo-log-test-workdir");

describe("runLog canonical transport", () => {
  test("not connected fails without fetching", async () => {
    let fetched = false;
    const cap = capture({ server: "", token: undefined, fetchFn: (async () => { fetched = true; }) as typeof fetch });
    expect(await runLog([], cap)).toBe(2);
    expect(fetched).toBe(false);
    expect(cap.stderr()).toContain("isn't connected");
  });

  test("resolves the current workdir and posts both requests to /api/machine/cli", async () => {
    const toon = "loop: Here\ncount: 0";
    const { fetchFn, calls } = stub([{ id: "loop-here", name: "Here", workdir: loopDir }], () => ({ body: { text: toon, exitCode: 0 } }));
    const cap = capture({ cwd: () => path.join(loopDir, "nested"), fetchFn });
    expect(await runLog([], cap)).toBe(0);
    expect(calls.map((call) => call.argv)).toEqual([["loops"], ["log", "loop-here"]]);
    expect(calls.every((call) => call.url === "https://srv.test/api/machine/cli")).toBe(true);
    expect(cap.stdout()).toBe(toon + "\n");
  });

  test("an explicit id and all history flags are forwarded canonically", async () => {
    const json = JSON.stringify({ count: 1, total: 1 });
    const { fetchFn, calls } = stub([{ id: "loop-x", name: "X", workdir: "/elsewhere" }], () => ({ body: { text: json, exitCode: 0 } }));
    const cap = capture({ cwd: () => "/unrelated", fetchFn });
    expect(await runLog(["loop-x", "--limit=5", "--since", "2026-01-01T00:00:00Z", "--json"], cap)).toBe(0);
    expect(calls[1]!.argv).toEqual(["log", "loop-x", "--json", "--since", "2026-01-01T00:00:00Z", "--limit", "5"]);
    expect(cap.stdout()).toBe(json + "\n");
  });

  test("no workdir match asks for an explicit loop", async () => {
    const { fetchFn } = stub([{ id: "loop-x", name: "X", workdir: "/elsewhere" }], () => ({ body: { text: "unused" } }));
    const cap = capture({ cwd: () => loopDir, fetchFn });
    expect(await runLog([], cap)).toBe(2);
    expect(cap.stderr()).toContain("loop id");
  });

  test("an explicit missing loop is a structured NOT_FOUND", async () => {
    const { fetchFn } = stub([{ id: "loop-x", name: "X", workdir: "/elsewhere" }], () => ({ body: { text: "unused" } }));
    const cap = capture({ cwd: () => "/unrelated", fetchFn });
    expect(await runLog(["missing"], cap)).toBe(1);
    expect(cap.stdout()).toContain("code: NOT_FOUND");
  });

  test("unknown flags fail before fetching", async () => {
    let fetched = false;
    const cap = capture({ fetchFn: (async () => { fetched = true; }) as typeof fetch });
    expect(await runLog(["--bogus"], cap)).toBe(2);
    expect(fetched).toBe(false);
  });

  test("server errors use the rendered text and exit code", async () => {
    const { fetchFn } = stub([{ id: "loop-x", name: "X", workdir: "/elsewhere" }], () => ({ status: 404, body: { text: "error: not found", exitCode: 1 } }));
    const cap = capture({ cwd: () => "/unrelated", fetchFn });
    expect(await runLog(["loop-x"], cap)).toBe(1);
    expect(cap.stdout()).toContain("error: not found");
  });

  test("a response without rendered text fails loudly", async () => {
    const { fetchFn } = stub([{ id: "loop-x", name: "X", workdir: "/elsewhere" }], () => ({ body: {} }));
    const cap = capture({ cwd: () => "/unrelated", fetchFn });
    expect(await runLog(["loop-x"], cap)).toBe(1);
    expect(cap.stdout()).toContain("INVALID_SERVER_RESPONSE");
  });
});
