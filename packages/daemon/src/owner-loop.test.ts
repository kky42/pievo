import path from "node:path";
import { describe, expect, test } from "vitest";

import { resolveLoopId, resolveOwnerLoop } from "./owner-loop.js";

describe("owner loop resolution", () => {
  test("prefers an exact id and the most specific containing workdir", () => {
    const loops = [
      { id: "outer", name: "Outer", workdir: path.join(path.sep, "work") },
      { id: "inner", name: "Inner", workdir: path.join(path.sep, "work", "inner") },
    ];
    expect(resolveLoopId(loops, "outer", "/unrelated")).toEqual({ id: "outer", name: "Outer" });
    expect(resolveLoopId(loops, undefined, path.join(path.sep, "work", "inner", "src")))
      .toEqual({ id: "inner", name: "Inner" });
  });

  test("retains structured missing-loop and ambiguous-name errors", () => {
    const loops = [
      { id: "one", name: "Same", workdir: "/one" },
      { id: "two", name: "Same", workdir: "/two" },
    ];
    expect(resolveLoopId(loops, "missing", "/tmp")).toEqual({
      error: 'no loop "missing" on this machine — run `pievo loops` to list them',
      code: "NOT_FOUND",
    });
    expect(resolveLoopId(loops, "Same", "/tmp")).toEqual({
      error: '"Same" matches multiple loops — pass the loop id instead',
    });
  });

  test("maps owner list transport failures without rendering command-specific prose", async () => {
    const fetchImpl = (async () => ({
      status: 503,
      json: async () => ({ error: "list unavailable" }),
    })) as unknown as typeof fetch;
    await expect(resolveOwnerLoop(undefined, "/tmp", {
      server: "https://srv.test",
      deviceToken: "dk_test",
      fetchImpl,
    })).resolves.toEqual({ kind: "list-error", message: "list unavailable" });
  });
});
