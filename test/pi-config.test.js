import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../src/config.js";

async function writeAgentConfig({ rootDir, agentId = "agent", profile }) {
  const agentDir = path.join(rootDir, agentId);
  const workdir = path.join(rootDir, ".workdir");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(workdir, { recursive: true });
  await fs.writeFile(
    path.join(agentDir, "config.json"),
    `${JSON.stringify(
      {
        profile: {
          workdir,
          auto: "medium",
          model: "default",
          reasoningEffort: "default",
          ...profile
        },
        bindings: {}
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return { workdir };
}

test("loadConfig rejects profile.cli because Pievo is Pi-only", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pievo-config-"));
  await writeAgentConfig({
    rootDir: tempDir,
    profile: {
      cli: "pi"
    }
  });

  await assert.rejects(
    loadConfig(tempDir),
    /profile\.cli is no longer supported\. Pievo always uses Pi\./
  );
});

test("loadConfig loads Pi-only profiles without cli state", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pievo-config-"));
  const { workdir } = await writeAgentConfig({
    rootDir: tempDir,
    profile: {}
  });

  const config = await loadConfig(tempDir);

  assert.equal(config.agents.length, 1);
  assert.equal(config.agents[0].id, "agent");
  assert.equal(config.agents[0].workdir, workdir);
  assert.equal(Object.hasOwn(config.agents[0], "cli"), false);
});
