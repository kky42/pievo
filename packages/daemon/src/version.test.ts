/**
 * Version resolution from both src/ and dist/ via `../package.json`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { daemonVersion } from "./version.js";

describe("package runtime floor", () => {
  test("requires the first Node 22 minor where node:sqlite is available without a flag", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
    expect(pkg.engines.node).toBe(">=22.13.0");
  });
});

describe("daemonVersion", () => {
  test("resolves this package's real version", () => {
    // ../package.json from src/ (this test's dir) is the daemon package.json.
    const v = daemonVersion();
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("base override: reads version from a package.json one dir up", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-ver-"));
    try {
      fs.mkdirSync(path.join(dir, "sub"));
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "1.2.3" }));
      expect(daemonVersion(path.join(dir, "sub"))).toBe("1.2.3");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing/garbage package.json → undefined (never throws)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-ver-"));
    try {
      expect(daemonVersion(path.join(dir, "sub"))).toBeUndefined(); // no package.json
      fs.writeFileSync(path.join(dir, "package.json"), "{ not json");
      expect(daemonVersion(path.join(dir, "sub"))).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
