import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { applyScenarioDefaults, defaultScenarioPaths, loadScenario } from "../e2e/scenario-loader.js";

async function withTempDir(fn) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pievo-scenario-loader-"));
  try {
    return await fn(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test("defaultScenarioPaths returns sorted YAML files only", async () => {
  await withTempDir(async (tempDir) => {
    await fs.writeFile(path.join(tempDir, "b.yml"), "name: b\nsteps:\n  - prompt: b\n", "utf8");
    await fs.writeFile(path.join(tempDir, "a.yaml"), "name: a\nsteps:\n  - prompt: a\n", "utf8");
    await fs.writeFile(path.join(tempDir, "notes.txt"), "ignore", "utf8");

    assert.deepEqual(await defaultScenarioPaths({ scenariosDir: tempDir }), [
      path.join(tempDir, "a.yaml"),
      path.join(tempDir, "b.yml")
    ]);
  });
});

test("loadScenario applies file name and group mode defaults", async () => {
  await withTempDir(async (tempDir) => {
    const scenarioPath = path.join(tempDir, "group-default.yaml");
    await fs.writeFile(scenarioPath, "steps:\n  - id: one\n    prompt: hello\n", "utf8");

    const scenario = await loadScenario(scenarioPath);

    assert.equal(scenario.name, "group-default");
    assert.equal(scenario.mode, "group");
    assert.equal(scenario.__filePath, scenarioPath);
    assert.equal(scenario.steps[0].id, "one");
  });
});

test("applyScenarioDefaults validates that scenarios contain steps", () => {
  assert.throws(
    () => applyScenarioDefaults({ name: "empty" }, "empty.yaml"),
    /empty\.yaml must define at least one step/
  );
});
