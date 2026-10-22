import type { Loop } from "../db/schema.js";
import { MEMORY_CHAR_CAP, MEMORY_FILE } from "./loopFiles.js";

/** Literal placeholder the daemon replaces with the run's absolute loop-file
 *  directory before launch (and exports as an env var of the same name). */
export const LOOP_DIR_PLACEHOLDER = "$PIEVO_LOOP_DIR";

const STATUS_LINE_RE = /^STATUS:\s*(keep|no-change|block)\.?$/i;

/**
 * Deliver the user's prompt unchanged, followed by the status definitions, the
 * loop-file contract, and the final-line status contract. The run index
 * intentionally remains an internal history fact.
 */
export function buildRunTask(loop: Loop, previousNotices: string[] = []): string {
  const files = [
    `- ${MEMORY_FILE}: this loop's memory, kept across runs (max ${MEMORY_CHAR_CAP} characters). Read it before you start. Before finishing, update it with anything that would help future runs avoid mistakes or work faster. Keep it concise: merge similar notes, delete stale or wrong ones, no run logs.`,
    ...loop.artifacts.map((name) => `- ${name}: artifact shown on the Pievo dashboard (max 2 MB). Update it only as the task above asks.`),
  ];
  const notices = previousNotices.length
    ? `\n\nNotices from the previous run:\n${previousNotices.map((notice) => `- ${notice}`).join("\n")}`
    : "";
  return `${loop.prompt}

Status definitions:
- keep: ${loop.statusKeep}
- no-change: ${loop.statusNoChange}
- block: ${loop.statusBlock}

Loop files in ${LOOP_DIR_PLACEHOLDER}:
${files.join("\n")}
A file over its limit is rejected and its previous version kept. Other files in that directory are discarded.${notices}

End your final response with a short summary, then exactly one last line:
STATUS: keep|no-change|block`;
}

/**
 * Split a provider's final response into the reported status and summary. The
 * final non-empty line must be the status line; markdown emphasis or code ticks
 * around it are tolerated because models add them unprompted.
 */
export function parseFinalStatus(finalText: string | null | undefined): { status: "keep" | "no-change" | "block"; message: string } | undefined {
  if (!finalText) return undefined;
  const lines = finalText.split(/\r?\n/);
  let index = lines.length - 1;
  while (index >= 0 && lines[index]!.trim() === "") index--;
  if (index < 0) return undefined;
  const bare = lines[index]!.trim().replace(/^[*_`>\s]+|[*_`\s]+$/g, "");
  const match = STATUS_LINE_RE.exec(bare);
  if (!match) return undefined;
  const status = match[1]!.toLowerCase() as "keep" | "no-change" | "block";
  return { status, message: lines.slice(0, index).join("\n").trim() };
}
