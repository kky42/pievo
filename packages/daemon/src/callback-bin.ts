/**
 * Replaying exactly how the daemon was started keeps callbacks on the same version
 * (`execPath` + `execArgv` + entry script), so the global install,
 * `node dist/cli.js`, and `tsx src/cli.ts` all resolve `pievo report …` back
 * to runCallback (execArgv carries the tsx loader in dev, so the .ts entry runs).
 */
import fs from "node:fs";
import path from "node:path";

import { PIEVO_DIR } from "./config.js";
import { reexecWrapperContents } from "./reexec-wrapper.js";

export const CALLBACK_BIN_DIR = path.join(PIEVO_DIR, "bin");

export function ensureCallbackBin(): void {
  fs.mkdirSync(CALLBACK_BIN_DIR, { recursive: true });
  fs.writeFileSync(path.join(CALLBACK_BIN_DIR, "pievo"), reexecWrapperContents(), { mode: 0o755 });
}
