import { describe, expect, test } from "vitest";

import { isValidSemver } from "./semver.js";

describe("isValidSemver", () => {
  test("accepts complete canonical SemVer and rejects protocol-gate ambiguity", () => {
    expect(isValidSemver("2.4.0")).toBe(true);
    expect(isValidSemver("2.4.0-rc.1+build.7")).toBe(true);
    for (const value of ["2.4", "2.4.0garbage", "2.4.0.1", " 2.4.0", "2.4.0 ", "v2.4.0", "02.4.0", "2.4.0-01"]) {
      expect(isValidSemver(value)).toBe(false);
    }
  });
});
