import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import {
  bundledSkillDir,
  installSkill,
  targetSkillDirs,
} from "./skill-install.js";

const tempDirs: string[] = [];

function tempDir(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pievo-${name}-`));
  tempDirs.push(dir);
  return dir;
}

function makeSource(content = "new skill"): string {
  const source = tempDir("skill-source");
  fs.mkdirSync(path.join(source, "references"));
  fs.writeFileSync(path.join(source, "SKILL.md"), content);
  fs.writeFileSync(path.join(source, "references", "create.md"), "reference");
  return source;
}

function installedDirs(home: string): string[] {
  return targetSkillDirs(home);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("bundled skill", () => {
  test("requires explicit invocation for every supported agent", () => {
    const dir = bundledSkillDir();
    expect(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8")).toMatch(
      /^disable-model-invocation: true$/m,
    );
    expect(fs.readFileSync(path.join(dir, "agents", "openai.yaml"), "utf8")).toBe(
      "policy:\n  allow_implicit_invocation: false\n",
    );
  });
});

describe("targetSkillDirs", () => {
  test("returns the fixed user skill directories", () => {
    expect(targetSkillDirs()).toEqual([
      "~/.claude/skills/pievo",
      "~/.agents/skills/pievo",
    ]);
  });
});

describe("installSkill", () => {
  test("first install copies the complete bundle to both agents and Claude", async () => {
    const source = makeSource();
    const home = tempDir("home");

    const result = await installSkill({ dir: source, home });

    expect(result.ok).toBe(true);
    for (const target of installedDirs(home)) {
      expect(fs.readFileSync(path.join(target, "SKILL.md"), "utf8")).toBe("new skill");
      expect(fs.readFileSync(path.join(target, "references", "create.md"), "utf8")).toBe("reference");
    }
  });

  test("overwrites an existing same-named skill", async () => {
    const source = makeSource("current bundled skill");
    const home = tempDir("home");
    for (const target of installedDirs(home)) {
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, "SKILL.md"), "old user content");
    }

    const result = await installSkill({ dir: source, home });

    expect(result.ok).toBe(true);
    for (const target of installedDirs(home)) {
      expect(fs.readFileSync(path.join(target, "SKILL.md"), "utf8")).toBe("current bundled skill");
    }
  });

  test("replacement removes files left over from an older version", async () => {
    const source = makeSource();
    const home = tempDir("home");
    for (const target of installedDirs(home)) {
      fs.mkdirSync(path.join(target, "obsolete"), { recursive: true });
      fs.writeFileSync(path.join(target, "SKILL.md"), "old");
      fs.writeFileSync(path.join(target, "obsolete", "removed.md"), "stale");
    }

    await installSkill({ dir: source, home });

    for (const target of installedDirs(home)) {
      expect(fs.existsSync(path.join(target, "obsolete", "removed.md"))).toBe(false);
    }
  });

  test("source without SKILL.md leaves every old target untouched", async () => {
    const source = tempDir("invalid-source");
    fs.writeFileSync(path.join(source, "other.md"), "not a skill");
    const home = tempDir("home");
    for (const target of installedDirs(home)) {
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, "SKILL.md"), "keep me");
      fs.writeFileSync(path.join(target, "local.md"), "also keep me");
    }

    const result = await installSkill({ dir: source, home });

    expect(result.ok).toBe(false);
    expect(result.line).toContain("bundled skill not found");
    for (const target of installedDirs(home)) {
      expect(fs.readFileSync(path.join(target, "SKILL.md"), "utf8")).toBe("keep me");
      expect(fs.readFileSync(path.join(target, "local.md"), "utf8")).toBe("also keep me");
    }
  });

  test("one target failure does not prevent the other target from updating", async () => {
    const source = makeSource("updated despite peer failure");
    const home = tempDir("home");
    fs.writeFileSync(path.join(home, ".claude"), "blocks the Claude directory");
    const agentsTarget = path.join(home, ".agents", "skills", "pievo");
    fs.mkdirSync(agentsTarget, { recursive: true });
    fs.writeFileSync(path.join(agentsTarget, "SKILL.md"), "old");

    const result = await installSkill({ dir: source, home });

    expect(result.ok).toBe(false);
    expect(result.line).toContain("~/.claude/skills/pievo");
    expect(result.line).toContain("retry with `pievo skill install`");
    expect(fs.readFileSync(path.join(agentsTarget, "SKILL.md"), "utf8")).toBe(
      "updated despite peer failure",
    );
  });

  test("implementation uses in-process filesystem operations, not an external process", () => {
    const implementation = fs.readFileSync(
      fileURLToPath(new URL("./skill-install.ts", import.meta.url)),
      "utf8",
    );
    expect(implementation).not.toMatch(/node:child_process|\bspawn\s*\(|\bnpx\b/);
  });
});
