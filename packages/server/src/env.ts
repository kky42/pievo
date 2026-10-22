import os from "node:os";
import path from "node:path";

/**
 * Server data directory: the embedded database (`pgdata/`), artifact bytes
 * (`blobs/`), and the launcher's pid/lock/log files. Kept apart from the
 * daemon's `~/.pievo` so a device running both never mixes their state.
 * Override with `PIEVO_DATA_DIR` (absolute; `~` is not expanded).
 */
export function dataDir(): string {
  return process.env.PIEVO_DATA_DIR?.trim() || path.join(os.homedir(), ".pievo-server");
}

/**
 * Run snapshots kept per loop. The per-run diff needs only the prior snapshot;
 * 20 keeps ample "Changes" history while letting older blobs become collectable.
 */
export const SNAPSHOT_RETENTION = 20;

/**
 * A blob whose metadata row is younger than this is never collected, so a
 * sync that just wrote a blob can still reference it. A leaked blob is only a
 * storage cost that the next pass reclaims. 1 hour.
 */
export const BLOB_GC_GRACE_MS = 60 * 60 * 1000;

/** Storage-maintenance cadence (prune snapshots, then GC blobs). 15 minutes. */
export const GC_INTERVAL_MS = 15 * 60 * 1000;
