/**
 * Post-run collection for explicitly configured artifacts.
 *
 * After a provider exits, the runner resolves each exact configured relative
 * path beneath the run workdir, builds a
 * bounded manifest, and reuses the existing sync/blob handshake so the server's
 * terminal snapshot captures those files.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { boundedFetch } from "./http.js";
import { logger } from "./logger.js";

const log = logger.child({ mod: "artifacts" });

/** The existing artifact byte cap. Larger files are represented as metadata only. */
export const BLOB_CAP = 10 * 1024 * 1024;
const SYNC_TIMEOUT_MS = 30_000;
const BLOB_PUT_TIMEOUT_MS = 120_000;
const PUT_CONCURRENCY = 4;

export type SyncFetch = (url: string, init: RequestInit, timeoutMs: number) => Promise<Response>;

export interface ArtifactManifestEntry {
  path: string;
  hash: string | null;
  size: number;
  binary: boolean;
  oversize: boolean;
}

export interface ArtifactManifest {
  entries: ArtifactManifestEntry[];
  paths: Map<string, string>;
}

type BoundedRead =
  | { kind: "bytes"; bytes: Buffer }
  | { kind: "oversize"; size: number }
  | { kind: "unreadable" };

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Match the server/viewer convention: a NUL in the first 8 KiB is binary. */
export function looksBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, 8192).includes(0);
}

function inside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

/**
 * Validate an exact artifact path at the filesystem boundary. Absolute paths,
 * empty/dot/traversal segments, and lexical or realpath (symlink) escapes are
 * rejected. Symlinks whose resolved target remains inside workdir are allowed.
 */
export async function resolveArtifactPath(workdir: string, configured: string): Promise<{ relative: string; absolute: string; size: number } | null> {
  if (typeof configured !== "string" || configured.length === 0 || configured.includes("\0")) return null;
  if (path.isAbsolute(configured) || path.win32.isAbsolute(configured)) return null;
  const segments = configured.split(/[\\/]/);
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return null;

  const lexical = path.resolve(workdir, configured);
  if (!inside(path.resolve(workdir), lexical)) return null;

  try {
    const [realRoot, realFile, stat] = await Promise.all([
      fs.promises.realpath(workdir),
      fs.promises.realpath(lexical),
      fs.promises.stat(lexical),
    ]);
    if (!inside(realRoot, realFile) || !stat.isFile()) return null;
    return { relative: configured, absolute: realFile, size: stat.size };
  } catch {
    // Missing and unreadable configured artifacts are intentionally tolerated.
    return null;
  }
}

/** Read at most one byte beyond the per-file cap. This remains bounded even when
 * a file grows after the initial stat and lets the caller classify that race as
 * oversize instead of hashing or buffering an unbounded stream. */
async function readBounded(file: string): Promise<BoundedRead> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(file, "r");
    const before = await handle.stat();
    if (!before.isFile()) return { kind: "unreadable" };
    if (before.size > BLOB_CAP) return { kind: "oversize", size: before.size };
    const bytes = Buffer.allocUnsafe(BLOB_CAP + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset > BLOB_CAP || after.size > BLOB_CAP) {
      return { kind: "oversize", size: Math.max(offset, after.size) };
    }
    return { kind: "bytes", bytes: bytes.subarray(0, offset) };
  } catch {
    return { kind: "unreadable" };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Build a manifest from only the configured exact files. No globbing, walking,
 * filename/secret/MIME filtering, or aggregate folder caps are applied. */
export async function buildArtifactManifest(workdir: string, artifacts: string[]): Promise<ArtifactManifest> {
  const entries: ArtifactManifestEntry[] = [];
  const paths = new Map<string, string>();
  const seen = new Set<string>();
  for (const configured of artifacts) {
    const resolved = await resolveArtifactPath(workdir, configured);
    if (!resolved || seen.has(resolved.relative)) continue;
    seen.add(resolved.relative);
    const read = await readBounded(resolved.absolute);
    if (read.kind === "unreadable") continue;
    if (read.kind === "oversize") {
      entries.push({ path: resolved.relative, hash: null, size: read.size, binary: false, oversize: true });
      continue;
    }
    const hash = sha256(read.bytes);
    entries.push({ path: resolved.relative, hash, size: read.bytes.length, binary: looksBinary(read.bytes), oversize: false });
    paths.set(hash, resolved.absolute);
  }
  return { entries, paths };
}

async function readVerified(file: string, hash: string): Promise<Buffer | null> {
  const read = await readBounded(file);
  return read.kind === "bytes" && sha256(read.bytes) === hash ? read.bytes : null;
}

async function forEachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  }));
}

function needHashesFrom(value: unknown, available: ReadonlyMap<string, string>): string[] | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("ok") || !keys.includes("needHashes")) return null;
  const body = value as { ok?: unknown; needHashes?: unknown };
  if (body.ok !== true || !Array.isArray(body.needHashes)) return null;
  const hashes = body.needHashes;
  if (hashes.some((hash) => typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash) || !available.has(hash))) return null;
  return new Set(hashes).size === hashes.length ? hashes as string[] : null;
}

/** Best-effort exact-artifact sync. A local read or network failure never changes
 * the provider's terminal result; the terminal report still proceeds. */
export async function syncArtifacts(options: {
  loopId: string;
  runId: string;
  workdir: string;
  artifacts: string[];
  server: string;
  token: string;
  fetchImpl?: SyncFetch;
}): Promise<void> {
  const fetchImpl = options.fetchImpl ?? boundedFetch;
  try {
    const manifest = await buildArtifactManifest(options.workdir, options.artifacts);
    const response = await fetchImpl(`${options.server}/api/machine/sync`, {
      method: "POST",
      headers: { Authorization: `Bearer ${options.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        loopId: options.loopId,
        manifest: manifest.entries,
      }),
    }, SYNC_TIMEOUT_MS);
    if (!response.ok) {
      log.warn({ loopId: options.loopId, runId: options.runId, status: response.status }, "artifact sync non-ok");
      return;
    }
    const needHashes = needHashesFrom(await response.json(), manifest.paths);
    if (!needHashes) throw new Error("invalid artifact sync response");
    await forEachLimit(needHashes, PUT_CONCURRENCY, async (hash) => {
      const file = manifest.paths.get(hash);
      const bytes = file ? await readVerified(file, hash) : null;
      if (!bytes) return;
      const put = await fetchImpl(`${options.server}/api/machine/blob/${hash}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${options.token}`, "Content-Type": "application/octet-stream" },
        body: new Uint8Array(bytes),
      }, BLOB_PUT_TIMEOUT_MS);
      if (!put.ok) log.warn({ loopId: options.loopId, runId: options.runId, hash, status: put.status }, "artifact blob upload non-ok");
    });
  } catch (err) {
    log.warn({ loopId: options.loopId, runId: options.runId, err: err instanceof Error ? err.message : String(err) }, "artifact sync failed");
  }
}
