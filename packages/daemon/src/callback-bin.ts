/**
 * The `pievo` PATH entry that claude calls back through during a run.
 *
 * Daemon boot writes one tiny wrapper outside project workdirs. It re-executes
 * this daemon's CLI, keeping callback behavior in `callback.ts`.
 *
 * The wrapper is launch-agnostic: it replays exactly how the daemon was started
 * (`execPath` + `execArgv` + entry script), so the global install,
 * `node dist/cli.js`, and `tsx src/cli.ts` all resolve `pievo report …` back
 * to runCallback (execArgv carries the tsx loader in dev, so the .ts entry runs).
 */
import fs from "node:fs";
import path from "node:path";

import { PIEVO_DIR } from "./config.js";
import { reexecWrapperContents } from "./reexec-wrapper.js";

/** Dir prepended to a run's PATH so `pievo` resolves to our wrapper. */
export const CALLBACK_BIN_DIR = path.join(PIEVO_DIR, "bin");

/** Write (idempotently) the re-exec wrapper to `~/.pievo/bin/pievo`. */
export function ensureCallbackBin(): void {
  fs.mkdirSync(CALLBACK_BIN_DIR, { recursive: true });
  fs.writeFileSync(path.join(CALLBACK_BIN_DIR, "pievo"), reexecWrapperContents(), { mode: 0o755 });
}
