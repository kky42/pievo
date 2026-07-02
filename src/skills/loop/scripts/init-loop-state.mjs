#!/usr/bin/env node
import fs from "node:fs";

import {
  ensureLoopInfrastructure,
  failCli,
  loopPaths,
  normalizeLoopId,
  parseArgs,
  resolveNow
} from "./_loop-lib.mjs";

function usage() {
  return "Usage: node scripts/init-loop-state.mjs <loop-id> [target] [objective] [--at ISO_TIMESTAMP]\n";
}

function createStateContent({ loopId, created, target, objective }) {
  const scheduleName = `loop-${loopId}-review`;
  return `# LOOP: ${loopId}

Loop ID: ${loopId}
Status: active
Created: ${created}
Target: ${target || "TBD"}
Objective: ${objective || "TBD"}
Feedback signal: TBD
Current focus: Define the first useful scheduled step.

## Schedules
- ${scheduleName}: heartbeat, TBD, review this loop and decide the next useful action

## Workflows
- None yet.

## Harness files
- policy.json: loop thresholds and autonomy boundaries
- tasks.jsonl: durable tasks, blockers, and human-queue items
- runs.jsonl: schedule/workflow/subagent run events and heartbeats
- metrics.jsonl: true and proxy objective signals
- incidents.jsonl: audit findings and repair/escalation evidence
- artifacts/: durable outputs referenced by tasks, runs, or metrics

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
- ${created} — init: created loop state and harness files.

## Next
Next useful action: Configure schedules and narrow each scheduled task purpose.
Review: Check whether the objective, schedules, and human-review boundaries are clear.
`;
}

try {
  const { positionals, options } = parseArgs(process.argv.slice(2));
  const [rawLoopId, rawTarget = "", rawObjective = ""] = positionals;
  const loopId = normalizeLoopId(rawLoopId);
  const at = resolveNow(options);
  const created = at.slice(0, 10);
  const paths = ensureLoopInfrastructure(loopId, { at });

  if (!fs.existsSync(paths.state)) {
    fs.writeFileSync(paths.state, createStateContent({
      loopId,
      created,
      target: rawTarget,
      objective: rawObjective
    }), "utf8");
  }

  process.stdout.write(`${loopPaths(loopId).state}\n`);
} catch (error) {
  failCli(error, usage());
}
