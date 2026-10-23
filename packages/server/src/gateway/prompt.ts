import type { Loop, Run, RunStatus } from "../db/schema.js";
import { MEMORY_CHAR_CAP, MEMORY_FILE } from "./memory.js";

/** Literal placeholder the daemon replaces with the run's absolute loop-file
 *  directory before launch (and exports as an env var of the same name). */
export const LOOP_DIR_PLACEHOLDER = "$PIEVO_LOOP_DIR";

const STATUS_LINE_RE = /^STATUS:\s*(ok|block)\.?$/i;
const ATTENTION_LINE_RE = /^ATTENTION:\s*(.*)$/i;
/** Characters; one dashboard line. Longer reasons are clipped, not rejected,
 *  because the run has already finished when the server reads them. */
export const ATTENTION_CAP = 200;
/** A failed previous run's error is echoed only as a hint; 300 characters
 *  keeps a stack trace from dominating the prompt. */
const PREVIOUS_ERROR_CAP = 300;

export interface RunContext {
  runIndex: number;
  now: string;
  previous?: Pick<Run, "runIndex" | "ts" | "phase" | "status" | "attention" | "message" | "error" | "notices">;
}

function scheduleText(loop: Loop): string {
  return loop.scheduleMode === "continuous"
    ? `continuous, ${loop.continuousDelayMinutes} min after each run`
    : `cron \`${loop.cron}\` (${loop.timezone ?? "UTC"})`;
}

function previousText(previous: RunContext["previous"]): string {
  if (!previous) return "Previous run: none, this is the first run.";
  const outcome = previous.phase === "done" ? previous.status : previous.phase;
  const attention = previous.phase === "done" && previous.status === "ok" ? previous.attention : null;
  const lines = [`Previous run: #${previous.runIndex} at ${previous.ts}, ${outcome}${attention ? `, attention: ${attention}` : ""}.`];
  if (previous.message) lines.push(`Previous summary:\n${previous.message.split("\n").map((line) => `> ${line}`).join("\n")}`);
  if (previous.phase === "error" && previous.error) {
    lines.push(`Previous error: ${previous.error.length > PREVIOUS_ERROR_CAP ? `${previous.error.slice(0, PREVIOUS_ERROR_CAP - 1)}…` : previous.error}`);
  }
  for (const notice of previous.notices ?? []) lines.push(`Notice: ${notice}`);
  return lines.join("\n");
}

/**
 * The run header (time, index, previous outcome), the owner's prompt unchanged,
 * then Pievo's contract: memory, history access, attention, and the final-line
 * status. Times are UTC ISO so the agent can pass them to `pievo log --since`.
 */
export function buildRunTask(loop: Loop, context: RunContext): string {
  return `Pievo run #${context.runIndex} of loop "${loop.name}" (${scheduleText(loop)}).
Now: ${context.now}.
${previousText(context.previous)}

${loop.prompt}

---
Pievo contract:
- Memory: ${LOOP_DIR_PLACEHOLDER}/${MEMORY_FILE} (max ${MEMORY_CHAR_CAP} characters). Read it first and follow it. Before finishing, record only lessons this run learned the hard way that make later runs faster or safer: a pitfall hit, a workaround found, an environment fact discovered. One line each; correct or delete lessons that proved wrong. Never restate the task or these instructions, and never store results, state, or run logs there. Most runs add nothing. A version over the limit is rejected and the previous one kept.
- State: keep task state the next run needs (items already seen, baselines, best scores) in files in your working directory, or in your summary, which the next run receives.
- History: \`pievo log\` lists this loop's recent runs (time, status, attention, summary, tokens); \`pievo log --since <ISO>\` or \`--run <index>\` narrows it; \`pievo show\` prints the loop's config and run counts. They are read-only. The previous run above is usually enough.

Your final response is only: a summary of at most five short lines (what you did and found, plus any fact the next run needs to tell what is new; no headings or tables); if the run is ok and the owner should look, one line \`ATTENTION: <reason>\`; then exactly one last line:
STATUS: ok|block
- ATTENTION marks an ok run worth the owner's time: a metric improved or a new best, or something new or changed in what you watch. Routine work is not attention: a digest or crawl that ran as usual, a check that found nothing new, a run that just produced this period's data. When unsure, leave it out. Never add attention when you block; the pause already tells the owner.
- ok: the loop keeps running on schedule.
- block: the loop must stop until the owner acts, because the task says to stop or the next run cannot proceed safely (missing access, broken environment, unsafe next step). Block pauses the loop.`;
}

const bareLine = (line: string): string => line.trim().replace(/^[*_`>\s]+|[*_`\s]+$/g, "");

/**
 * Split a provider's final response into the reported status, an optional
 * attention reason from the ATTENTION lines just above it, and the summary. The final
 * non-empty line must be the status line; markdown emphasis or code ticks around
 * either line are tolerated because models add them unprompted.
 */
export function parseFinalStatus(finalText: string | null | undefined): { status: RunStatus; message: string; attention: string | null } | undefined {
  if (!finalText) return undefined;
  const lines = finalText.split(/\r?\n/);
  let index = lines.length - 1;
  while (index >= 0 && lines[index]!.trim() === "") index--;
  if (index < 0) return undefined;
  const match = STATUS_LINE_RE.exec(bareLine(lines[index]!));
  if (!match) return undefined;
  const status = match[1]!.toLowerCase() as RunStatus;
  // Models sometimes emit one ATTENTION line per finding; consecutive lines merge.
  const reasons: string[] = [];
  let end = index;
  for (;;) {
    let previous = end;
    while (previous > 0 && lines[previous - 1]!.trim() === "") previous--;
    const attentionMatch = previous > 0 ? ATTENTION_LINE_RE.exec(bareLine(lines[previous - 1]!)) : null;
    if (!attentionMatch) break;
    end = previous - 1;
    const reason = attentionMatch[1]!.trim();
    if (reason && !/^(none|n\/a|-)$/i.test(reason)) reasons.unshift(reason);
  }
  const joined = reasons.join("; ");
  const attention = joined ? (joined.length > ATTENTION_CAP ? `${joined.slice(0, ATTENTION_CAP - 1)}…` : joined) : null;
  return { status, message: lines.slice(0, end).join("\n").trim(), attention };
}
