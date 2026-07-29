import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, test } from "vitest";

import {
  bundledSkillDir,
  installArgs,
  installSkill,
  targetSkillDirs,
  type Runner,
} from "./skill-install.js";

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-skill-"));
fs.writeFileSync(path.join(fixtureDir, "SKILL.md"), "---\nname: pievo\n---\n# x\n");

afterAll(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));

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

describe("installArgs", () => {
  test("always uses user scope with a verified multi-agent invocation", () => {
    expect(installArgs("/b/skill")).toEqual([
      "--yes", "skills", "add", "/b/skill", "-a", "claude-code", "-a", "codex", "-y", "--copy", "-g",
    ]);
  });
});

describe("targetSkillDirs", () => {
  test("returns each agent's user skill dir", () => {
    expect(targetSkillDirs()).toEqual([
      "~/.claude/skills/pievo",
      "~/.agents/skills/pievo",
    ]);
  });
});

describe("installSkill", () => {
  test("success → user locations + -g passed", async () => {
    let seen: string[] = [];
    const runner: Runner = async (_cmd, args) => {
      seen = args;
      return { code: 0, stdout: "", stderr: "" };
    };
    const r = await installSkill({ dir: fixtureDir, runner });
    expect(r.ok).toBe(true);
    expect(r.line).toContain("~/.claude/skills/pievo");
    expect(r.line).toContain("~/.agents/skills/pievo");
    expect(seen).toEqual(installArgs(fixtureDir));
    expect(seen).toContain("-g");
  });

  test("bundled skill absent → skipped, never runs the command", async () => {
    let ran = false;
    const runner: Runner = async () => {
      ran = true;
      return { code: 0, stdout: "", stderr: "" };
    };
    const r = await installSkill({ dir: path.join(fixtureDir, "does-not-exist"), runner });
    expect(r.ok).toBe(false);
    expect(r.line).toMatch(/bundled skill not found/);
    expect(ran).toBe(false);
  });

  test("non-zero exit → skipped with the reason, never throws", async () => {
    const runner: Runner = async () => ({ code: 1, stdout: "", stderr: "EACCES: permission denied\nmore" });
    const r = await installSkill({ dir: fixtureDir, runner });
    expect(r.ok).toBe(false);
    expect(r.line).toContain("EACCES: permission denied");
    expect(r.line).not.toContain("more");
  });

  test("runner that throws is swallowed → skipped, never throws", async () => {
    const runner: Runner = async () => {
      throw new Error("spawn npx ENOENT");
    };
    const r = await installSkill({ dir: fixtureDir, runner });
    expect(r.ok).toBe(false);
    expect(r.line).toContain("spawn npx ENOENT");
  });
});
