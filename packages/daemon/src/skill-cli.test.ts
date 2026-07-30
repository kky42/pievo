import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { runSkill, type RunSkillOpts } from "./skill-cli.js";
import { SKILL_TARGET_AGENTS } from "./skill-install.js";

const tempDirs: string[] = [];

function tempDir(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pievo-skill-cli-${name}-`));
  tempDirs.push(dir);
  return dir;
}

function fixture(): Required<RunSkillOpts> {
  const home = tempDir("home");
  const dir = tempDir("source");
  fs.writeFileSync(path.join(dir, "SKILL.md"), "fixture");
  return { home, dir };
}

async function captureStatus(opts: RunSkillOpts): Promise<string> {
  let out = "";
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out += String(chunk);
    return true;
  });
  try {
    await runSkill(["status"], opts);
  } finally {
    spy.mockRestore();
  }
  return out;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("pievo skill status — multi-agent", () => {
  test("reports every targeted agent (Claude Code + Codex) by label", async () => {
    const out = await captureStatus(fixture());
    for (const t of SKILL_TARGET_AGENTS) {
      expect(out).toContain(t.label);
    }
    // Pi consumes the universal ~/.agents/skills copy.
    expect(SKILL_TARGET_AGENTS.map((t) => t.id)).toEqual(["claude-code", "codex"]);
  });

  test("reports each agent's injected user install with a real verdict", async () => {
    const opts = fixture();
    const installed = path.join(opts.home, ...SKILL_TARGET_AGENTS[0]!.skillsRoot, "pievo");
    fs.mkdirSync(installed, { recursive: true });
    fs.writeFileSync(path.join(installed, "SKILL.md"), "installed");

    const out = await captureStatus(opts);

    for (const t of SKILL_TARGET_AGENTS) {
      const userDir = path.join(opts.home, ...t.skillsRoot, "pievo");
      const userInstalled = fs.existsSync(path.join(userDir, "SKILL.md"));
      expect(out).toContain(`${t.label} user (${userDir}): ${userInstalled ? "installed" : "not installed"}`);
    }
    expect(out).not.toContain(" project (");
    expect(out).toContain("bundled source: available");
  });

  test("distinct skill-root per agent — Claude Code under .claude, Codex under .agents", async () => {
    const out = await captureStatus(fixture());
    expect(out).toContain(path.join(".claude", "skills", "pievo"));
    expect(out).toContain(path.join(".agents", "skills", "pievo"));
  });

  test.each(["-g", "--global", "--project", "--local"])("rejects unsupported flag %s", async (flag) => {
    let err = "";
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      err += String(chunk);
      return true;
    });
    const code = await runSkill(["install", flag], fixture());
    spy.mockRestore();
    expect(code).toBe(2);
    expect(err).toContain("pievo skill [status|install]");
  });
});
