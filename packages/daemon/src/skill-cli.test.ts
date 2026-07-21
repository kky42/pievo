/**
 * `pievo skill status` — honest, per-agent install reporting. The install now
 * targets every agent in `SKILL_TARGET_AGENTS` (Claude Code + Codex today), so
 * status must report each one's user-scope location, derived from the same target
 * list as the installer so the two surfaces cannot drift.
 * Nothing here spawns npx or hits the network — status is pure filesystem reads.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { runSkill } from "./skill-cli.js";
import { SKILL_TARGET_AGENTS } from "./skill-install.js";

/** Capture stdout for the duration of one runSkill call. */
async function captureStatus(): Promise<string> {
  let out = "";
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out += String(chunk);
    return true;
  });
  try {
    await runSkill(["status"]);
  } finally {
    spy.mockRestore();
  }
  return out;
}

afterEach(() => vi.restoreAllMocks());

describe("pievo skill status — multi-agent", () => {
  test("reports every targeted agent (Claude Code + Codex) by label", async () => {
    const out = await captureStatus();
    for (const t of SKILL_TARGET_AGENTS) {
      expect(out).toContain(t.label);
    }
    // The two CodingAgent values are exactly what we target today.
    expect(SKILL_TARGET_AGENTS.map((t) => t.id)).toEqual(["claude-code", "codex"]);
  });

  test("reports each agent's user install with a real verdict", async () => {
    const out = await captureStatus();
    for (const t of SKILL_TARGET_AGENTS) {
      const userDir = path.join(os.homedir(), ...t.skillsRoot, "pievo");
      const userInstalled = fs.existsSync(path.join(userDir, "SKILL.md"));
      expect(out).toContain(`${t.label} user (${userDir}): ${userInstalled ? "installed" : "not installed"}`);
    }
    expect(out).not.toContain(" project (");
    expect(out).toMatch(/bundled source: (available|missing)/);
  });

  test("distinct skill-root per agent — Claude Code under .claude, Codex under .agents", async () => {
    const out = await captureStatus();
    expect(out).toContain(path.join(".claude", "skills", "pievo"));
    expect(out).toContain(path.join(".agents", "skills", "pievo"));
  });

  test.each(["--project", "--local"])("rejects retired project flag %s", async (flag) => {
    let err = "";
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      err += String(chunk);
      return true;
    });
    const code = await runSkill(["install", flag]);
    spy.mockRestore();
    expect(code).toBe(2);
    expect(err).toContain("pievo skill [status|install]");
  });
});
