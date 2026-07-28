import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { REEXEC_WRAPPER_MARKER, reexecWrapperContents } from "./reexec-wrapper.js";

/** The re-exec wrapper prefix that uniquely marks a `pievo` file as OUR shim (vs a
 *  real installed binary). Any existing `pievo` that doesn't start with this is
 *  foreign and must never be overwritten. */
export const SHIM_MARKER = REEXEC_WRAPPER_MARKER;

/** Is the re-exec entry inside an ephemeral npx / npm cache (`/_npx/`, `/_cacache/`)?
 *  A shim that re-execs such a path breaks once the cache is pruned, so we refuse to
 *  write a durable shim from one. Path-separator agnostic (handles Windows too). */
export function isEphemeralEntry(entry: string): boolean {
  if (!entry) return false;
  const p = entry.replace(/\\/g, "/");
  return p.includes("/_npx/") || p.includes("/_cacache/");
}

export const shimContents = reexecWrapperContents;

export interface BinShimDeps {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  entry?: () => string;
  readShim?: (p: string) => string | null;
  sameFile?: (binEntry: string, cliEntry: string) => boolean;
  writeShim?: (dir: string) => void;
  out?: (s: string) => void;
}

export interface BinShimResult {
  path: string | null;
  onPath: boolean;
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

export function dirOnPath(dir: string, pathVar: string | undefined): boolean {
  if (!pathVar) return false;
  const target = path.resolve(dir);
  return pathVar.split(path.delimiter).some((p) => p && path.resolve(p) === target);
}

function defaultWriteShim(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "pievo"), shimContents(), { mode: 0o755 });
}

function defaultReadShim(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function defaultSameFile(binEntry: string, cliEntry: string): boolean {
  try {
    return fs.realpathSync(binEntry) === fs.realpathSync(cliEntry);
  } catch {
    return false;
  }
}

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

export function resolveDurableBinPath(injected: { env?: NodeJS.ProcessEnv; homedir?: () => string; exists?: (p: string) => boolean } = {}): string | null {
  const shim = existingBinShim(injected);
  if (shim) return shim;
  const env = injected.env ?? process.env;
  const exists = injected.exists ?? ((p: string) => fs.existsSync(p));
  return pievoPathBin(env.PATH, exists);
}
