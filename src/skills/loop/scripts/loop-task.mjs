#!/usr/bin/env node
import {
  addMs,
  appendJsonLine,
  eligibleTasks,
  failCli,
  makeId,
  parseArgs,
  parseCsv,
  parseDurationMs,
  parseNumber,
  printJson,
  reconstructTasks,
  requireLoop,
  resolveNow,
  taskCounts
} from "./_loop-lib.mjs";

function usage() {
  return `Usage:
  node scripts/loop-task.mjs add <loop-id> --brief <text> [--type work|review|fix|audit|submit|human] [--priority n] [--depends-on a,b] [--task-id id] [--owner name] [--at ISO]
  node scripts/loop-task.mjs claim <loop-id> --lane <lane> [--task-id id] [--run-id id] [--force true] [--at ISO]
  node scripts/loop-task.mjs block <loop-id> --task-id <id> --evidence <text> [--ttl 30m] [--next-action text] [--owner name] [--at ISO]
  node scripts/loop-task.mjs done <loop-id> --task-id <id> [--summary text] [--at ISO]
  node scripts/loop-task.mjs fail <loop-id> --task-id <id> [--error text] [--summary text] [--at ISO]
  node scripts/loop-task.mjs get <loop-id> --task-id <id>
  node scripts/loop-task.mjs list <loop-id> [--status pending]
`;
}

try {
  const { positionals, options } = parseArgs(process.argv.slice(2));
  const [command, loopId] = positionals;
  if (!command || !loopId) throw new Error("command and loop-id are required");
  const paths = requireLoop(loopId);
  const at = resolveNow(options);

  if (command === "add") {
    if (!options.brief) throw new Error("--brief is required");
    const taskId = options.taskId || makeId("task", at);
    const record = {
      schema_version: 1,
      event: "created",
      task_id: taskId,
      loop_id: paths.id,
      type: options.type || "work",
      status: "pending",
      brief: options.brief,
      priority: parseNumber(options.priority, 0),
      depends_on: parseCsv(options.dependsOn),
      owner: options.owner,
      at,
      created_at: at
    };
    appendJsonLine(paths.tasks, record);
    printJson(record);
  } else if (command === "claim") {
    const { tasks } = reconstructTasks(paths.id);
    const eligible = eligibleTasks(tasks);
    let candidates = eligible;
    if (options.taskId) {
      const requested = tasks.find((task) => task.task_id === options.taskId);
      if (!requested || requested.status !== "pending") {
        printJson({ status: "none", task: requested ?? null });
        process.exit(0);
      }
      const isEligible = eligible.some((task) => task.task_id === requested.task_id);
      if (!isEligible && options.force !== "true") {
        printJson({ status: "blocked", reason: "dependencies_unmet", task: requested });
        process.exit(0);
      }
      candidates = [requested];
    }
    const task = candidates[0];
    if (!task) {
      printJson({ status: "none", task: null });
      process.exit(0);
    }
    const record = {
      schema_version: 1,
      event: "claimed",
      task_id: task.task_id,
      loop_id: paths.id,
      status: "running",
      lane: options.lane,
      owner: options.owner || options.lane,
      run_id: options.runId,
      at
    };
    appendJsonLine(paths.tasks, record);
    printJson({ status: "claimed", task: { ...task, status: "running", owner: record.owner, run_id: record.run_id } });
  } else if (command === "block") {
    if (!options.taskId) throw new Error("--task-id is required");
    if (!options.evidence) throw new Error("--evidence is required");
    const ttlMs = parseDurationMs(options.ttl, 60 * 60 * 1000);
    const record = {
      schema_version: 1,
      event: "blocked",
      task_id: options.taskId,
      loop_id: paths.id,
      status: "blocked",
      owner: options.owner,
      evidence: options.evidence,
      next_action: options.nextAction,
      blocker_ttl_ms: ttlMs,
      blocked_until: addMs(at, ttlMs),
      at
    };
    appendJsonLine(paths.tasks, record);
    printJson(record);
  } else if (command === "done") {
    if (!options.taskId) throw new Error("--task-id is required");
    const record = {
      schema_version: 1,
      event: "done",
      task_id: options.taskId,
      loop_id: paths.id,
      status: "done",
      summary: options.summary,
      at
    };
    appendJsonLine(paths.tasks, record);
    printJson(record);
  } else if (command === "fail") {
    if (!options.taskId) throw new Error("--task-id is required");
    const record = {
      schema_version: 1,
      event: "failed",
      task_id: options.taskId,
      loop_id: paths.id,
      status: "failed",
      error: options.error,
      summary: options.summary,
      at
    };
    appendJsonLine(paths.tasks, record);
    printJson(record);
  } else if (command === "get") {
    if (!options.taskId) throw new Error("--task-id is required");
    const { tasks } = reconstructTasks(paths.id);
    printJson(tasks.find((task) => task.task_id === options.taskId) ?? null);
  } else if (command === "list") {
    const { tasks } = reconstructTasks(paths.id);
    const filtered = options.status ? tasks.filter((task) => task.status === options.status) : tasks;
    printJson({ counts: taskCounts(tasks), tasks: filtered });
  } else {
    throw new Error(`unknown command: ${command}`);
  }
} catch (error) {
  failCli(error, usage());
}
