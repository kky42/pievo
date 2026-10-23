import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Isolate ~/.pievo BEFORE config.ts loads (PIEVO_DIR is read at import) so the
// shim never touches a real daemon home.
vi.hoisted(() => {
  process.env.PIEVO_HOME = "/tmp/pievo-callback-test-home-does-not-exist";
});

import { runCallback } from "./callback.js";

describe("runCallback — in-run shim refusal", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const stderr = () => errSpy.mock.calls.map((call) => String(call[0])).join("");

  test.each([
    ["report", "--status", "ok", "--message", "done"],
    ["report", "--help"],
    ["log"],
    [],
  ])("refuses %j with the run contract message", async (...argv: string[]) => {
    expect(await runCallback(argv)).toBe(2);
    expect(stderr()).toMatch(/commands are not available inside a Pievo run/);
    expect(stderr()).toContain("$PIEVO_LOOP_DIR");
    expect(stderr()).toContain("STATUS: ok|block");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
