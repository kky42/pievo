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

/** Dir prepended to a run's PATH so `pievo` resolves to our wrapper. */
export const CALLBACK_BIN_DIR = path.join(PIEVO_DIR, "bin");

/** Single-quote a string for safe interpolation into the /bin/sh wrapper. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Write (idempotently) the re-exec wrapper to `~/.pievo/bin/pievo`. */
export function ensureCallbackBin(): void {
  const parts = [process.execPath, ...process.execArgv, process.argv[1] ?? ""].map(shQuote);
  const wrapper = `#!/bin/sh\nexec ${parts.join(" ")} "$@"\n`;
  fs.mkdirSync(CALLBACK_BIN_DIR, { recursive: true });
  fs.writeFileSync(path.join(CALLBACK_BIN_DIR, "pievo"), wrapper, { mode: 0o755 });
}
