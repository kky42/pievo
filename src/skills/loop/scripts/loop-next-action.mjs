#!/usr/bin/env node
import {
  chooseNextAction,
  failCli,
  parseArgs,
  printJson,
  requireLoop,
  resolveNow
} from "./_loop-lib.mjs";

function usage() {
  return "Usage: node scripts/loop-next-action.mjs <loop-id> [--now ISO_TIMESTAMP] [--json true|false]\n";
}

try {
  const { positionals, options } = parseArgs(process.argv.slice(2));
  const [loopId] = positionals;
  if (!loopId) throw new Error("loop-id is required");
  const paths = requireLoop(loopId);
  const now = resolveNow({ now: options.now, at: options.at });
  const decision = chooseNextAction(paths.id, { now });
  if (options.json === "true") {
    printJson({ loop_id: paths.id, at: now, ...decision });
  } else {
    process.stdout.write(`${decision.action}\n`);
  }
} catch (error) {
  failCli(error, usage());
}
