#!/usr/bin/env node
import {
  appendJsonLine,
  auditLoop,
  failCli,
  makeId,
  parseArgs,
  printJson,
  requireLoop,
  resolveNow
} from "./_loop-lib.mjs";

function usage() {
  return "Usage: node scripts/loop-audit.mjs <loop-id> [--now ISO_TIMESTAMP] [--record true|false]\n";
}

try {
  const { positionals, options } = parseArgs(process.argv.slice(2));
  const [loopId] = positionals;
  if (!loopId) throw new Error("loop-id is required");
  const paths = requireLoop(loopId);
  const now = resolveNow({ now: options.now, at: options.at });
  const auditId = options.auditId || makeId("audit", now);
  const result = auditLoop(paths.id, { now });
  const shouldRecord = options.record !== "false";

  if (shouldRecord) {
    appendJsonLine(paths.incidents, {
      schema_version: 1,
      event: "audit",
      audit_id: auditId,
      loop_id: paths.id,
      status: result.status,
      incident_count: result.incidents.length,
      recommended_actions: result.recommended_actions,
      at: now
    });
    for (const incident of result.incidents) {
      appendJsonLine(paths.incidents, {
        schema_version: 1,
        event: "incident",
        audit_id: auditId,
        loop_id: paths.id,
        at: now,
        ...incident
      });
    }
  }

  printJson({ audit_id: auditId, loop_id: paths.id, at: now, ...result });
} catch (error) {
  failCli(error, usage());
}
