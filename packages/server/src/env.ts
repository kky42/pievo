import os from "node:os";
import path from "node:path";

/**
 * Server data directory: the embedded database (`pgdata/`) and the launcher's
 * pid/lock/log files. Kept apart from the
 * daemon's `~/.pievo` so a device running both never mixes their state.
 * Override with `PIEVO_DATA_DIR` (absolute; `~` is not expanded).
 */
export function dataDir(): string {
  return process.env.PIEVO_DATA_DIR?.trim() || path.join(os.homedir(), ".pievo-server");
}
