import type { Loop, RunStatus } from "../db/schema.js";
import { MEMORY_CHAR_CAP, MEMORY_FILE, fileLimitLabel } from "./loopFiles.js";

/** Literal placeholder the daemon replaces with the run's absolute loop-file
 *  directory before launch (and exports as an env var of the same name). */
export const LOOP_DIR_PLACEHOLDER = "$PIEVO_LOOP_DIR";

const STATUS_LINE_RE = /^STATUS:\s*(ok|block)\.?$/i;
const ATTENTION_LINE_RE = /^ATTENTION:\s*(.*)$/i;
/** Characters; one dashboard line. Longer reasons are clipped, not rejected,
 *  because the run has already finished when the server reads them. */
export const ATTENTION_CAP = 200;

/**
 * Deliver the user's prompt unchanged, followed by the loop-file contract and the
 * final-line status contract. The run index
 * intentionally remains an internal history fact.
 */
export function buildRunTask(loop: Loop, previousNotices: string[] = []): string {
  const files = [
    `- ${MEMORY_FILE}: this loop's long-term experience (max ${MEMORY_CHAR_CAP} characters). Read it first and follow it. Before finishing, record only lessons this run learned the hard way that make later runs faster or safer: a pitfall hit, a workaround found, an environment fact discovered. One line each; correct or delete lessons that proved wrong. Never restate the task or these instructions, and never store state, results, baselines, trends, or run logs (those go in an artifact). Most runs add nothing.`,
    ...loop.artifacts.map((name) => `- ${name}: artifact shown on the Pievo dashboard (max ${fileLimitLabel(name)}). Update it only as the task above asks.`),
  ];
  const notices = previousNotices.length
    ? `\n\nNotices from the previous run:\n${previousNotices.map((notice) => `- ${notice}`).join("\n")}`
    : "";
  return `${loop.prompt}

Loop files in ${LOOP_DIR_PLACEHOLDER}:
${files.join("\n")}
A file over its limit is rejected and its previous version kept. Other files in that directory are discarded.${notices}

Be concise in everything you write: lead with what changed or needs action; prefer tables and short lists; no filler or restated instructions.

Your final response is only: a summary of at most five short lines (no headings, no repeated tables or file contents); if the owner should look at something, one line \`ATTENTION: <reason>\`; then exactly one last line:
STATUS: ok|block
- ok: the loop keeps running on schedule. Findings and alerts are ok; flag them with ATTENTION.
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
