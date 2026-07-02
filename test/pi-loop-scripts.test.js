import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const repoRoot = path.resolve(import.meta.dirname, "..");
const scriptsDir = path.join(repoRoot, "src", "skills", "loop", "scripts");

async function runScript(cwd, scriptName, args = []) {
  const { stdout, stderr } = await execFile(process.execPath, [path.join(scriptsDir, scriptName), ...args], {
    cwd,
    env: { ...process.env, TZ: "UTC" }
  });
  assert.equal(stderr, "");
  return stdout.trim();
}

async function runJson(cwd, scriptName, args = []) {
  return JSON.parse(await runScript(cwd, scriptName, args));
}

async function makeTempProject() {
  return fs.mkdtemp(path.join(os.tmpdir(), "pievo-loop-scripts-"));
}

test("loop harness scripts provide a durable end-to-end control ledger", async () => {
  const cwd = await makeTempProject();
  try {
    await runScript(cwd, "init-loop-state.mjs", [
      "kaggle-lb",
      "Kaggle project",
      "Improve LB score per 6h",
      "--at",
      "2026-01-01T00:00:00.000Z"
    ]);

    for (const relativePath of [
      ".loop/kaggle-lb/state.md",
      ".loop/kaggle-lb/policy.json",
      ".loop/kaggle-lb/tasks.jsonl",
      ".loop/kaggle-lb/runs.jsonl",
      ".loop/kaggle-lb/metrics.jsonl",
      ".loop/kaggle-lb/incidents.jsonl"
    ]) {
      await assert.doesNotReject(fs.access(path.join(cwd, relativePath)));
    }

    await runJson(cwd, "loop-task.mjs", [
      "add",
      "kaggle-lb",
      "--task-id",
      "old-ready",
      "--type",
      "submit",
      "--brief",
      "Submit the first safe candidate package",
      "--priority",
      "10",
      "--at",
      "2026-01-01T00:00:00.000Z"
    ]);
    await runJson(cwd, "loop-task.mjs", [
      "add",
      "kaggle-lb",
      "--task-id",
      "blocked-submit",
      "--type",
      "submit",
      "--brief",
      "Submit package after clearing stale workflow lock",
      "--at",
      "2026-01-01T00:00:00.000Z"
    ]);
    await runJson(cwd, "loop-task.mjs", [
      "block",
      "kaggle-lb",
      "--task-id",
      "blocked-submit",
      "--evidence",
      "submission workflow appeared stuck",
      "--ttl",
      "30m",
      "--next-action",
      "run repair workflow",
      "--at",
      "2026-01-01T00:10:00.000Z"
    ]);
    await runJson(cwd, "loop-run.mjs", [
      "start",
      "kaggle-lb",
      "--run-id",
      "stale-run",
      "--lane",
      "manager",
      "--schedule",
      "loop-kaggle-lb-tick",
      "--summary",
      "manager tick started",
      "--at",
      "2026-01-01T00:00:00.000Z"
    ]);
    await runJson(cwd, "loop-run.mjs", [
      "start",
      "kaggle-lb",
      "--run-id",
      "alive-run",
      "--lane",
      "worker",
      "--summary",
      "long worker started",
      "--at",
      "2026-01-01T00:00:00.000Z"
    ]);
    await runJson(cwd, "loop-run.mjs", [
      "heartbeat",
      "kaggle-lb",
      "--run-id",
      "alive-run",
      "--summary",
      "still alive",
      "--at",
      "2026-01-01T02:05:00.000Z"
    ]);
    await runJson(cwd, "loop-run.mjs", [
      "start",
      "kaggle-lb",
      "--run-id",
      "finished-run",
      "--lane",
      "worker",
      "--at",
      "2026-01-01T00:00:00.000Z"
    ]);
    await runJson(cwd, "loop-run.mjs", [
      "finish",
      "kaggle-lb",
      "--run-id",
      "finished-run",
      "--summary",
      "completed",
      "--at",
      "2026-01-01T00:05:00.000Z"
    ]);
    await runJson(cwd, "loop-run.mjs", [
      "heartbeat",
      "kaggle-lb",
      "--run-id",
      "finished-run",
      "--summary",
      "stray heartbeat after finish",
      "--at",
      "2026-01-01T00:06:00.000Z"
    ]);
    await runJson(cwd, "loop-metric.mjs", [
      "add",
      "kaggle-lb",
      "--kind",
      "proxy",
      "--name",
      "local_cv",
      "--value",
      "0.812",
      "--artifact-id",
      "candidate-a",
      "--at",
      "2026-01-01T00:20:00.000Z"
    ]);
    await runJson(cwd, "loop-metric.mjs", [
      "add",
      "kaggle-lb",
      "--kind",
      "true",
      "--name",
      "lb_score",
      "--value",
      "0.799",
      "--artifact-id",
      "candidate-a",
      "--at",
      "2026-01-01T00:40:00.000Z"
    ]);

    const audit = await runJson(cwd, "loop-audit.mjs", ["kaggle-lb", "--now", "2026-01-01T02:10:00.000Z"]);
    assert.equal(audit.status, "warn");
    const incidentTypes = audit.incidents.map((incident) => incident.type);
    assert.ok(incidentTypes.includes("stale_run"));
    assert.ok(incidentTypes.includes("ready_task_stale"));
    assert.ok(incidentTypes.includes("expired_blocker"));
    assert.ok(audit.recommended_actions.includes("repair_or_finish_stale_run"));
    const staleRuns = audit.incidents
      .filter((incident) => incident.type === "stale_run")
      .map((incident) => incident.evidence.run_id);
    assert.deepEqual(staleRuns, ["stale-run"]);

    const nextAction = await runScript(cwd, "loop-next-action.mjs", ["kaggle-lb", "--now", "2026-01-01T02:10:00.000Z"]);
    assert.equal(nextAction, "repair");

    const metricSummary = await runJson(cwd, "loop-metric.mjs", ["summary", "kaggle-lb"]);
    assert.deepEqual(
      metricSummary.metrics.map((metric) => `${metric.kind}:${metric.name}`).sort(),
      ["proxy:local_cv", "true:lb_score"]
    );

    const report = await runScript(cwd, "loop-report.mjs", [
      "kaggle-lb",
      "--since",
      "3h",
      "--now",
      "2026-01-01T02:10:00.000Z"
    ]);
    assert.match(report, /Next action: repair/);
    assert.match(report, /proxy:local_cv latest=0.812/);
    assert.match(report, /true:lb_score latest=0.799/);
    assert.match(report, /warn:stale_run/);

    const doctor = await runJson(cwd, "loop-doctor.mjs", ["kaggle-lb"]);
    assert.equal(doctor.ok, true);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("loop doctor can repair missing harness infrastructure", async () => {
  const cwd = await makeTempProject();
  try {
    const doctor = await runJson(cwd, "loop-doctor.mjs", ["missing-loop", "--fix=true"]);
    assert.equal(doctor.ok, true);
    assert.ok(doctor.fixes.some((fix) => fix.type === "created_loop_infrastructure"));
    await assert.doesNotReject(fs.access(path.join(cwd, ".loop/missing-loop/policy.json")));
    await assert.doesNotReject(fs.access(path.join(cwd, ".loop/missing-loop/runs.jsonl")));
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("loop tasks are fresh-start work items with durable dependencies", async () => {
  const cwd = await makeTempProject();
  try {
    await runScript(cwd, "init-loop-state.mjs", ["repo-health", "Repo", "Keep CI green"]);
    await runJson(cwd, "loop-task.mjs", [
      "add",
      "repo-health",
      "--task-id",
      "fix-ci",
      "--brief",
      "Fix the failing CI test",
      "--priority",
      "1",
      "--at",
      "2026-01-01T00:00:00.000Z"
    ]);
    await runJson(cwd, "loop-task.mjs", [
      "add",
      "repo-health",
      "--task-id",
      "review-ci",
      "--brief",
      "Review the fix after CI passes",
      "--priority",
      "10",
      "--depends-on",
      "fix-ci",
      "--at",
      "2026-01-01T00:01:00.000Z"
    ]);

    const blockedClaim = await runJson(cwd, "loop-task.mjs", [
      "claim",
      "repo-health",
      "--lane",
      "reviewer",
      "--task-id",
      "review-ci"
    ]);
    assert.equal(blockedClaim.status, "blocked");
    assert.equal(blockedClaim.reason, "dependencies_unmet");

    const firstClaim = await runJson(cwd, "loop-task.mjs", ["claim", "repo-health", "--lane", "worker"]);
    assert.equal(firstClaim.status, "claimed");
    assert.equal(firstClaim.task.task_id, "fix-ci");

    await runJson(cwd, "loop-task.mjs", ["done", "repo-health", "--task-id", "fix-ci", "--summary", "CI fixed"]);
    const secondClaim = await runJson(cwd, "loop-task.mjs", ["claim", "repo-health", "--lane", "reviewer"]);
    assert.equal(secondClaim.status, "claimed");
    assert.equal(secondClaim.task.task_id, "review-ci");
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
