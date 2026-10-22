import { describe, expect, test } from "vitest";

import { classify } from "./route.js";

describe("classify lifecycle routing", () => {
  test("nested help wins before every lifecycle handler", () => {
    for (const subcommand of ["start", "stop", "restart", "status"]) {
      expect(classify(["daemon", subcommand, "--help"], {})).toEqual({ kind: "help", verb: `daemon ${subcommand}` });
    }
  });

  test("server flags never launch the daemon", () => {
    expect(classify(["--server-url", "http://x"], {})).toEqual({ kind: "unknown", verb: "--server-url" });
  });

  test("in-run routing wins and preserves argv exactly", () => {
    expect(classify(["daemon", "stop"], { PIEVO_IN_RUN: "1" })).toEqual({ kind: "callback", argv: ["daemon", "stop"] });
    expect(classify(["report", "--help"], { PIEVO_IN_RUN: "1" })).toEqual({ kind: "callback", argv: ["report", "--help"] });
    expect(classify([], { PIEVO_IN_RUN: "1" })).toEqual({ kind: "callback", argv: [] });
  });

  test("out-of-run report has no route", () => {
    expect(classify(["report", "--message", "done"], {})).toEqual({ kind: "unknown", verb: "report" });
    expect(classify(["report", "--help"], {})).toEqual({ kind: "unknown", verb: "report" });
  });
});
