import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import { addAgentConfig } from "../src/config-scaffold.js";
import { formatLocalTimestamp, localTimeZoneInfo, writeJsonFileAtomic } from "../src/utils.js";

test("formatLocalTimestamp uses local timezone without a suffix", () => {
  const previousTimezone = process.env.TZ;
  process.env.TZ = "Asia/Shanghai";
  try {
    assert.equal(formatLocalTimestamp(1700000001), "2023-11-15 06:13:21");
    assert.doesNotMatch(formatLocalTimestamp(1700000001), /UTC|Z\b|[+-]\d\d:\d\d/);
  } finally {
    if (previousTimezone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previousTimezone;
    }
  }
});

test("localTimeZoneInfo exposes local timezone and UTC offset", () => {
  const previousTimezone = process.env.TZ;
  process.env.TZ = "Asia/Shanghai";
  try {
    assert.equal(localTimeZoneInfo(new Date("2026-06-20T12:00:00Z")).utcOffset, "+08:00");
    assert.equal(localTimeZoneInfo(new Date("2026-06-20T12:00:00Z")).timeZone, "Asia/Shanghai");
  } finally {
    if (previousTimezone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previousTimezone;
    }
  }
});

test("writeJsonFileAtomic writes private JSON files", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX file mode assertion");
    return;
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pievo-json-mode-"));
  try {
    const filePath = path.join(tempDir, "config.json");
    await writeJsonFileAtomic(filePath, { token: "secret" });

    const stats = await fs.stat(filePath);
    assert.equal(stats.mode & 0o777, 0o600);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("addAgentConfig creates private agent directories and config", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX file mode assertion");
    return;
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pievo-add-agent-mode-"));
  try {
    const agentsRoot = path.join(tempDir, "agents");
    const result = await addAgentConfig({
      agentId: "relaybot",
      configPath: agentsRoot,
      homeDir: tempDir
    });

    assert.equal((await fs.stat(agentsRoot)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(result.agentDir)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(result.configFilePath)).mode & 0o777, 0o600);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
