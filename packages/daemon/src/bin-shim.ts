/**
 * The durable `pievo` PATH shim for source/custom launches. `pievo
 * daemon start` (and `pievo new`) write a tiny exec wrapper named `pievo` into a user
 * bin dir on PATH so subsequent calls resolve to a durable binary.
 *
 * The wrapper RE-EXECS this daemon's own launcher (execPath + execArgv + entry),
 * exactly like `callback-bin.ts` — so it stays version-consistent with whatever
 * `pievo daemon start`/`new` was invoked as (`node dist/cli.js`,
 * `tsx src/cli.ts`). Writing the shim is BEST-EFFORT: any failure degrades to the
 * source launcher and never fails daemon start.
 *
 * Because a durable on-PATH shim outlives the process that wrote it, it is hardened
 * two ways so it can never be fragile or destructive (feedback #4 follow-up):
 *   1. It ONLY lands from a DURABLE install — when the re-exec entry lives inside an
 *      npx / npm cache (`/_npx/`, `/_cacache/`), the shim would re-exec a prunable
 *      path, so we SKIP it and print one line of guidance (`npm install -g @kky42/pievo@latest`).
 *   2. It NEVER clobbers a foreign `pievo` — before writing a candidate we read any
 *      existing `pievo` there and skip it unless it is our OWN prior shim (starts
 *      with the re-exec marker); a real global npm binary is left untouched. Refreshing
 *      our own shim is idempotent.
 *
 * Every external touch (write, mkdir, read, homedir, PATH, entry) is an injectable
 * seam so tests never write into the real home dir.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The re-exec wrapper prefix that uniquely marks a `pievo` file as OUR shim (vs a
 *  real installed binary). Any existing `pievo` that doesn't start with this is
 *  foreign and must never be overwritten. */
export const SHIM_MARKER = "#!/bin/sh\nexec ";

/** Single-quote a string for safe interpolation into the /bin/sh wrapper. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Is the re-exec entry inside an ephemeral npx / npm cache (`/_npx/`, `/_cacache/`)?
 *  A shim that re-execs such a path breaks once the cache is pruned, so we refuse to
 *  write a durable shim from one. Path-separator agnostic (handles Windows too). */
export function isEphemeralEntry(entry: string): boolean {
  if (!entry) return false;
  const p = entry.replace(/\\/g, "/");
  return p.includes("/_npx/") || p.includes("/_cacache/");
}

/** The re-exec wrapper body (same shape as `callback-bin.ts`'s callback shim). */
export function shimContents(
  execPath = process.execPath,
  execArgv = process.execArgv,
  entry = process.argv[1] ?? "",
): string {
  const parts = [execPath, ...execArgv, entry].map(shQuote);
  return `#!/bin/sh\nexec ${parts.join(" ")} "$@"\n`;
}

export interface BinShimDeps {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  /** The re-exec entry (defaults to `process.argv[1]`) — checked for npx-cache staleness. */
  entry?: () => string;
  /** Read an existing `pievo` file's contents, or null when absent — used to refuse
   *  overwriting a foreign binary. */
  readShim?: (p: string) => string | null;
  /** Whether an existing bin entry resolves to this process's CLI entry. This accepts
   *  npm's normal global symlink without mistaking it for a foreign binary. */
  sameFile?: (binEntry: string, cliEntry: string) => boolean;
  /** Write the shim; throws (e.g. EACCES) → the caller falls back to ~/.local/bin. */
  writeShim?: (dir: string) => void;
  out?: (s: string) => void;
}

export interface BinShimResult {
  /** Absolute path to the installed `pievo` shim, or null if none was written. */
  path: string | null;
  /** Whether the shim's dir is on PATH (drives the one-line guidance). */
  onPath: boolean;
  /** True only when a shim was actually written this call (false on any skip/failure). */
  written: boolean;
}

/** The candidate bin dirs, most-preferred first: the npm GLOBAL bin (when running
 *  under npm/npx, `npm_config_prefix` points at the global prefix, and its `bin` is
 *  already on PATH), else the always-writable `~/.local/bin`. */
export function binDirCandidates(env: NodeJS.ProcessEnv, homedir: string): string[] {
  const dirs: string[] = [];
  const prefix = env.npm_config_prefix;
  if (prefix) dirs.push(path.join(prefix, "bin"));
  dirs.push(path.join(homedir, ".local", "bin"));
  return dirs;
}

/** Is `dir` on `PATH` (exact segment match, normalized)? */
export function dirOnPath(dir: string, pathVar: string | undefined): boolean {
  if (!pathVar) return false;
  const target = path.resolve(dir);
  return pathVar.split(path.delimiter).some((p) => p && path.resolve(p) === target);
}

/** Default writer: mkdir + write the 0755 shim into `dir`. */
function defaultWriteShim(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "pievo"), shimContents(), { mode: 0o755 });
}

/** Default reader: existing `pievo` contents, or null when absent/unreadable. */
function defaultReadShim(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** True when both paths resolve to the same installed CLI (including npm symlinks). */
function defaultSameFile(binEntry: string, cliEntry: string): boolean {
  try {
    return fs.realpathSync(binEntry) === fs.realpathSync(cliEntry);
  } catch {
    return false;
  }
}

/**
 * Write (idempotently) the `pievo` shim to the best writable bin dir and, when that
 * dir is not on PATH, print one copy-pasteable line of guidance. Best-effort and
 * hardened (see the file header): SKIPS entirely when the re-exec entry is an
 * ephemeral npx/npm cache path, and never overwrites a foreign `pievo`. Returns
 * `{path:null,onPath:false,written:false}` (announced) on any skip or total failure.
 */
export function ensureBinShim(injected: BinShimDeps = {}): BinShimResult {
  const env = injected.env ?? process.env;
  const homedir = (injected.homedir ?? os.homedir)();
  const entry = (injected.entry ?? (() => process.argv[1] ?? ""))();
  const readShim = injected.readShim ?? defaultReadShim;
  const sameFile = injected.sameFile ?? defaultSameFile;
  const writeShim = injected.writeShim ?? defaultWriteShim;
  const out = injected.out ?? ((s: string) => void process.stdout.write(s));

  // A shim re-execing an npx/npm cache path breaks once that cache is pruned; don't
  // write a durable shim from an ephemeral install — point at a global install instead.
  if (isEphemeralEntry(entry)) {
    out("pievo: skipped the PATH shim (running from an npx cache); install globally for a stable bin: npm install -g @kky42/pievo@latest\n");
    return { path: null, onPath: false, written: false };
  }

  // A direct invocation of a global npm bin normally has no npm_config_prefix. Find
  // the symlink on PATH before considering places where a source launch might need a
  // shim. Comparing real paths keeps this exact: an unrelated `pievo` remains foreign.
  const installedBin = pievoPathBin(env.PATH, (p) => sameFile(p, entry));
  if (installedBin) return { path: installedBin, onPath: true, written: false };

  for (const dir of binDirCandidates(env, homedir)) {
    const shimPath = path.join(dir, "pievo");
    // A normal global npm install already provides a symlink to this exact CLI. It is
    // the desired durable bin, not a foreign file and not something we should rewrite.
    if (sameFile(shimPath, entry)) {
      return { path: shimPath, onPath: dirOnPath(dir, env.PATH), written: false };
    }
    // Never clobber a foreign `pievo`; only refresh our OWN prior shim. A missing file
    // (null) is free to write.
    const existing = readShim(shimPath);
    if (existing !== null && !existing.startsWith(SHIM_MARKER)) continue;
    try {
      writeShim(dir);
    } catch {
      continue; // e.g. EACCES on a root-owned global bin — try the next candidate.
    }
    const onPath = dirOnPath(dir, env.PATH);
    if (!onPath) {
      out(`pievo: installed \`pievo\` to ${shimPath} — add it to your PATH: export PATH="${dir}:$PATH"\n`);
    }
    return { path: shimPath, onPath, written: true };
  }
  out("pievo: could not write a `pievo` PATH shim (install globally with `npm install -g @kky42/pievo@latest`)\n");
  return { path: null, onPath: false, written: false };
}

/** The installed shim's path (for the home view's `bin:` line) WITHOUT writing it —
 *  the first candidate that already has an executable `pievo`. Null when none. */
export function existingBinShim(injected: { env?: NodeJS.ProcessEnv; homedir?: () => string; exists?: (p: string) => boolean } = {}): string | null {
  const env = injected.env ?? process.env;
  const homedir = (injected.homedir ?? os.homedir)();
  const exists = injected.exists ?? ((p: string) => fs.existsSync(p));
  for (const dir of binDirCandidates(env, homedir)) {
    const p = path.join(dir, "pievo");
    if (exists(p)) return p;
  }
  return null;
}

/** The absolute path of a `pievo` in a DURABLE PATH directory (a real global
 *  install), or null. EPHEMERAL PATH dirs are skipped: `npx @kky42/pievo …`
 *  PREPENDS its own throwaway `…/_npx/…/.bin` onto PATH for the duration of the
 *  invocation, so a naive PATH scan would count that transient entry as durable.
 *  Filtering ephemeral dirs keeps the home view's bin path truthful. */
function pievoPathBin(pathVar: string | undefined, exists: (p: string) => boolean): string | null {
  if (!pathVar) return null;
  for (const dir of pathVar.split(path.delimiter)) {
    if (dir === "" || isEphemeralEntry(dir)) continue;
    const p = path.join(dir, "pievo");
    if (exists(p)) return p;
  }
  return null;
}

/**
 * The absolute path of a DURABLE `pievo` executable: our installed shim
 * (`existingBinShim`) else the first non-ephemeral PATH directory that holds a
 * `pievo`. Null when only a BARE, non-PATH (or ephemeral npx) `pievo` would result.
 * Drives the home view's `bin:` line (P8) — a real path when known.
 */
export function resolveDurableBinPath(injected: { env?: NodeJS.ProcessEnv; homedir?: () => string; exists?: (p: string) => boolean } = {}): string | null {
  const shim = existingBinShim(injected);
  if (shim) return shim;
  const env = injected.env ?? process.env;
  const exists = injected.exists ?? ((p: string) => fs.existsSync(p));
  return pievoPathBin(env.PATH, exists);
}
