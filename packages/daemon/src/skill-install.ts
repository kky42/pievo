/**
 * Best-effort local install of the bundled Pievo owner skill. The current CLI's
 * bundled copy is written directly to the two user-level skill directories, so
 * installation is offline and does not invoke a package runner or skills CLI.
 *
 * Each target is refreshed independently through a sibling staging directory.
 * The complete bundle (including SKILL.md) must reach staging before an existing
 * target is removed. Any same-named Pievo skill is deliberately overwritten: the
 * daemon and `pievo skill install` always publish the skill matching this CLI.
 * Failures never block daemon startup and can be retried with
 * `pievo skill install`.
 */
import fs from "node:fs";
import { access, cp, mkdir, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * The skill dir bundled into this package. `../skill` resolves the same from both
 * `src/` (tsx dev) and `dist/` (built) since each sits beside the package-root
 * `skill/`. The directory is committed as part of the daemon package.
 */
export function bundledSkillDir(base = moduleDir): string {
  return path.join(base, "..", "skill");
}

export function bundledSkillAvailable(dir = bundledSkillDir()): boolean {
  try {
    return fs.statSync(path.join(dir, "SKILL.md")).isFile();
  } catch {
    return false;
  }
}

export interface InstallOutcome {
  ok: boolean;
  line: string;
}

export interface InstallOpts {
  /** Injectable bundled source for tests. */
  dir?: string;
  /** Injectable home directory for tests; production always defaults to the user home. */
  home?: string;
}

/**
 * User-level skill directories refreshed by Pievo. Claude Code reads
 * `.claude/skills`; Codex and Pi read the universal `.agents/skills` directory.
 */
export const SKILL_TARGET_AGENTS: ReadonlyArray<{
  id: string;
  label: string;
  skillsRoot: readonly string[];
}> = [
  { id: "claude-code", label: "Claude Code", skillsRoot: [".claude", "skills"] },
  { id: "codex", label: "Codex", skillsRoot: [".agents", "skills"] },
];

export function targetSkillDirs(root = "~"): string[] {
  return SKILL_TARGET_AGENTS.map((t) => path.join(root, ...t.skillsRoot, "pievo"));
}

async function assertSkillFile(dir: string): Promise<void> {
  const skillFile = path.join(dir, "SKILL.md");
  await access(skillFile);
  if (!(await stat(skillFile)).isFile()) throw new Error(`${skillFile} is not a file`);
}

async function installTarget(source: string, target: string): Promise<void> {
  const parent = path.dirname(target);
  const staging = path.join(
    parent,
    `.pievo.staging-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  try {
    await mkdir(parent, { recursive: true });
    await cp(source, staging, { recursive: true });
    await assertSkillFile(staging);
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function installSkill(opts: InstallOpts = {}): Promise<InstallOutcome> {
  const source = opts.dir ?? bundledSkillDir();
  try {
    await assertSkillFile(source);
  } catch {
    return {
      ok: false,
      line: "pievo skill: skipped (bundled skill not found — run `pievo skill install` after reinstalling Pievo)",
    };
  }

  const targets = targetSkillDirs(opts.home ?? os.homedir());
  const shownTargets = targetSkillDirs();
  const results = await Promise.allSettled(targets.map((target) => installTarget(source, target)));
  const failures = results.flatMap((result, index) =>
    result.status === "rejected"
      ? [`${shownTargets[index]}: ${errorLine(result.reason)}`]
      : [],
  );

  if (failures.length === 0) {
    return { ok: true, line: `pievo skill: installed → ${shownTargets.join(", ")}` };
  }
  return {
    ok: false,
    line: `pievo skill: skipped (${failures.join("; ")}) — retry with \`pievo skill install\``,
  };
}

function errorLine(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.trim().split("\n")[0]?.trim() || "unknown error";
}
