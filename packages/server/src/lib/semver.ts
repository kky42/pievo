/**
 * Tiny semver comparison — just enough to decide "is the daemon older than the
 * latest published version?" for the web's update hint. No dependency; we only
 * need numeric-core ordering (major.minor.patch), and a pre-release is treated
 * as older than its release (a "0.9.0-rc.1" daemon is still behind "0.9.0").
 */

/** Strict SemVer validation for security/protocol gates. Unlike the update-hint
 * comparison below, this accepts no whitespace, `v` prefix, partial core, or
 * trailing garbage. */
export function isValidSemver(value: string): boolean {
  const plus = value.split("+");
  if (plus.length > 2) return false;
  const [versionAndPre, build] = plus;
  if (build !== undefined && !validIdentifiers(build, false)) return false;
  const dash = versionAndPre!.indexOf("-");
  const numeric = dash < 0 ? versionAndPre! : versionAndPre!.slice(0, dash);
  const pre = dash < 0 ? undefined : versionAndPre!.slice(dash + 1);
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(numeric)) return false;
  return pre === undefined || validIdentifiers(pre, true);
}

function validIdentifiers(value: string, rejectNumericLeadingZero: boolean): boolean {
  if (!value) return false;
  return value.split(".").every((identifier) => {
    if (!/^[0-9A-Za-z-]+$/.test(identifier)) return false;
    return !rejectNumericLeadingZero || !/^\d+$/.test(identifier) || identifier === "0" || !identifier.startsWith("0");
  });
}

function core(v: string): [number, number, number] | null {
  const m = /^\s*v?(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function isPre(v: string): boolean {
  return /^\s*v?\d+\.\d+\.\d+-/.test(v);
}

/**
 * `true` when `current` is strictly older than `latest`. Returns `false` on any
 * unparseable/equal/newer input — the hint is opt-in, so we only ever show it
 * when we can be confident the daemon is genuinely behind.
 */
export function isOutdated(current: string | null | undefined, latest: string | null | undefined): boolean {
  if (!current || !latest) return false;
  const a = core(current);
  const b = core(latest);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    if (ai < bi) return true;
    if (ai > bi) return false;
  }
  return isPre(current) && !isPre(latest);
}
