import test from "node:test";
import assert from "node:assert/strict";

import { parseArgs } from "../e2e/run-scenario.js";

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("parseArgs rejects missing values for value options", () => {
  for (const option of ["--scenario", "--model", "--reasoning", "--timeout-ms", "--out-dir"]) {
    const expected = new RegExp(`${escapeRegExp(option)} requires a value`);
    assert.throws(() => parseArgs([option]), expected);
    assert.throws(() => parseArgs([option, "--verbose"]), expected);
  }
});

test("parseArgs accepts explicit value options", () => {
  const options = parseArgs([
    "--scenario", "a.yaml",
    "--model", "test-model",
    "--reasoning", "high",
    "--timeout-ms", "1234",
    "--out-dir", "out",
    "--verbose",
    "b.yaml"
  ]);

  assert.deepEqual(options.scenarios, ["a.yaml", "b.yaml"]);
  assert.equal(options.model, "test-model");
  assert.equal(options.reasoningEffort, "high");
  assert.equal(options.timeoutMs, 1_234);
  assert.equal(options.outDir, "out");
  assert.equal(options.verbose, true);
});

test("parseArgs validates timeout value after parsing", () => {
  assert.throws(
    () => parseArgs(["--timeout-ms", "-1"]),
    /--timeout-ms must be a positive number/
  );
});
