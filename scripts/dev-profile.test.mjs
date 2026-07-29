import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { developmentEnvironment, developmentProcessEnvironment } from "./dev-profile.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("development entrypoints use repo-local state and a non-production port", () => {
  const env = developmentEnvironment({}, { repoRoot, execPath: "/usr/bin/node" });

  assert.equal(env.PIEVO_DATA_DIR, path.join(repoRoot, ".pievo", "development", "server"));
  assert.equal(env.PIEVO_HOME, path.join(repoRoot, ".pievo", "development", "daemon"));
  assert.equal(env.PIEVO_PORT, "3001");
  assert.equal(env.PIEVO_BASE_URL, "http://127.0.0.1:3001");
  assert.notEqual(env.PIEVO_DATA_DIR, path.join(os.homedir(), ".pievo"));
  assert.notEqual(env.PIEVO_HOME, path.join(os.homedir(), ".pievo"));
  assert.match(env.PIEVO_CLI, /packages\/daemon\/scripts\/dev\.mjs/);
});

test("explicit development environment overrides remain authoritative", () => {
  const explicit = {
    PIEVO_DATA_DIR: "/custom/server",
    PIEVO_HOME: "/custom/daemon",
    PIEVO_PORT: "4123",
    PIEVO_BASE_URL: "https://dev.example",
    PIEVO_CLI: "custom-pievo",
  };

  assert.deepEqual(developmentEnvironment(explicit, { repoRoot, execPath: "/usr/bin/node" }), explicit);
});

test("file configuration is retained while shell values take precedence", () => {
  const env = developmentProcessEnvironment(
    { GITHUB_CLIENT_ID: "from-file", PIEVO_PORT: "3002" },
    { PIEVO_PORT: "3003", PIEVO_AUTH_SECRET: "from-shell" },
    { repoRoot, execPath: "/usr/bin/node" },
  );

  assert.equal(env.GITHUB_CLIENT_ID, "from-file");
  assert.equal(env.PIEVO_AUTH_SECRET, "from-shell");
  assert.equal(env.PIEVO_PORT, "3003");
  assert.equal(env.PIEVO_BASE_URL, "http://127.0.0.1:3003");
});

test("generated CLI protects shell metacharacters in source paths", () => {
  const env = developmentEnvironment({}, {
    repoRoot: "/tmp/pievo $repo's copy",
    execPath: "/opt/node $current/bin/node",
  });

  assert.equal(
    env.PIEVO_CLI,
    "'/opt/node $current/bin/node' '/tmp/pievo $repo'\\''s copy/packages/daemon/scripts/dev.mjs'",
  );
});
