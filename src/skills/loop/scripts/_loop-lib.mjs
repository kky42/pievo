import fs from "node:fs";
import path from "node:path";

export const SCHEMA_VERSION = 1;

export function normalizeLoopId(value) {
  const id = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!id) throw new Error("loop-id is required");
  return id;
}

export function loopPaths(loopId, cwd = process.cwd()) {
  const id = normalizeLoopId(loopId);
  const dir = path.join(cwd, ".loop", id);
  return {
    id,
    dir,
    state: path.join(dir, "state.md"),
    policy: path.join(dir, "policy.json"),
    tasks: path.join(dir, "tasks.jsonl"),
    runs: path.join(dir, "runs.jsonl"),
    metrics: path.join(dir, "metrics.jsonl"),
    incidents: path.join(dir, "incidents.jsonl"),
    artifacts: path.join(dir, "artifacts")
  };
}

export function defaultPolicy(loopId, at = new Date().toISOString()) {
  return {
    schema_version: SCHEMA_VERSION,
    loop_id: normalizeLoopId(loopId),
    created_at: at,
    thresholds: {
      stale_run_minutes: 60,
      ready_task_age_minutes: 120,
      blocker_ttl_minutes: 60,
      no_op_run_streak: 3,
      failure_streak: 3,
      true_metric_stale_hours: 24
    },
    autonomy: {
      schedule_is_clock_only: true,
      durable_state_not_session: true,
      human_review_required_for: [
        "risky actions",
        "irreversible actions",
        "externally visible actions",
        "scope expansion",
        "credential or budget changes"
      ]
    }
  };
}

export function ensureLoopInfrastructure(loopId, { cwd = process.cwd(), at } = {}) {
  const paths = loopPaths(loopId, cwd);
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.mkdirSync(paths.artifacts, { recursive: true });

  if (!fs.existsSync(paths.policy)) {
    writeJsonFile(paths.policy, defaultPolicy(paths.id, at ?? new Date().toISOString()));
  }
  for (const filePath of [paths.tasks, paths.runs, paths.metrics, paths.incidents]) {
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, "", "utf8");
  }
  return paths;
}

export function requireLoop(loopId, { cwd = process.cwd() } = {}) {
  const paths = loopPaths(loopId, cwd);
  if (!fs.existsSync(paths.dir)) {
    throw new Error(`loop '${paths.id}' is not initialized; run init-loop-state.mjs first`);
  }
  ensureLoopInfrastructure(paths.id, { cwd });
  return loopPaths(paths.id, cwd);
}

export function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function readJsonFile(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, "utf8");
  const records = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`${filePath}:${index + 1}: invalid JSONL: ${error.message}`);
    }
  }
  return records;
}

export function validateJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [{ severity: "error", type: "missing_file", file: filePath }];
  const issues = [];
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      JSON.parse(line);
    } catch (error) {
      issues.push({
        severity: "error",
        type: "invalid_jsonl",
        file: filePath,
        line: index + 1,
        error: error.message
      });
    }
  }
  return issues;
}

export function appendJsonLine(filePath, record) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

export function parseArgs(argv) {
  const positionals = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith("--")) {
      const raw = arg.slice(2);
      const equalsIndex = raw.indexOf("=");
      const rawKey = equalsIndex === -1 ? raw : raw.slice(0, equalsIndex);
      const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
      if (equalsIndex !== -1) {
        options[key] = raw.slice(equalsIndex + 1);
        continue;
      }
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        options[key] = true;
      } else {
        options[key] = next;
        index += 1;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, options };
}

export function parseBoolean(value, fallback = false) {
  if (value === undefined) return fallback;
  if (value === true || value === "true" || value === "yes" || value === "1") return true;
  if (value === false || value === "false" || value === "no" || value === "0") return false;
  throw new Error(`invalid boolean: ${value}`);
}

export function parseNumber(value, fallback = undefined) {
  if (value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`invalid number: ${value}`);
  return number;
}

export function parseCsv(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseDurationMs(value, fallbackMs) {
  if (value === undefined || value === "") return fallbackMs;
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/i);
  if (!match) throw new Error(`invalid duration: ${value}`);
  const amount = Number(match[1]);
  const unit = (match[2] || "ms").toLowerCase();
  const multiplier = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000
  }[unit];
  return amount * multiplier;
}

export function resolveNow(options = {}) {
  const raw = options.now ?? options.at ?? process.env.PIEVO_LOOP_NOW;
  const date = raw ? new Date(raw) : new Date();
  if (Number.isNaN(date.getTime())) throw new Error(`invalid timestamp: ${raw}`);
  return date.toISOString();
}

export function addMs(iso, ms) {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

export function ageMs(iso, nowIso) {
  return new Date(nowIso).getTime() - new Date(iso).getTime();
}

export function makeId(prefix, atIso = new Date().toISOString()) {
  const compact = atIso.replace(/[-:.TZ]/g, "").slice(0, 17);
  const suffix = process.hrtime.bigint().toString().slice(-6);
  return `${prefix}-${compact}-${process.pid}-${suffix}`;
}

export function loadPolicy(loopId, { cwd = process.cwd() } = {}) {
  const paths = requireLoop(loopId, { cwd });
  const policy = readJsonFile(paths.policy, defaultPolicy(paths.id));
  return { ...defaultPolicy(paths.id), ...policy, thresholds: { ...defaultPolicy(paths.id).thresholds, ...(policy.thresholds ?? {}) } };
}

function terminalRunEvent(record) {
  return record.event === "finished" || record.event === "failed" || record.status === "failed" || record.status === "cancelled";
}

export function reconstructRuns(loopId, { cwd = process.cwd() } = {}) {
  const paths = requireLoop(loopId, { cwd });
  const events = readJsonLines(paths.runs);
  const byId = new Map();
  for (const event of events) {
    if (!event.run_id) continue;
    const existing = byId.get(event.run_id) ?? { run_id: event.run_id, events: [] };
    existing.events.push(event);
    if (event.event === "started") {
      existing.loop_id = event.loop_id;
      existing.lane = event.lane;
      existing.schedule = event.schedule;
      existing.task_id = event.task_id;
      existing.started_at = event.started_at ?? event.at;
      existing.status = event.status ?? "running";
      existing.summary = event.summary ?? existing.summary;
    } else if (event.event === "heartbeat") {
      existing.last_heartbeat_at = event.at;
      existing.summary = event.summary ?? existing.summary;
    } else if (event.event === "finished") {
      existing.finished_at = event.finished_at ?? event.at;
      existing.status = event.status ?? "ok";
      existing.summary = event.summary ?? existing.summary;
      existing.next_actions = event.next_actions ?? existing.next_actions;
    } else if (event.event === "failed") {
      existing.finished_at = event.finished_at ?? event.at;
      existing.status = "failed";
      existing.error = event.error;
      existing.summary = event.summary ?? existing.summary;
    } else {
      Object.assign(existing, event);
    }
    existing.latest_event = event.event;
    existing.latest_at = event.at ?? event.finished_at ?? event.started_at ?? existing.latest_at;
    existing.terminal = existing.terminal || terminalRunEvent(event);
    byId.set(event.run_id, existing);
  }
  return { events, runs: [...byId.values()] };
}

function taskStatusForEvent(event) {
  if (event.status) return event.status;
  if (event.event === "created") return "pending";
  if (event.event === "claimed") return "running";
  if (event.event === "blocked") return "blocked";
  if (event.event === "done") return "done";
  if (event.event === "failed") return "failed";
  if (event.event === "deleted") return "deleted";
  return undefined;
}

export function reconstructTasks(loopId, { cwd = process.cwd() } = {}) {
  const paths = requireLoop(loopId, { cwd });
  const events = readJsonLines(paths.tasks);
  const byId = new Map();
  for (const event of events) {
    if (!event.task_id) continue;
    const existing = byId.get(event.task_id) ?? { task_id: event.task_id, events: [] };
    existing.events.push(event);
    if (event.event === "created") {
      existing.loop_id = event.loop_id;
      existing.type = event.type ?? "work";
      existing.brief = event.brief ?? "";
      existing.priority = event.priority ?? 0;
      existing.depends_on = event.depends_on ?? [];
      existing.owner = event.owner;
      existing.created_at = event.created_at ?? event.at;
      existing.metadata = event.metadata;
    }
    const status = taskStatusForEvent(event);
    if (status) existing.status = status;
    if (event.event === "claimed") {
      existing.owner = event.owner ?? event.lane ?? existing.owner;
      existing.claimed_at = event.at;
      existing.run_id = event.run_id ?? existing.run_id;
    }
    if (event.event === "blocked") {
      existing.blocked_at = event.at;
      existing.blocked_until = event.blocked_until;
      existing.blocker_ttl_ms = event.blocker_ttl_ms;
      existing.evidence = event.evidence;
      existing.next_action = event.next_action;
      existing.owner = event.owner ?? existing.owner;
    }
    if (event.event === "done" || event.event === "failed") {
      existing.finished_at = event.at;
      existing.summary = event.summary ?? existing.summary;
      existing.error = event.error;
    }
    existing.updated_at = event.at ?? existing.updated_at;
    existing.latest_event = event.event;
    byId.set(event.task_id, existing);
  }
  return { events, tasks: [...byId.values()] };
}

export function taskCounts(tasks) {
  const counts = {};
  for (const task of tasks) counts[task.status ?? "unknown"] = (counts[task.status ?? "unknown"] ?? 0) + 1;
  return counts;
}

export function taskIsDone(task) {
  return task?.status === "done" || task?.status === "deleted";
}

export function eligibleTasks(tasks) {
  const byId = new Map(tasks.map((task) => [task.task_id, task]));
  return tasks
    .filter((task) => task.status === "pending")
    .filter((task) => (task.depends_on ?? []).every((dependency) => taskIsDone(byId.get(dependency))))
    .sort((a, b) => (Number(b.priority ?? 0) - Number(a.priority ?? 0)) || String(a.created_at).localeCompare(String(b.created_at)));
}

export function readMetrics(loopId, { cwd = process.cwd() } = {}) {
  const paths = requireLoop(loopId, { cwd });
  return readJsonLines(paths.metrics);
}

export function summarizeMetrics(metrics) {
  const byName = new Map();
  for (const metric of metrics) {
    const key = `${metric.kind}:${metric.name}`;
    const existing = byName.get(key) ?? {
      kind: metric.kind,
      name: metric.name,
      count: 0,
      latest: null,
      best: null
    };
    existing.count += 1;
    existing.latest = metric;
    if (!existing.best) {
      existing.best = metric;
    } else {
      const higher = metric.higher_is_better !== false;
      const better = higher ? metric.value > existing.best.value : metric.value < existing.best.value;
      if (better) existing.best = metric;
    }
    byName.set(key, existing);
  }
  return [...byName.values()];
}

function makeIncident(type, severity, message, evidence, recommendedAction) {
  return {
    type,
    severity,
    message,
    evidence,
    recommended_action: recommendedAction
  };
}

export function auditLoop(loopId, { cwd = process.cwd(), now = new Date().toISOString(), policy } = {}) {
  const resolvedPolicy = policy ?? loadPolicy(loopId, { cwd });
  const thresholds = resolvedPolicy.thresholds ?? {};
  const { runs } = reconstructRuns(loopId, { cwd });
  const { tasks } = reconstructTasks(loopId, { cwd });
  const metrics = readMetrics(loopId, { cwd });
  const incidents = [];

  const staleRunMs = Number(thresholds.stale_run_minutes ?? 60) * 60 * 1000;
  for (const run of runs) {
    const terminalEvents = (run.events ?? []).filter(terminalRunEvent);
    if (terminalEvents.length > 1) {
      incidents.push(makeIncident(
        "duplicate_terminal_run",
        "warn",
        `run ${run.run_id} has ${terminalEvents.length} terminal events`,
        { run_id: run.run_id, terminal_events: terminalEvents.map((event) => ({ event: event.event, status: event.status, at: event.at })) },
        "repair_run_ledger_or_explain_duplicate_terminal"
      ));
    }
    const freshnessAt = run.last_heartbeat_at ?? run.started_at;
    if (!run.terminal && freshnessAt && ageMs(freshnessAt, now) > staleRunMs) {
      incidents.push(makeIncident(
        "stale_run",
        "warn",
        `run ${run.run_id} has no fresh heartbeat or terminal event after ${Math.round(ageMs(freshnessAt, now) / 60000)} minutes`,
        { run_id: run.run_id, lane: run.lane, schedule: run.schedule, started_at: run.started_at, last_heartbeat_at: run.last_heartbeat_at },
        "repair_or_finish_stale_run"
      ));
    }
  }

  const readyTaskMs = Number(thresholds.ready_task_age_minutes ?? 120) * 60 * 1000;
  const readyTaskIds = new Set(eligibleTasks(tasks).map((task) => task.task_id));
  for (const task of tasks) {
    if (task.status === "pending" && readyTaskIds.has(task.task_id) && task.created_at && ageMs(task.created_at, now) > readyTaskMs) {
      incidents.push(makeIncident(
        "ready_task_stale",
        "warn",
        `ready task ${task.task_id} has not been dispatched`,
        { task_id: task.task_id, type: task.type, created_at: task.created_at, priority: task.priority },
        "dispatch_or_reprioritize_task"
      ));
    }
    if (task.status === "blocked" && task.blocked_until && new Date(task.blocked_until).getTime() <= new Date(now).getTime()) {
      incidents.push(makeIncident(
        "expired_blocker",
        "warn",
        `blocked task ${task.task_id} passed its blocker TTL`,
        { task_id: task.task_id, blocked_until: task.blocked_until, evidence: task.evidence, next_action: task.next_action },
        "repair_blocker_or_requeue_task"
      ));
    }
  }

  const terminalRuns = runs
    .filter((run) => run.terminal)
    .sort((a, b) => String(a.finished_at ?? a.latest_at).localeCompare(String(b.finished_at ?? b.latest_at)));
  const noopThreshold = Number(thresholds.no_op_run_streak ?? 3);
  const failureThreshold = Number(thresholds.failure_streak ?? 3);
  const trailingNoops = countTrailing(terminalRuns, (run) => run.status === "noop");
  const trailingFailures = countTrailing(terminalRuns, (run) => run.status === "failed");
  if (noopThreshold > 0 && trailingNoops >= noopThreshold) {
    incidents.push(makeIncident(
      "noop_streak",
      "warn",
      `${trailingNoops} terminal runs in a row were no-ops`,
      { count: trailingNoops },
      "review_loop_policy_or_dispatch_strategy"
    ));
  }
  if (failureThreshold > 0 && trailingFailures >= failureThreshold) {
    incidents.push(makeIncident(
      "failure_streak",
      "warn",
      `${trailingFailures} terminal runs in a row failed`,
      { count: trailingFailures },
      "run_repair_workflow_or_escalate"
    ));
  }

  const trueMetrics = metrics.filter((metric) => metric.kind === "true").sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const trueMetricStaleMs = Number(thresholds.true_metric_stale_hours ?? 24) * 60 * 60 * 1000;
  if (trueMetrics.length === 0) {
    incidents.push(makeIncident(
      "missing_true_metric",
      "info",
      "no true metric has been recorded yet",
      {},
      "collect_or_define_true_metric"
    ));
  } else {
    const latest = trueMetrics.at(-1);
    if (latest.at && ageMs(latest.at, now) > trueMetricStaleMs) {
      incidents.push(makeIncident(
        "true_metric_stale",
        "warn",
        `latest true metric ${latest.name} is older than threshold`,
        { name: latest.name, at: latest.at, value: latest.value },
        "collect_true_metric_or_explain_gap"
      ));
    }
  }

  const severityRank = { ok: 0, info: 1, warn: 2, block: 3 };
  const maxSeverity = incidents.reduce((current, incident) => severityRank[incident.severity] > severityRank[current] ? incident.severity : current, "ok");
  const status = maxSeverity === "info" ? "ok" : maxSeverity;
  const recommended_actions = [...new Set(incidents.map((incident) => incident.recommended_action).filter(Boolean))];
  return { status, incidents, recommended_actions, task_counts: taskCounts(tasks), run_count: runs.length };
}

function countTrailing(items, predicate) {
  let count = 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (!predicate(items[index])) break;
    count += 1;
  }
  return count;
}

export function chooseNextAction(loopId, { cwd = process.cwd(), now = new Date().toISOString() } = {}) {
  const audit = auditLoop(loopId, { cwd, now });
  const { tasks } = reconstructTasks(loopId, { cwd });
  const repairTypes = new Set(["stale_run", "expired_blocker", "failure_streak", "noop_streak"]);
  if (audit.incidents.some((incident) => repairTypes.has(incident.type))) {
    return { action: "repair", reason: "loop invariant needs repair", audit };
  }
  if (tasks.some((task) => task.status === "pending" && task.type === "human")) {
    return { action: "escalate", reason: "human queue has pending items", audit };
  }
  if (eligibleTasks(tasks).length > 0) {
    return { action: "dispatch", reason: "ready tasks are available", audit };
  }
  if (audit.incidents.some((incident) => incident.type === "true_metric_stale" || incident.type === "missing_true_metric")) {
    return { action: "collect_metric", reason: "true metric should be collected or defined", audit };
  }
  return { action: "wait", reason: "no ready work or repair action", audit };
}

export function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function failCli(error, usage) {
  process.stderr.write(`${error.message}\n`);
  if (usage) process.stderr.write(`${usage}\n`);
  process.exit(1);
}
