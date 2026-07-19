/**
 * In-flight run progress registry. The runner pushes a slim current-activity
 * signal per running claude process; the poll loop snapshots it onto its next
 * heartbeat so the server (and dashboard) shows "what's it doing" live. This is
 * deliberately NOT the transcript — one line + a step counter, overwritten as the
 * run advances and dropped when it finishes.
 */
export interface RunProgress {
  step: number;
  label: string;
}

const live = new Map<string, RunProgress>();

export function setProgress(runId: string, p: RunProgress): void {
  live.set(runId, p);
}

export function clearProgress(runId: string): void {
  live.delete(runId);
}

/** Current progress for every in-flight run — sent on each poll heartbeat. */
export function snapshotProgress(): Array<{ runId: string } & RunProgress> {
  return [...live.entries()].map(([runId, p]) => ({ runId, ...p }));
}
