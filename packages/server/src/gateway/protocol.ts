import { isOutdated, isValidSemver } from "../lib/semver.js";

/**
 * Lowest daemon package version this server may safely dispatch work to.
 *
 * Keep this as a coarse package-version gate. Bump it whenever the current
 * prompt/CLI/report contract changes. Daemons that omit a version cannot claim work.
 */
export const DAEMON_PROTOCOL_VERSION = 4;
// Protocol v4 uses keep|no-change|block reports and the prompt-runner delivery contract.
export const MIN_DAEMON_VERSION = "2.4.0";

export function daemonNeedsUpdate(current: string | null | undefined, required = MIN_DAEMON_VERSION): boolean {
  if (!current || !isValidSemver(current) || !isValidSemver(required)) return true;
  if (current === required) return false;
  return isOutdated(current, required);
}

export function daemonUpgradeCommand(): string {
  return "npm install -g @kky42/pievo@latest && pievo daemon restart";
}
