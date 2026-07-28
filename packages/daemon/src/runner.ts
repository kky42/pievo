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
import { syncArtifacts } from "./artifacts.js";
import type { CodingAgent } from "./create.js";
import type { TerminalReport, TerminalResult } from "./report-outbox.js";

/** Abort reason reserved for a server-requested cancellation. Shutdown uses a
 * different reason and therefore can never be mislabeled as user cancellation. */
export const RUN_CANCEL_REASON = "pievo:run-cancel";

export interface Delivery {
  runId: string;
  runIndex: number;
  runToken: string;
  loop: {
    id: string;
    name: string;
    workdir: string;
    model: string | null;
    /** Null delegates to the provider CLI default. */
    reasoningEffort: string | null;
    /** Coding agent to execute this loop with. */
    agent: CodingAgent;
  };
  /** Server-configured workdir jail — may only NARROW the daemon's local env
   *  PIEVO_ROOTS jail, never widen it (see roots.effectiveRoots). */
  roots: string[];
  /** Server-composed user prompt plus the complete status/report contract. */
  task: string;
  /** Exact paths relative to workdir; no glob support. */
  artifacts: string[];
}

export interface ReportBody {
  runId: string;
  /** Coding-agent subprocess exit code. A spawn, timeout, signal, or pre-spawn
   * failure has no numeric exit and reports null. */
  exitCode: number | null;
  durationMs: number;
  sessionId?: string;
  /** Provider-normalized token usage, summed across every subprocess attempt. */
  usage?: TokenUsage;
  error?: string;
  finalText?: string;
}

const SELF_SCHEDULING_TOOLS = "ScheduleWakeup,CronCreate,CronList,CronDelete";

/** The spawn command (executable + argv) for one coding-agent pass. */
export interface AgentSpawn {
  bin: string;
  args: string[];
  /** Exact provider stdin, used only by agents whose CLI accepts the task there. */
  stdin?: string;
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
 *   - `pi`: print-mode JSONL with normal Pi session persistence; task text is stdin.
 *
 * Escape hatches: `PIEVO_CLAUDE_BIN` / `PIEVO_CODEX_BIN` / `PIEVO_PI_BIN`.
 *
 * Each arm's JSONL is consumed by its provider-specific terminal collector;
 * neither provider emits tool/text live progress through the daemon protocol.
 */
export function buildAgentSpawn(opts: {
  agent: CodingAgent;
  prompt: string;
  model?: string | null;
  reasoningEffort?: string | null;
}): AgentSpawn {
  const { agent, prompt, model, reasoningEffort } = opts;
  if (agent === "pi") {
    return {
      bin: process.env.PIEVO_PI_BIN || "pi",
      args: [
        "-p", "--mode", "json", "--approve",
        ...(model ? ["--model", model] : []),
        ...(reasoningEffort ? ["--thinking", reasoningEffort] : []),
      ],
      stdin: prompt,
    };
  }
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
  if (agent === "claude-code") {
    const modelArgs = model ? ["--model", model] : [];
    const reasoningArgs = reasoningEffort ? ["--effort", reasoningEffort] : [];
    return {
      bin: process.env.PIEVO_CLAUDE_BIN || "claude",
      args: [
        "-p", prompt,
        "--output-format", "stream-json",
        "--verbose",
        "--permission-mode", "bypassPermissions",
        "--disallowed-tools", SELF_SCHEDULING_TOOLS,
        ...modelArgs,
        ...reasoningArgs,
      ],
    };
  }
  throw new Error(`unsupported coding agent: ${String(agent)}`);
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
export async function executeDelivery(
  d: Delivery,
  serverUrl: string,
  roots: string[],
  signal?: AbortSignal,
  deviceToken?: string,
): Promise<TerminalReport> {
  const start = Date.now();
  const canceled = () => signal?.aborted && signal.reason === RUN_CANCEL_REASON;
  const terminalReport = (body: ReportBody, ok: boolean, forcedResult?: TerminalResult): TerminalReport => ({
    reportId: randomUUID(),
    ...body,
    result: forcedResult ?? (ok ? "success" : body.error?.includes("timed out") ? "timeout" : "failure"),
  });
  if (canceled()) return terminalReport({ runId: d.runId, exitCode: null, durationMs: 0, error: "canceled before execution" }, false, "canceled");
  const completeRun = (body: ReportBody, forcedResult?: TerminalResult, okOverride?: boolean): TerminalReport =>
    terminalReport(body, okOverride ?? body.error === undefined, forcedResult);
  // The LOCAL env jail (PIEVO_ROOTS) always applies when set; server-sent
  // roots can only narrow it — a hostile server must not widen the jail.
  const jail = effectiveRoots(roots, d.roots);
  let workdir: string;
  try {
    workdir = resolveWorkdir(d.loop.workdir, jail);
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
  // Spawn + credential set branch on the explicitly configured agent.
  const agent: CodingAgent = d.loop.agent;
  const agentLabel = agent === "claude-code" ? "claude" : agent;
  try {
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
    const { bin, args, stdin } = buildAgentSpawn({
      agent,
      prompt: task,
      model: d.loop.model,
      reasoningEffort: d.loop.reasoningEffort,
    });

    if (canceled()) return completeRun({ runId: d.runId, exitCode: null, durationMs: Date.now() - start, error: "canceled before provider spawn" }, "canceled");
    const collector = makeTerminalCollector(agent);
    const r = await runProcess(bin, args, { cwd: workdir, env, timeoutMs: TIMEOUT_MS, onStdout: collector.feed, signal, stdin });
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
  }

  // Collection happens only after the provider exits and before the terminal
  // report enters the durable outbox, so the server snapshots the exact files.
  if (deviceToken) {
    await syncArtifacts({
      loopId: d.loop.id,
      runId: d.runId,
      workdir,
      artifacts: d.artifacts,
      server: serverUrl,
      token: deviceToken,
    });
  }

  return completeRun({
    runId: d.runId,
    exitCode,
    durationMs: Date.now() - start,
    sessionId,
    usage,
    error,
    // Preserve the provider's final response independently from the required
    // `pievo report --message`. History detail exposes both without treating the
    // free-form final response as a successful protocol report.
    finalText,
  }, error === "canceled by server request" ? "canceled" : undefined, ok);
}

function resolveWorkdir(workdir: string, roots: string[]): string {
  const expanded = expandTilde(workdir);
  if (!path.isAbsolute(expanded)) throw new Error(`workdir must be absolute: ${workdir}`);
  const abs = path.resolve(expanded);
  if (roots.length && !isWithinRoots(abs, roots)) {
    throw new Error(`workdir ${abs} is outside this machine's allowed roots`);
  }
  fs.mkdirSync(abs, { recursive: true });
  return abs;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
