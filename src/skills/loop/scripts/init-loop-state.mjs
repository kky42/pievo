#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function usage() {
  return "Usage: node scripts/init-loop-state.mjs <loop-id> [target] [objective]\n";
}

function normalizeLoopId(value) {
  const id = String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!id) throw new Error("loop-id is required");
  return id;
}

const [, , rawLoopId, rawTarget = "", rawObjective = ""] = process.argv;

try {
  const loopId = normalizeLoopId(rawLoopId);
  const dir = path.join(process.cwd(), ".loop", loopId);
  const statePath = path.join(dir, "state.md");
  fs.mkdirSync(dir, { recursive: true });

  if (fs.existsSync(statePath)) {
    process.stdout.write(`${statePath} already exists\n`);
    process.exit(0);
  }

  const created = new Date().toISOString().slice(0, 10);
  const scheduleName = `loop-${loopId}-review`;
  const content = `# LOOP: ${loopId}

Loop ID: ${loopId}
Status: active
Created: ${created}
Target: ${rawTarget || "TBD"}
Objective: ${rawObjective || "TBD"}
Feedback signal: TBD
Current focus: Define the first useful scheduled step.

## Schedules
- ${scheduleName}: heartbeat, TBD, review this loop and decide the next useful action

## Workflows
- None yet.

## Rules
Allowed actions:
- Report findings and update this state file.

Human review needed when:
- The action is risky, irreversible, externally visible, or expands scope.

## Working State
Backlog:
- Define initial backlog.

In progress:
- None.

Done / learned:
- Loop state initialized.

## Human Queue
- None.

## Recent Runs
- ${created} — init: created loop state.

## Next
Next useful action: Configure schedules and narrow each scheduled task purpose.
Review: Check whether the objective, schedules, and human-review boundaries are clear.
`;

  fs.writeFileSync(statePath, content, "utf8");
  process.stdout.write(`${statePath}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n${usage()}`);
  process.exit(1);
}
