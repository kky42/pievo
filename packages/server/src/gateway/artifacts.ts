/** Server-side artifact-sync helpers: path safety, byte caps, and hashing. */
import { createHash } from "node:crypto";

/** Per-file byte cap. At or under ⇒ bytes sync; over ⇒ metadata-only (no bytes). */
export const BLOB_CAP = 10 * 1024 * 1024; // 10MB
/** Hard ceiling on the exact-manifest sync POST body. */
export const SYNC_BODY_CAP = 32 * 1024 * 1024; // 32MB

export type ArtifactManifestEntry =
  | { path: string; hash: string; size: number; binary: boolean; oversize: false }
  | { path: string; hash: null; size: number; binary: boolean; oversize: true };

export interface ArtifactSyncBody {
  loopId: string;
  manifest: ArtifactManifestEntry[];
}

const SYNC_FIELDS = new Set(["loopId", "manifest"]);
const MANIFEST_FIELDS = new Set(["path", "hash", "size", "binary", "oversize"]);
const MAX_STORED_SIZE = 2_147_483_647; // PostgreSQL integer upper bound

function exactRecord(value: unknown, fields: ReadonlySet<string>): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  const keys = Object.keys(value);
  return keys.length === fields.size && keys.every((key) => fields.has(key));
}

export function sha256Buf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A 64-char lowercase hex sha256. */
export function isValidHash(hash: unknown): hash is string {
  return typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash);
}

/**
 * Validate and preserve an untrusted, loop-folder-relative literal path. Returns
 * null if it is absolute, contains an empty/dot/traversal segment, is empty, or
 * carries a NUL (no real filesystem produces one, and Postgres rejects it).
 */
export function safeRelPath(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.includes("\u0000")) return null;
  if (raw.startsWith("/") || raw.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(raw)) return null;
  const parts = raw.split(/[\\/]/);
  if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
  return raw;
}

/** Parse the one canonical sync envelope without coercion or omitted-field defaults. */
export function parseArtifactSyncBody(value: unknown): ArtifactSyncBody | null {
  if (!exactRecord(value, SYNC_FIELDS)) return null;
  const { loopId, manifest } = value;
  if (
    typeof loopId !== "string"
    || loopId.length === 0
    || loopId.length > 200
    || loopId.includes("\u0000")
    || !Array.isArray(manifest)
  ) return null;

  const entries: ArtifactManifestEntry[] = [];
  const paths = new Set<string>();
  for (const raw of manifest) {
    if (!exactRecord(raw, MANIFEST_FIELDS)) return null;
    const { path, hash, size, binary, oversize } = raw;
    const rel = safeRelPath(path);
    if (
      rel === null
      || paths.has(rel)
      || typeof size !== "number"
      || !Number.isSafeInteger(size)
      || size < 0
      || size > MAX_STORED_SIZE
      || typeof binary !== "boolean"
      || typeof oversize !== "boolean"
    ) return null;

    if (oversize) {
      if (size <= BLOB_CAP || hash !== null) return null;
      entries.push({ path: rel, hash: null, size, binary, oversize: true });
    } else {
      if (size > BLOB_CAP || !isValidHash(hash)) return null;
      entries.push({ path: rel, hash, size, binary, oversize: false });
    }
    paths.add(rel);
  }
  return { loopId, manifest: entries };
}
