/**
 * `pievo skill {status,install}` — a thin verb wrapping the same best-effort
 * user-scope install path that `pievo daemon start` / `pievo new` run. It lets a
 * user refresh the skill on demand or check where it is installed.
 *
 * The install targets EVERY agent in `SKILL_TARGET_AGENTS` (Claude Code + Codex
 * today), and `status` reports each user's install location honestly.
 *
 *   pievo skill              # same as `pievo skill install`
 *   pievo skill install      # install for each known agent at user scope (~/…)
 *   pievo skill install -g   # same (accepted, redundant)
 *   pievo skill status       # report each agent's install location + bundle state
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { bundledSkillAvailable, installSkill, SKILL_TARGET_AGENTS } from "./skill-install.js";

/** The `pievo` skill dir for one agent, under a scope root. */
function skillDirFor(root: string, skillsRoot: readonly string[]): string {
  return path.join(root, ...skillsRoot, "pievo");
}

function isInstalledAt(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, "SKILL.md")).isFile();
  } catch {
    return false;
  }
}

export async function runSkill(args: string[]): Promise<number> {
  const sub = args[0] && !args[0].startsWith("-") ? args[0] : "install";
  const flags = args.filter((arg) => arg.startsWith("-"));
  const extraPositionals = args.filter((arg) => !arg.startsWith("-")).slice(1);
  const validFlags = sub === "status"
    ? flags.length === 0
    : sub === "install" && flags.every((flag) => flag === "-g" || flag === "--global");
  if (!validFlags || extraPositionals.length > 0) {
    process.stderr.write("pievo: usage: pievo skill [status|install]\n");
    return 2;
  }

  if (sub === "status") {
    process.stdout.write(`pievo skill status:\n`);
    for (const t of SKILL_TARGET_AGENTS) {
      const userDir = skillDirFor(os.homedir(), t.skillsRoot);
      process.stdout.write(`  ${t.label} user (${userDir}): ${isInstalledAt(userDir) ? "installed" : "not installed"}\n`);
    }
    process.stdout.write(`  bundled source: ${bundledSkillAvailable() ? "available" : "missing"}\n`);
    return 0;
  }

  if (sub === "install") {
    const r = await installSkill();
    process.stdout.write(r.line + "\n");
    return r.ok ? 0 : 1;
  }

  process.stderr.write("pievo: usage: pievo skill [status|install]\n");
  return 2;
}
