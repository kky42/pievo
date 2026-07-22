import { expect, test } from "vitest";

import { WIRE_TEXT_CAP } from "./http.js";
import { validateSteerInstruction } from "./validate.js";

test("steer instruction validation is shared, NUL-safe, and fail-loud at the wire budget", () => {
  expect(validateSteerInstruction("  change\0 cadence  ")).toEqual({ ok: true, value: "change cadence" });
  expect(validateSteerInstruction(" \0 ")).toEqual({ ok: false, detail: "describe what to change" });
  expect(validateSteerInstruction("x".repeat(WIRE_TEXT_CAP + 1))).toEqual({
    ok: false,
    detail: `steer instruction exceeds ${WIRE_TEXT_CAP} characters`,
  });
});
