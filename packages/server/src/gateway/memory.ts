/**
 * A loop's memory: the MEMORY.md every run reads first and may replace. It holds
 * only lessons runs learned the hard way, so later runs get faster and safer.
 *
 * The cap is part of the agent-facing prompt contract and is mirrored in the
 * daemon (`packages/daemon/src/loop-files.ts`); change both together. An
 * over-limit version is rejected and the previous one kept, never truncated,
 * because a cut memory silently loses its newest lessons.
 */
import { createHash } from "node:crypto";

export const MEMORY_FILE = "MEMORY.md";
/** Memory is re-read by every run, so it is bounded in characters (Unicode code
 *  points), roughly 2k tokens of prompt context per run. */
export const MEMORY_CHAR_CAP = 8000;

/** Why `text` cannot become the loop's memory, or undefined if it can. */
export function memoryIssue(text: string): string | undefined {
  if (text.includes("\0")) return `${MEMORY_FILE}: binary content is not allowed`;
  const chars = Array.from(text).length;
  return chars > MEMORY_CHAR_CAP ? `${MEMORY_FILE}: ${chars} characters exceeds the ${MEMORY_CHAR_CAP}-character limit` : undefined;
}

/** SHA-256 of the memory text, lowercase hex. The daemon reports the hash of the
 *  memory it started from; the server compares it with the current memory before
 *  applying a run's edit, so an owner edit made during the run wins. */
export function memoryHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
