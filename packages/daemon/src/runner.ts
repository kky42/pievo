/**
 * Run one delivery on this machine: resolve the workdir, spawn the selected
 * coding agent once, collect provider telemetry, and return a terminal report.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execEnv, runProcess } from "./spawn.js";
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
  /** Stable 1-based loop history index allocated atomically at claim. */
  runIndex: number;
  runToken: string;
  role: "exec" | "evolve" | "steer";
  loop: {
    id: string;
    name: string;
    workdir: string | null;
    taskFile: string | null;
    model: string | null;
    /** Absent on older servers; unset delegates to the provider CLI default. */
    reasoningEffort?: string | null;
    allowControl: boolean;
    /** Coding agent to EXECUTE this loop with. Absent on an older server is
     *  treated as claude-code. The daemon branches spawn + credentials on this
     *  (`claude-code` | `codex`). */
    agent?: CodingAgent;
  };
  /** Server-configured workdir jail — may only NARROW the daemon's local env
   *  PIEVO_ROOTS jail, never widen it (see roots.effectiveRoots). */
  roots?: string[];
  systemPrompt: string;
  task: string;
}

export interface ReportBody {
  runId: string;
  /** Coding-agent subprocess exit code. A spawn, timeout, signal, or pre-spawn
   * failure has no numeric exit and reports null. */
  exitCode: number | null;
  durationMs: number;
  message?: string;
  sessionId?: string;
  /** Provider-normalized token usage, summed across every subprocess attempt. */
  usage?: TokenUsage;
  /** Latest content of the loop's authoritative standing-instruction file. */
  taskFileContent?: string;
  error?: string;
  finalText?: string;
}

/** Daemon-side cap on the synced task-file body. A pathological oversized Spec
 * is tailed rather than making the terminal report unbounded. */
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

// Bound coding-agent wall-clock runtime to 12 hours by default. Operators may
// override it with a positive PIEVO_EXEC_TIMEOUT_MS value; missing or invalid
// values fail safe to the default rather than allowing an unbounded child.
export const DEFAULT_EXEC_TIMEOUT_MS = 12 * 60 * 60 * 1000;
export function resolveExecTimeoutMs(value: string | undefined): number {
  const parsed = Number(value);
  return value?.trim() && Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_EXEC_TIMEOUT_MS;
}
const TIMEOUT_MS = resolveExecTimeoutMs(process.env.PIEVO_EXEC_TIMEOUT_MS);
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
  const terminalReport = (body: ReportBody, ok: boolean, forcedResult?: TerminalResult): TerminalReport => ({
    reportId: randomUUID(),
    ...body,
    result: forcedResult ?? (ok ? "success" : body.error?.includes("timed out") ? "timeout" : "failure"),
  });
  if (canceled()) return terminalReport({ runId: d.runId, exitCode: null, durationMs: 0, error: "canceled before execution" }, false, "canceled");
  // Force a final, run-tagged sync of the loop folder right before reporting so
  // the server's run snapshot (Phase 3) captures end-state even if a late write
  // slipped the watcher's debounce. Best-effort and bounded: the flush is raced
  // against a short timeout so a slow/hung server can't stall run reporting (and
  // the notification it triggers) past FLUSH_TIMEOUT_MS — the reclaim sweep + the
  // continuous watcher still converge the server's artifact state afterward.
  const completeRun = async (body: ReportBody, forcedResult?: TerminalResult, okOverride?: boolean): Promise<TerminalReport> => {
    await Promise.race([
      flushLoop(d.loop.id).catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS)),
    ]);
    return terminalReport(body, okOverride ?? body.error === undefined, forcedResult);
  };
  // The LOCAL env jail (PIEVO_ROOTS) always applies when set; server-sent
  // roots can only narrow it — a hostile server must not widen the jail.
  const jail = effectiveRoots(roots, d.roots);
  let workdir: string;
  try {
    workdir = resolveWorkdir(d.loop.workdir, d.loop.id, jail);
  } catch (err) {
    return completeRun({ runId: d.runId, exitCode: null, durationMs: Date.now() - start, error: msg(err) });
  }

  // Run the selected coding agent exactly once.
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
    const task = d.task;

    // Provider sessions are deliberately single-shot. Capture sessionId for
    // possible future use, but never resume or retry this run's provider process.
    const { bin, args } = buildAgentSpawn({
      agent,
      prompt: task,
      model: d.loop.model,
      reasoningEffort: d.loop.reasoningEffort,
      sysFile: hasSystemPrompt ? sysFile : undefined,
    });

    if (canceled()) return completeRun({ runId: d.runId, exitCode: null, durationMs: Date.now() - start, error: "canceled before provider spawn" }, "canceled");
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
    exitCode,
    durationMs: Date.now() - start,
    sessionId,
    usage,
    taskFileContent: readTaskFile(workdir, d.loop.taskFile, roots),
    error,
    // Every role sends finalText: the server only uses it as a message FALLBACK
    // when the run didn't `pievo report --message` itself, and evolve/steer are
    // notification-exempt server-side — so an evolve pass that forgets to report
    // still leaves a readable run-log line instead of a blank timeline block.
    finalText,
  }, error === "canceled by server request" ? "canceled" : undefined, ok);
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
