/**
 * Per-run artifact diff (Phase 3). Computed lazily on the SERVER at read time
 * (no stored diffs): load run N's snapshot + the previous run's snapshot and diff
 * the two path → metadata maps. For changed TEXT files we load both blobs and
 * compute a unified line diff with `diff` (jsdiff) — a pure-string library, no
 * process execution, so the server's zero-exec invariant holds. Binary/oversize
 * files emit a size-delta marker only (no inline diff).
 */
import { createTwoFilesPatch } from "diff";

import * as store from "../db/store.js";
import { getArtifactSync } from "./boot.js";
import type { SnapshotEntry, SnapshotManifest } from "../db/schema.js";
import type { RunDiffFile, RunDiffResult } from "../types.js";

/**
 * Upper bound for computing an inline unified diff. jsdiff is synchronous and
 * roughly O(N*D); on a multi-MB or minified text file it would block the
 * single-process server (which also owns the scheduler) for seconds. Above this
 * a changed text file degrades to the size-delta marker, like binary/oversize.
 */
const MAX_DIFF_BYTES = 512 * 1024;

/** A file is text-diffable only when it has stored bytes and isn't binary/oversize. */
function isText(e: SnapshotEntry | undefined): boolean {
  return !!e && !e.binary && !e.oversize && !!e.hash;
}

/** Within the inline-diff size cap (unknown size ⇒ allowed). */
function withinDiffCap(e: SnapshotEntry | undefined): boolean {
  return !!e && (e.size == null || e.size <= MAX_DIFF_BYTES);
}

/** Load one snapshot blob, or null when recorded bytes are absent. */
async function bytesOf(e: SnapshotEntry): Promise<Buffer | null> {
  if (!e.hash) return null;
  return (await (await getArtifactSync()).readBlob(e.hash)) ?? null;
}

/** Unified diff between two versions of a path (empty string ⇒ added/removed side). */
function unified(path: string, oldText: string, newText: string, maxEditLength?: number): string | undefined {
  return maxEditLength === undefined
    ? createTwoFilesPatch(path, path, oldText, newText, "previous run", "this run")
    : createTwoFilesPatch(path, path, oldText, newText, "previous run", "this run", { maxEditLength });
}

export interface RunDiffBudget {
  /** Changed paths returned and processed. Remaining paths never read blobs. */
  maxFiles: number;
  /** Cumulative old+new blob bytes admitted before any read/jsdiff work. */
  maxInputBytes: number;
  /** Cumulative unified-diff characters emitted. Zero also skips jsdiff. */
  maxDiffChars: number;
}

type Change = { path: string; current?: SnapshotEntry; previous?: SnapshotEntry };

function budgetValue(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : Number.MAX_SAFE_INTEGER;
}

function expectedInputBytes(change: Change, verifiedSizes: Map<string, number>): number | null {
  const entries = [change.previous, change.current].filter((entry): entry is SnapshotEntry => !!entry);
  const sizes = entries.map((entry) => entry.hash ? verifiedSizes.get(entry.hash) : undefined);
  if (sizes.some((size) => size === undefined)) return null;
  return sizes.reduce<number>((sum, size) => sum + size!, 0);
}

/** Compute one run's artifact diff. The default remains the web UI's complete
 * view. Budgeted callers get explicit totals and stop before blob reads/jsdiff
 * once any work limit is spent. */
export async function computeRunDiff(runId: string, budget?: RunDiffBudget): Promise<RunDiffResult> {
  const bounded = budget !== undefined;
  const limits = budget ? {
    maxFiles: budgetValue(budget.maxFiles),
    maxInputBytes: budgetValue(budget.maxInputBytes),
    maxDiffChars: budgetValue(budget.maxDiffChars),
  } : { maxFiles: Number.MAX_SAFE_INTEGER, maxInputBytes: Number.MAX_SAFE_INTEGER, maxDiffChars: Number.MAX_SAFE_INTEGER };
  const unavailable = (): RunDiffResult => bounded
    ? { hasSnapshot: false, files: [], totalFiles: 0, truncated: false, truncation: { files: false, inputBytes: false, diffChars: false }, work: { filesProcessed: 0, inputBytes: 0, emittedDiffChars: 0 } }
    : { hasSnapshot: false, files: [] };

  const run = await store.getRun(runId);
  if (!run) return unavailable();
  const snap = await store.getRunSnapshot(runId);
  // No snapshot ⇒ the run predates the feature → degrade (not an empty diff).
  if (!snap) return unavailable();

  const curr: SnapshotManifest = snap.manifest ?? {};
  const prev: SnapshotManifest = run.runIndex == null
    ? {}
    : (await store.prevRunSnapshot(run.loopId, run.runIndex))?.manifest ?? {};

  const changes: Change[] = [];
  for (const path of [...new Set([...Object.keys(curr), ...Object.keys(prev)])].sort()) {
    const current = curr[path];
    const previous = prev[path];
    if (current && previous && current.hash === previous.hash && current.oversize === previous.oversize && current.size === previous.size) continue;
    changes.push({ path, current, previous });
  }

  const selected = changes.slice(0, limits.maxFiles);
  const verifiedSizes = bounded
    ? await store.blobSizes(selected.flatMap((change) => [change.previous?.hash, change.current?.hash].filter((hash): hash is string => !!hash)))
    : new Map<string, number>();
  const files: RunDiffFile[] = [];
  let inputBytes = 0;
  let emittedDiffChars = 0;
  let inputTruncated = false;
  let diffTruncated = false;

  for (const change of selected) {
    const { path, current: c, previous: p } = change;
    let file: RunDiffFile;
    let diffable = false;
    if (c && !p) {
      const text = isText(c);
      const tooLarge = text && !withinDiffCap(c);
      file = { path, status: "added", binary: !text, tooLarge, sizeDelta: c.size ?? null };
      diffable = text && !tooLarge;
    } else if (!c && p) {
      const text = isText(p);
      const tooLarge = text && !withinDiffCap(p);
      file = { path, status: "removed", binary: !text, tooLarge, sizeDelta: p.size != null ? -p.size : null };
      diffable = text && !tooLarge;
    } else {
      const bothText = isText(c) && isText(p);
      const tooLarge = bothText && !(withinDiffCap(c) && withinDiffCap(p));
      file = { path, status: "modified", binary: !bothText, tooLarge, sizeDelta: c!.size != null && p!.size != null ? c!.size! - p!.size! : null };
      diffable = bothText && !tooLarge;
    }

    if (diffable) {
      const expectedBytes = bounded
        ? expectedInputBytes(change, verifiedSizes)
        : [p?.size ?? 0, c?.size ?? 0].reduce((sum, size) => sum + size, 0);
      if (expectedBytes == null || expectedBytes > limits.maxInputBytes - inputBytes) {
        file.diffOmitted = "input-budget";
        inputTruncated = true;
      } else if (emittedDiffChars >= limits.maxDiffChars) {
        file.diffOmitted = "diff-budget";
        diffTruncated = true;
      } else {
        const [oldBytes, newBytes] = await Promise.all([
          p ? bytesOf(p) : Promise.resolve(Buffer.alloc(0)),
          c ? bytesOf(c) : Promise.resolve(Buffer.alloc(0)),
        ]);
        inputBytes += (oldBytes?.length ?? 0) + (newBytes?.length ?? 0);
        if (oldBytes == null || newBytes == null) {
          file.binary = true; // bytes gone → can't show a diff
        } else {
          // A mismatched manifest size cannot buy extra jsdiff work.
          if (inputBytes > limits.maxInputBytes) {
            file.diffOmitted = "input-budget";
            inputTruncated = true;
          } else {
            const remaining = limits.maxDiffChars - emittedDiffChars;
            // Bound jsdiff's edit search by the output budget instead of computing an
            // arbitrarily expensive full patch only to discard almost all of it.
            const full = unified(path, oldBytes.toString("utf8"), newBytes.toString("utf8"), bounded ? remaining : undefined);
            if (full === undefined) {
              file.diffOmitted = "diff-budget";
              diffTruncated = true;
            } else {
              file.diff = full.slice(0, remaining);
              emittedDiffChars += file.diff.length;
              if (file.diff.length < full.length) {
                file.diffTruncated = true;
                file.diffTotalChars = full.length;
                diffTruncated = true;
              }
            }
          }
        }
      }
    }
    files.push(file);
  }

  if (!bounded) return { hasSnapshot: true, files };
  const truncation = { files: changes.length > selected.length, inputBytes: inputTruncated, diffChars: diffTruncated };
  return {
    hasSnapshot: true,
    files,
    totalFiles: changes.length,
    truncated: truncation.files || truncation.inputBytes || truncation.diffChars,
    truncation,
    work: { filesProcessed: selected.length, inputBytes, emittedDiffChars },
  };
}
