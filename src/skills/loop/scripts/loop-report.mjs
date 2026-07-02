#!/usr/bin/env node
import {
  auditLoop,
  chooseNextAction,
  failCli,
  parseArgs,
  parseDurationMs,
  readJsonLines,
  readMetrics,
  reconstructRuns,
  reconstructTasks,
  requireLoop,
  resolveNow,
  summarizeMetrics,
  taskCounts
} from "./_loop-lib.mjs";

function usage() {
  return "Usage: node scripts/loop-report.mjs <loop-id> [--since 24h] [--now ISO_TIMESTAMP]\n";
}

function withinSince(record, sinceMs, now) {
  const at = record.at ?? record.latest_at ?? record.finished_at ?? record.started_at ?? record.created_at;
  if (!at) return false;
  return new Date(now).getTime() - new Date(at).getTime() <= sinceMs;
}

try {
  const { positionals, options } = parseArgs(process.argv.slice(2));
  const [loopId] = positionals;
  if (!loopId) throw new Error("loop-id is required");
  const paths = requireLoop(loopId);
  const now = resolveNow({ now: options.now, at: options.at });
  const sinceMs = parseDurationMs(options.since, 24 * 60 * 60 * 1000);
  const { runs } = reconstructRuns(paths.id);
  const { tasks } = reconstructTasks(paths.id);
  const metrics = readMetrics(paths.id);
  const incidents = readJsonLines(paths.incidents).filter((record) => withinSince(record, sinceMs, now));
  const recentRuns = runs.filter((run) => withinSince(run, sinceMs, now));
  const metricSummary = summarizeMetrics(metrics);
  const audit = auditLoop(paths.id, { now });
  const decision = chooseNextAction(paths.id, { now });
  const terminalRuns = recentRuns.filter((run) => run.terminal);
  const failedRuns = terminalRuns.filter((run) => run.status === "failed").length;
  const noopRuns = terminalRuns.filter((run) => run.status === "noop").length;

  const lines = [];
  lines.push(`# LOOP report: ${paths.id}`);
  lines.push("");
  lines.push(`Window: last ${options.since || "24h"}`);
  lines.push(`Generated: ${now}`);
  lines.push(`Next action: ${decision.action} — ${decision.reason}`);
  lines.push("");
  lines.push("## Runs");
  lines.push(`- recent runs: ${recentRuns.length}`);
  lines.push(`- terminal: ${terminalRuns.length}`);
  lines.push(`- failed: ${failedRuns}`);
  lines.push(`- no-op: ${noopRuns}`);
  lines.push("");
  lines.push("## Tasks");
  const counts = taskCounts(tasks);
  if (Object.keys(counts).length === 0) lines.push("- none");
  for (const [status, count] of Object.entries(counts)) lines.push(`- ${status}: ${count}`);
  lines.push("");
  lines.push("## Metrics");
  if (metricSummary.length === 0) lines.push("- none recorded");
  for (const metric of metricSummary) {
    lines.push(`- ${metric.kind}:${metric.name} latest=${metric.latest.value} at=${metric.latest.at} best=${metric.best.value}`);
  }
  lines.push("");
  lines.push("## Audit");
  lines.push(`- status: ${audit.status}`);
  lines.push(`- incidents: ${audit.incidents.length}`);
  for (const incident of audit.incidents.slice(0, 10)) {
    lines.push(`  - ${incident.severity}:${incident.type} — ${incident.message}`);
  }
  lines.push("");
  lines.push("## Recorded incidents in window");
  lines.push(`- records: ${incidents.length}`);
  process.stdout.write(`${lines.join("\n")}\n`);
} catch (error) {
  failCli(error, usage());
}
