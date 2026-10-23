import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execEnv, runProcess } from "./spawn.js";
import { expandTilde } from "./loopdir.js";
import { effectiveRoots, isWithinRoots } from "./roots.js";
import { CALLBACK_BIN_DIR } from "./callback-bin.js";
import { makeTerminalCollector, type TokenUsage } from "./telemetry.js";
import { collectMemory, prepareMemory, removeRunDir } from "./loop-files.js";
import type { CodingAgent } from "./create.js";
import type { TerminalReport, TerminalResult } from "./report-outbox.js";

/** Abort reason reserved for a server-requested cancellation. Shutdown uses a
 * different reason and therefore can never be mislabeled as user cancellation. */
export const RUN_CANCEL_REASON = "pievo:run-cancel";

export interface Delivery {
  runId: string;
  runIndex: number;
  runToken: string;
  /** Read-only credential the in-run `pievo` uses to read this loop's history. */
  contextToken: string;
  loop: {
    id: string;
    name: string;
    workdir: string;
    model: string | null;
    reasoningEffort: string | null;
    agent: CodingAgent;
  };
  /** Server-configured workdir jail — may only NARROW the daemon's local env
   *  PIEVO_ROOTS jail, never widen it (see roots.effectiveRoots). */
  roots: string[];
  /** Contains the literal LOOP_DIR_PLACEHOLDER, replaced with the run directory. */
  task: string;
  /** The loop's MEMORY.md, written into the run directory. */
  memory: { text: string };
}

/** Server prompt placeholder for the run's memory directory; also exported to the provider env. */
export const LOOP_DIR_PLACEHOLDER = "$PIEVO_LOOP_DIR";

interface ReportBody {
  runId: string;
  exitCode: number | null;
  durationMs: number;
  sessionId?: string;
  usage?: TokenUsage;
  error?: string;
  finalText?: string;
  memory?: { baseHash: string; text: string };
  notices?: string[];
}

const SELF_SCHEDULING_TOOLS = "ScheduleWakeup,CronCreate,CronList,CronDelete";

export interface AgentSpawn {
  bin: string;
  args: string[];
  stdin?: string;
}

/**
 * Provider CLIs intentionally keep distinct argument surfaces. Codex flags were
 * verified against codex-cli 0.143.0; inheriting the complete allowlisted child
 * environment preserves the run-scoped callback shim through Codex's shell policy.
 * Provider JSONL stays terminal-only and is never exposed as live progress.
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
const DEFAULT_EXEC_TIMEOUT_MS = 12 * 60 * 60 * 1000;
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
  const jail = effectiveRoots(roots, d.roots);
  let workdir: string;
  try {
    workdir = resolveWorkdir(d.loop.workdir, jail);
  } catch (err) {
    return completeRun({ runId: d.runId, exitCode: null, durationMs: Date.now() - start, error: msg(err) });
  }
  let loopDir: string;
  try {
    loopDir = prepareMemory(d.runId, d.memory.text);
  } catch (err) {
    return completeRun({ runId: d.runId, exitCode: null, durationMs: Date.now() - start, error: `could not prepare loop memory: ${msg(err)}` });
  }

  // Run the selected coding agent exactly once.
  let ok = false;
  let sessionId: string | undefined;
  let error: string | undefined;
  let finalText: string | undefined;
  let usage: TokenUsage | undefined;
  let exitCode: number | null = null;
  const agent: CodingAgent = d.loop.agent;
  const agentLabel = agent === "claude-code" ? "claude" : agent;
  try {
    const env: NodeJS.ProcessEnv = {
      ...execEnv(agent),
      // Prepend the home bin dir so `pievo` resolves to our re-exec wrapper,
      // which serves only read-only commands inside a run (PIEVO_IN_RUN).
      PATH: `${CALLBACK_BIN_DIR}${path.delimiter}${process.env.PATH ?? ""}`,
      PIEVO_IN_RUN: "1",
      PIEVO_LOOP_DIR: loopDir,
      PIEVO_SERVER_URL: serverUrl,
      // Read-only and valid only while this run executes; the report token never
      // enters the agent's environment, so the agent cannot forge its own result.
      PIEVO_RUN_CONTEXT: d.contextToken,
    };
    const task = d.task.split(LOOP_DIR_PLACEHOLDER).join(loopDir);

    // Provider sessions are deliberately single-shot. Capture sessionId for
    // possible future use, but never resume or retry this run's provider process.
    const { bin, args, stdin } = buildAgentSpawn({
      agent,
      prompt: task,
      model: d.loop.model,
      reasoningEffort: d.loop.reasoningEffort,
    });

    if (canceled()) {
      removeRunDir(d.runId);
      return completeRun({ runId: d.runId, exitCode: null, durationMs: Date.now() - start, error: "canceled before provider spawn" }, "canceled");
    }
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

  // Collection happens after the provider exits and before the terminal report
  // enters the durable outbox, which then carries the memory text itself. Only a
  // provider that was actually killed mid-edit (canceled or timed out) has an
  // untrustworthy memory. A stop that arrives after a clean provider exit still
  // lets the completed run's version apply.
  const discard = error === "canceled by server request"
    ? "the run was canceled"
    : error?.includes("timed out") ? "the run timed out" : undefined;
  const collected = collectMemory(loopDir, d.memory.text, discard);
  removeRunDir(d.runId);

  return completeRun({
    runId: d.runId,
    exitCode,
    durationMs: Date.now() - start,
    sessionId,
    usage,
    error,
    // The server reads the run's status from the final response's last
    // `STATUS:` line.
    finalText,
    ...(collected.memory !== undefined ? {
      memory: {
        // Lowercase SHA-256 hex; the server recomputes it from loops.memory.
        baseHash: createHash("sha256").update(d.memory.text).digest("hex"),
        text: collected.memory,
      },
    } : {}),
    ...(collected.notices.length ? { notices: collected.notices } : {}),
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
