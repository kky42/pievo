#!/usr/bin/env node
import {
  appendJsonLine,
  failCli,
  makeId,
  parseArgs,
  printJson,
  requireLoop,
  resolveNow
} from "./_loop-lib.mjs";

function usage() {
  return `Usage:
  node scripts/loop-run.mjs start <loop-id> --lane <lane> [--schedule name] [--task-id id] [--run-id id] [--summary text] [--at ISO]
  node scripts/loop-run.mjs heartbeat <loop-id> --run-id <id> [--summary text] [--at ISO]
  node scripts/loop-run.mjs finish <loop-id> --run-id <id> [--status ok|noop|cancelled] [--summary text] [--next-actions text] [--at ISO]
  node scripts/loop-run.mjs fail <loop-id> --run-id <id> [--error text] [--summary text] [--at ISO]
`;
}

try {
  const { positionals, options } = parseArgs(process.argv.slice(2));
  const [command, loopId] = positionals;
  if (!command || !loopId) throw new Error("command and loop-id are required");
  const paths = requireLoop(loopId);
  const at = resolveNow(options);

  if (command === "start") {
    const lane = options.lane;
    if (!lane) throw new Error("--lane is required");
    const runId = options.runId || makeId("run", at);
    const record = {
      schema_version: 1,
      event: "started",
      run_id: runId,
      loop_id: paths.id,
      lane,
      schedule: options.schedule,
      task_id: options.taskId,
      status: "running",
      at,
      started_at: at,
      summary: options.summary
    };
    appendJsonLine(paths.runs, record);
    printJson(record);
  } else if (command === "heartbeat") {
    if (!options.runId) throw new Error("--run-id is required");
    const record = {
      schema_version: 1,
      event: "heartbeat",
      run_id: options.runId,
      loop_id: paths.id,
      status: "running",
      at,
      summary: options.summary
    };
    appendJsonLine(paths.runs, record);
    printJson(record);
  } else if (command === "finish") {
    if (!options.runId) throw new Error("--run-id is required");
    const record = {
      schema_version: 1,
      event: "finished",
      run_id: options.runId,
      loop_id: paths.id,
      status: options.status || "ok",
      at,
      finished_at: at,
      summary: options.summary,
      next_actions: options.nextActions
    };
    appendJsonLine(paths.runs, record);
    printJson(record);
  } else if (command === "fail") {
    if (!options.runId) throw new Error("--run-id is required");
    const record = {
      schema_version: 1,
      event: "failed",
      run_id: options.runId,
      loop_id: paths.id,
      status: "failed",
      at,
      finished_at: at,
      error: options.error,
      summary: options.summary
    };
    appendJsonLine(paths.runs, record);
    printJson(record);
  } else {
    throw new Error(`unknown command: ${command}`);
  }
} catch (error) {
  failCli(error, usage());
}
