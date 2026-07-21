/**
 * Run one delivery on this machine. First the workflow gate (if the loop has
 * one): a pure workflow that returns a message → report it DIRECTLY, no claude
 * (this is how zero-LLM loops work — e.g. a sensor → digest). Only if the
 * workflow escalates via `agent()` (or the loop has no workflow) do we run
 * claude-code. Finally report the run back to the server.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execEnv, runProcess } from "./spawn.js";
import { runWorkflow, type AgentCall } from "./workflow.js";
import { expandTilde } from "./loopdir.js";
import { effectiveRoots, isWithinRoots } from "./roots.js";
import { CALLBACK_BIN_DIR } from "./callback-bin.js";
import { makeTerminalCollector, type TokenUsage } from "./telemetry.js";
import { flushLoop, markRunActive, markRunDone } from "./watcher.js";
import { PIEVO_DIR } from "./config.js";
import type { CodingAgent } from "./create.js";
import type { TerminalReport, TerminalResult } from "./report-outbox.js";

/** Abort reason reserved for a server-requested cancellation. Shutdown uses a
 * different reason and therefore can never be mislabeled as user cancellation. */
export const RUN_CANCEL_REASON = "pievo:run-cancel";

export interface Delivery {
  runId: string;
  runToken: string;
  role: "exec" | "evolve" | "edit";
  loop: {
    id: string;
    name: string;
    workdir: string | null;
    taskFile: string | null;
    workflow: string | null;
    model: string | null;
    /** Absent on older servers; unset delegates to the provider CLI default. */
    reasoningEffort?: string | null;
    allowControl: boolean;
    /** Coding agent to EXECUTE this loop with. Absent on an older server is
     *  treated as claude-code. The daemon branches spawn + credentials on this
     *  (`claude-code` | `codex`). */
    agent?: CodingAgent;
  };
  prevState: unknown;
  /** Server-configured workdir jail — may only NARROW the daemon's local env
   *  PIEVO_ROOTS jail, never widen it (see roots.effectiveRoots). */
  roots?: string[];
  systemPrompt: string;
  task: string;
}

export interface ReportBody {
  runId: string;
  ok: boolean;
  /** Coding-agent subprocess exit code. Workflow-only success is 0; a spawn,
   * timeout, signal, or pre-spawn failure has no numeric exit and reports null. */
  exitCode: number | null;
  durationMs: number;
  outcome?: "direct" | "silent" | "exec" | "evolve";
  message?: string;
  /** Workflow cursor (free-form) to persist as loop.state for next run's `prev`. */
  cursor?: unknown;
  sessionId?: string;
  /** Provider-normalized token usage, summed across every subprocess attempt. */
  usage?: TokenUsage;
  /** Latest content of the loop's task file (the durable context+log doc). */
  taskFileContent?: string;
  error?: string;
  finalText?: string;
}

/** Daemon-side cap on the synced task-file body — it's a growing log doc, so a
 *  huge one is tailed (recent entries are what the detail view is for). */
const TASKFILE_CAP = 256 * 1024;

const SELF_SCHEDULING_TOOLS = "ScheduleWakeup,CronCreate,CronList,CronDelete";

/** The spawn command (executable + argv) for one coding-agent pass. */
export interface AgentSpawn {
  bin: string;
  args: string[];
}

/**
 * Build the coding-agent spawn command (bin + argv) for one run pass.
 *
 * Two arms (BYOA — each agent's real CLI surface):
 *   - `claude-code`: `claude -p … --output-format stream-json --verbose …`
 *   - `codex`: a DIFFERENT surface — `codex exec`, not `-p`.
 *     Flags verified against codex-cli 0.143.0: `--json` (JSONL on stdout),
 *     `--dangerously-bypass-approvals-and-sandbox` (unattended BYOA), optional
 *     `-m` / `--model`, `--skip-git-repo-check` so non-git loop workdirs are not
 *     rejected, and full child-env inheritance so the run-scoped `pievo` callback
 *     shim at the front of PATH survives Codex's shell environment policy.
 *
 * Escape hatches: `PIEVO_CLAUDE_BIN` / `PIEVO_CODEX_BIN`.
 *
 * Each arm's JSONL is consumed by its provider-specific terminal collector;
 * neither provider emits tool/text live progress through the daemon protocol.
 */
export function buildAgentSpawn(opts: {
  agent: CodingAgent;
  prompt: string;
  model?: string | null;
  reasoningEffort?: string | null;
  /** claude-only: the system-prompt file path (falsy ⇒ flag omitted). */
  sysFile?: string;
}): AgentSpawn {
  const { agent, prompt, model, reasoningEffort, sysFile } = opts;
  if (agent === "codex") {
    // Codex surface is `codex exec [OPTIONS] [PROMPT]` — never Claude's
    // `-p` / stream-json flags and never a session resume.
    const modelArgs = model ? ["-m", model] : [];
    const reasoningArgs = reasoningEffort ? ["-c", `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`] : [];
    const unattended = [
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "-c", "shell_environment_policy.inherit=all",
      ...modelArgs,
      ...reasoningArgs,
    ];
    return {
      bin: process.env.PIEVO_CODEX_BIN || "codex",
      args: ["exec", ...unattended, prompt],
    };
  }
  const modelArgs = model ? ["--model", model] : [];
  const reasoningArgs = reasoningEffort ? ["--effort", reasoningEffort] : [];
  return {
    bin: process.env.PIEVO_CLAUDE_BIN || "claude",
    args: [
      "-p", prompt,
      "--output-format", "stream-json",
      "--verbose",
      "--permission-mode", "bypassPermissions",
      ...(sysFile ? ["--append-system-prompt-file", sysFile] : []),
      "--disallowed-tools", SELF_SCHEDULING_TOOLS,
      ...modelArgs,
      ...reasoningArgs,
    ],
  };
}

// The coding-agent child runs with NO wall-clock timeout by default — a real run
// can legitimately take a long time, and the server's inactivity-based sweep is the
// guard against a machine that disappears. `PIEVO_EXEC_TIMEOUT_MS` is an opt-in
// override: a positive number arms the timer; unset/0/invalid/negative ⇒ unlimited
// (runProcess treats a falsy/≤0 timeoutMs as "no timeout").
const rawExecTimeout = Number(process.env.PIEVO_EXEC_TIMEOUT_MS);
const TIMEOUT_MS = Number.isFinite(rawExecTimeout) && rawExecTimeout > 0 ? rawExecTimeout : 0;
/** Hard cap on the pre-report flush so a slow/hung server can't delay reporting. */
const FLUSH_TIMEOUT_MS = 2500;

export async function executeDelivery(d: Delivery, serverUrl: string, roots: string[], signal?: AbortSignal): Promise<TerminalReport> {
  markRunActive(d.loop.id, d.runId);
  try {
    return await executeDeliveryImpl(d, serverUrl, roots, signal);
  } finally {
    markRunDone(d.loop.id);
  }
}

/** Temporary source compatibility for embedders; reporting is intentionally no
 * longer performed here. */
export const runDelivery = executeDelivery;

async function executeDeliveryImpl(d: Delivery, serverUrl: string, roots: string[], signal?: AbortSignal): Promise<TerminalReport> {
  const start = Date.now();
  const canceled = () => signal?.aborted && signal.reason === RUN_CANCEL_REASON;
  const finish = (body: ReportBody, forcedResult?: TerminalResult): TerminalReport => ({
    reportId: randomUUID(),
    ...body,
    result: forcedResult ?? (body.ok ? "success" : body.error?.includes("timed out") ? "timeout" : "failure"),
  });
  if (canceled()) return finish({ runId: d.runId, ok: false, exitCode: null, durationMs: 0, error: "canceled before execution" }, "canceled");
  // Force a final, run-tagged sync of the loop folder right before reporting so
  // the server's run snapshot (Phase 3) captures end-state even if a late write
  // slipped the watcher's debounce. Best-effort and bounded: the flush is raced
  // against a short timeout so a slow/hung server can't stall run reporting (and
  // the notification it triggers) past FLUSH_TIMEOUT_MS — the reclaim sweep + the
  // continuous watcher still converge the server's artifact state afterward.
  const completeRun = async (body: ReportBody, forcedResult?: TerminalResult): Promise<TerminalReport> => {
    await Promise.race([
      flushLoop(d.loop.id).catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS)),
    ]);
    return finish(body, forcedResult);
  };
  // The LOCAL env jail (PIEVO_ROOTS) always applies when set; server-sent
  // roots can only narrow it — a hostile server must not widen the jail.
  const jail = effectiveRoots(roots, d.roots);
  let workdir: string;
  try {
    workdir = resolveWorkdir(d.loop.workdir, d.loop.id, jail);
  } catch (err) {
    return completeRun({ runId: d.runId, ok: false, exitCode: null, durationMs: Date.now() - start, error: msg(err) });
  }

  // 1. Workflow gate (cheap, zero-LLM). Pure result → report directly, no agent.
  // Internal evolution passes skip this gate (they run the loop's coding agent
  // directly) and may update ui/schema/workflow.
  let cursor: unknown;
  let escalation = "";
  let workflowFailure: { error: string; source: string } | undefined;
  if (d.role === "exec" && d.loop.workflow) {
    const wf = await runWorkflow(d.loop.workflow, d.prevState, workdir, signal);
    if (wf.aborted && canceled()) return completeRun({ runId: d.runId, ok: false, exitCode: null, durationMs: Date.now() - start, error: "canceled during workflow" }, "canceled");
    if (!wf.ok) {
      // A failed workflow (thrown JS, a failed tools.call, a timeout) no longer just
      // reports a failed run. Instead we FALL BACK to the agent: it first completes
      // this run's original task (the loop still delivers this tick), then diagnoses
      // the workflow failure. Don't advance the cursor — the workflow produced none.
      const tail = wf.stderr.trim().slice(-1200);
      const err = wf.error ?? "workflow failed";
      workflowFailure = {
        error: tail ? `${err}\n${tail}` : err,
        source: d.loop.workflow,
      };
      // fall through to the claude section below (task is augmented for the fallback).
    } else {
      cursor = wf.result!.state;
      if (wf.result!.agentCalls.length === 0) {
        // Pure workflow: direct message (or silent). No claude — but still sync
        // the task file if the loop maintains one (the workflow may write it).
        return completeRun({
          runId: d.runId, ok: true, exitCode: 0, durationMs: Date.now() - start,
          outcome: wf.result!.message ? "direct" : "silent",
          message: wf.result!.message, cursor,
          taskFileContent: readTaskFile(workdir, d.loop.taskFile, roots),
        });
      }
      // Escalation: fold the workflow's signals into claude's task.
      escalation = foldEscalation(wf.result!.agentCalls);
    }
  }

  // 2. Exec: run claude (no workflow, the workflow escalated, or it FAILED → fallback).
  let ok = false;
  let sessionId: string | undefined;
  let error: string | undefined;
  let finalText: string | undefined;
  let usage: TokenUsage | undefined;
  let exitCode: number | null = null;
  // System prompt goes in ~/.pievo/runs (passed to claude by absolute path), not
  // the workdir — keeps the run's cwd clean. Removed in `finally`. Batches 1-2 move
  // the full run instructions into the first user turn, so `systemPrompt` is now empty
  // on a current server: skip the sys file + the claude-only `--append-system-prompt-file`
  // flag entirely (an OLD server still populates it and keeps working — the flag path
  // is preserved when the string is non-empty).
  const runsDir = path.join(PIEVO_DIR, "runs");
  const hasSystemPrompt = d.systemPrompt.trim().length > 0;
  const sysFile = hasSystemPrompt ? path.join(runsDir, `sys-${d.runId}.md`) : "";
  // Which coding agent executes this loop. Absent on an older server defaults to
  // claude-code. Spawn + credential set branch on the agent; agentLabel names the
  // binary family in failure reasons (claude / codex).
  const agent: CodingAgent = d.loop.agent ?? "claude-code";
  const agentLabel = agent === "claude-code" ? "claude" : agent;
  try {
    if (hasSystemPrompt) {
      fs.mkdirSync(runsDir, { recursive: true });
      fs.writeFileSync(sysFile, d.systemPrompt, "utf8");
    }

    const env: NodeJS.ProcessEnv = {
      ...execEnv(agent),
      // Prepend the home bin dir so `pievo` resolves to our re-exec wrapper.
      PATH: `${CALLBACK_BIN_DIR}${path.delimiter}${process.env.PATH ?? ""}`,
      PIEVO_RUN_TOKEN: d.runToken,
      PIEVO_SERVER_URL: serverUrl,
    };
    const task = workflowFailure
      ? buildWorkflowFallbackTask(d.task, workflowFailure, dateStamp(), d.loop.name, d.loop.id)
      : escalation
        ? `${d.task}\n\nworkflow signal:\n${escalation}`
        : d.task;

    // Provider sessions are deliberately single-shot. Capture sessionId for
    // possible future use, but never resume or retry this run's provider process.
    const { bin, args } = buildAgentSpawn({
      agent,
      prompt: task,
      model: d.loop.model,
      reasoningEffort: d.loop.reasoningEffort,
      sysFile: hasSystemPrompt ? sysFile : undefined,
    });

    if (canceled()) return completeRun({ runId: d.runId, ok: false, exitCode: null, durationMs: Date.now() - start, error: "canceled before provider spawn" }, "canceled");
    const collector = makeTerminalCollector(agent);
    const r = await runProcess(bin, args, { cwd: workdir, env, timeoutMs: TIMEOUT_MS, onStdout: collector.feed, signal });
    const final = collector.result();
    exitCode = r.code;
    finalText = final.finalText?.trim() || undefined;
    sessionId = final.sessionId;
    usage = final.usage;

    if (r.timedOut) {
      error = `${agentLabel} timed out (${Math.round(TIMEOUT_MS / 1000)}s)`;
    } else if (r.aborted && canceled()) {
      // A provider wrapper may trap SIGTERM and exit 143 with `signal=null`.
      // `runProcess.aborted` records that our run-scoped signal initiated
      // termination before settlement, which is the proof cancellation caused it.
      error = "canceled by server request";
    } else {
      ok = !final.isError && r.code === 0;
      if (!ok) {
        // A non-zero exit can arrive with a provider success terminal event;
        // in that case the process exit is the useful failure, not "success".
        error =
          final.errorType && final.errorType !== "success"
            ? final.errorType
            : r.code !== 0
              ? `${agentLabel} exited with code ${r.code}`
              : `${agentLabel} reported an error`;
        if (!final.errorType && r.code !== 0) {
          error = (r.stderr || r.stdout || error).trim().slice(0, 500);
        }
      }
    }
  } catch (err) {
    error = `failed to run ${agentLabel}: ${msg(err)}`;
  } finally {
    if (sysFile) fs.rmSync(sysFile, { force: true }); // don't let prompt files accumulate
  }

  return completeRun({
    runId: d.runId,
    ok,
    exitCode,
    durationMs: Date.now() - start,
    outcome: d.role === "evolve" ? "evolve" : "exec",
    sessionId,
    usage,
    taskFileContent: readTaskFile(workdir, d.loop.taskFile, roots),
    error,
    // Every role sends finalText: the server only uses it as a message FALLBACK
    // when the run didn't `pievo report --message` itself, and evolve/edit are
    // notification-exempt server-side — so an evolve pass that forgets to report
    // still leaves a readable run-log line instead of a blank timeline block.
    finalText,
    cursor,
  }, error === "canceled by server request" ? "canceled" : undefined);
}

/** UTC date stamp (YYYY-MM-DD) for the dated workflow-setup file name. */
export function dateStamp(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Build the fallback task handed to claude when a loop's deterministic workflow FAILS.
 * The agent must (1) still complete this run's original task so the loop delivers this
 * tick, then (2) diagnose the workflow failure. If the fix needs the USER to change
 * permissions / env / MCP auth, the agent writes a dated `workflow-setup-<date>.md` in
 * the loop's workdir and surfaces a one-line copy-paste fix prompt in its report.
 *
 * Pure + exported so it's unit-testable: the fallback task must carry the original task,
 * the workflow error, and the workflow source.
 */
export function buildWorkflowFallbackTask(
  originalTask: string,
  failure: { error: string; source: string },
  dateStr: string,
  loopName: string,
  loopId = "",
): string {
  const slug = loopName || "this-loop";
  const setupFile = `workflow-setup-${dateStr}.md`;
  // A SyntaxError is a DETERMINISTIC parse failure: the workflow never runs, fails
  // identically every tick, and an exec run has NO verb to fix it (set-workflow is
  // evolve/edit-only). So it must escalate to the owner, not quietly wait for evolve.
  const isSyntaxError = /SyntaxError/.test(failure.error);
  const editCmd = loopId
    ? `pievo edit ${loopId} --workflow-file <corrected.js>`
    : `pievo edit <loop-id> --workflow-file <corrected.js>`;
  const closing = isSyntaxError
    ? [
        "This is a SYNTAX ERROR: the workflow fails to parse, so it never runs and will",
        "fail IDENTICALLY on every future tick until the workflow is rewritten or cleared.",
        "You (an exec run) have NO command to change the workflow — `set-workflow` is an",
        "evolve/edit-only verb — so do NOT try to fix it yourself and do NOT just note it",
        "for the next evolve pass (the loop would keep failing every tick until then).",
        "Treat it as a user-fix case: write the setup file above with the concrete syntax",
        "problem and a corrected workflow body (remember: a workflow is a plain script body",
        "run inside an async function — NOT an ES module, NOT the Claude Code Workflow tool;",
        "no top-level `export`/`import`, e.g. no `export const meta = {…}`). Then surface ONE",
        "copy-paste owner prompt to apply it from their machine, e.g.:",
        "",
        `    ${editCmd}`,
        "",
        "or, if the workflow isn't worth keeping, clear it (`pievo edit <loop-id> --json",
        `'{"workflow":""}'`,
        ").",
      ]
    : [
        "If instead the workflow just has a plain bug you could fix deterministically (a wrong",
        "tool name, a bad filter), note it briefly for the next evolve pass — don't bother the",
        "user with a fix that doesn't need them.",
      ];
  return [
    originalTask,
    "",
    "---",
    "IMPORTANT — workflow fallback. This loop has a cheap deterministic pre-stage (its",
    "workflow) that runs before you. This tick the workflow FAILED, so it fell back to you.",
    "Do TWO things, in order:",
    "",
    "1. First, complete THIS run's original task above, exactly as you normally would, so",
    "   the loop still delivers its result this tick. Do not let the workflow failure stop",
    "   you from doing the real work.",
    "",
    "2. Then diagnose why the workflow failed, using the error and source below.",
    "",
    "Workflow error:",
    "```",
    failure.error,
    "```",
    "",
    "Workflow source:",
    "```js",
    failure.source,
    "```",
    "",
    `If fixing the workflow needs the USER to change something you cannot (authorize an MCP`,
    `server, set an env var / credential, grant a permission, install a runtime), do NOT try`,
    `to do it yourself. Instead write a dated setup file \`${setupFile}\` in this loop's`,
    `working directory that explains, concretely, exactly what the user must do to fix it.`,
    `Then, in your report to the user, include ONE short copy-paste prompt they can paste`,
    `into Claude Code or Codex to resolve it, e.g.:`,
    "",
    `    fix workflow issue in pievo/${slug}/${setupFile}`,
    "",
    "Note: the workflow subprocess runs with an ALLOWLISTED env — it does not inherit the",
    "user's shell. If the failure is a missing credential that the MCP server config reads",
    "from the environment (a `${VAR}` / `$env:VAR` placeholder, or a stdio server's env),",
    "the fix is to name that key in `PIEVO_WORKFLOW_ENV` (comma-separated env key names",
    "passed through to the workflow) in the daemon's environment and restart the daemon —",
    "say so concretely in the setup file.",
    "",
    ...closing,
  ].join("\n");
}

/** Per-call cap on the JSON-folded `agent()` data. The whole task travels to
 *  claude via `-p` argv, and the OS argv limit (E2BIG, ≈256KB on macOS) would
 *  kill the run outright — so a runaway tools.call result is clipped instead. */
const ESCALATION_JSON_CAP = 64 * 1024;

/** Fold the workflow's agent() escalation calls into claude's task text.
 *  Pure + exported for tests: each call's data JSON is capped (see above) with
 *  an explicit truncation marker so the agent knows the payload was clipped. */
export function foldEscalation(calls: AgentCall[]): string {
  return calls
    .map((c) => {
      let dataBlock = "";
      if (c.data !== undefined) {
        let json = JSON.stringify(c.data, null, 2);
        if (json.length > ESCALATION_JSON_CAP) {
          json = json.slice(0, ESCALATION_JSON_CAP) + `\n… [truncated — agent() data exceeded ${Math.round(ESCALATION_JSON_CAP / 1024)}KB; the task travels via argv]`;
        }
        dataBlock = "data:\n```json\n" + json + "\n```";
      }
      return [c.message, dataBlock].filter(Boolean).join("\n");
    })
    .join("\n\n");
}

/** Best-effort read of the loop's task file for sync to the server. The path may
 *  be absolute, ~-rooted, or relative to the run's workdir. Never throws — a
 *  missing/unreadable file just syncs nothing (the report must still go out).
 *  taskFile is SERVER-SENT: under a local PIEVO_ROOTS jail a path outside both
 *  the (already-jailed) workdir and the local roots is never read. */
function readTaskFile(workdir: string, taskFile: string | null, localRoots: string[]): string | undefined {
  if (!taskFile) return undefined;
  try {
    const expanded = expandTilde(taskFile);
    // resolve() handles both cases (an absolute path is normalized, a relative
    // one is anchored to the workdir) — unresolved `..` segments must never
    // survive into the lexical jail check below. The (already-jailed, absolute)
    // workdir joins the allowed roots so an in-workdir task file always reads.
    const file = path.resolve(workdir, expanded);
    if (localRoots.length && !isWithinRoots(file, [workdir, ...localRoots])) return undefined;
    const raw = fs.readFileSync(file, "utf8");
    if (raw.length <= TASKFILE_CAP) return raw;
    return `… (truncated — last ${Math.round(TASKFILE_CAP / 1024)}KB of ${Math.round(raw.length / 1024)}KB)\n\n` + raw.slice(-TASKFILE_CAP);
  } catch {
    return undefined;
  }
}

function resolveWorkdir(workdir: string | null, loopId: string, roots: string[]): string {
  if (!workdir) {
    const scratch = path.join(PIEVO_DIR, "work", loopId);
    fs.mkdirSync(scratch, { recursive: true });
    return scratch;
  }
  const abs = path.resolve(expandTilde(workdir));
  if (roots.length && !isWithinRoots(abs, roots)) {
    throw new Error(`workdir ${abs} is outside this machine's allowed roots`);
  }
  fs.mkdirSync(abs, { recursive: true });
  return abs;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
