import { isOutdated } from "../lib/semver.js";

/**
 * Lowest daemon package version this server may safely dispatch work to.
 *
 * Keep this as a coarse package-version gate: if a future server changes the
 * prompt/CLI/report protocol incompatibly, bump this constant to the matching
 * daemon release. Unknown versions are treated as incompatible because only
 * daemons that report a version can be known-safe for breaking protocol changes.
 */
export const DAEMON_PROTOCOL_VERSION = 3;
export const MIN_DAEMON_VERSION = "2.1.0";

export function daemonNeedsUpdate(current: string | null | undefined, required = MIN_DAEMON_VERSION): boolean {
  if (!current) return true;
  if (current === required) return false;
  return isOutdated(current, required);
}

export function daemonUpgradeCommand(): string {
  return "npm install -g @kky42/pievo@latest && pievo daemon restart";
}
