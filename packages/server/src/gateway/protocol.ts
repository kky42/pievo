import { isOutdated, isValidSemver } from "../lib/semver.js";

/**
 * Lowest daemon package version this server may safely dispatch work to.
 *
 * Keep this as a coarse package-version gate. Bump it whenever the current
 * prompt/CLI/report contract changes. Daemons that omit a version cannot claim work.
 */
export const DAEMON_PROTOCOL_VERSION = 7;
// Protocol v7: deliveries carry the loop's memory and a read-only run context
// token; the terminal report carries changed memory with the SHA-256 hash of the
// memory the run started from, and the status comes from the final response's
// `STATUS:` line. There is no loop-file transfer route and no stored memory
// version or diff.
export const MIN_DAEMON_VERSION = "6.0.0";

export function daemonNeedsUpdate(current: string | null | undefined, required = MIN_DAEMON_VERSION): boolean {
  if (!current || !isValidSemver(current) || !isValidSemver(required)) return true;
  if (current === required) return false;
  return isOutdated(current, required);
}

export function daemonUpgradeCommand(): string {
  return "npm install -g @kky42/pievo@latest && pievo daemon restart";
}
