/**
 * Server-side reads over a loop's current files (MEMORY.md + artifacts). Pure helpers
 * (no request/session context) so they're shared by the lazy server fns
 * (`getArtifacts` / `getArtifact` in loopApi) AND the download route, and are
 * directly unit-testable against an injected blob store.
 *
 * The bytes live in the gateway's local BlobStore; here we only read them — never write — so the feature is strictly read-only and
 * the server's zero-exec invariant holds (it decodes text, never interprets it).
 */
import * as store from "../db/store.js";
import { getLoopFiles } from "./boot.js";
import { toArtifactSummary } from "./loopProjection.js";
import type { ArtifactContent, ArtifactSummary } from "../types.js";

export async function listLoopArtifacts(loopId: string): Promise<ArtifactSummary[]> {
  return (await store.listArtifacts(loopId)).map(toArtifactSummary);
}

/**
 * One file's content for inline display: decoded text for a text file, or a
 * binary/oversize marker (the UI then offers the download route). Returns an
 * error marker for an unknown/tombstoned name or a row whose blob bytes are
 * absent — never throws.
 */
export async function readLoopArtifact(loopId: string, rawPath: string): Promise<ArtifactContent> {
  const row = await store.getArtifactFile(loopId, rawPath);
  if (!row || row.deleted) return { error: "file not found" };
  // Genuinely binary or oversize → download-only marker (the UI offers the route).
  if (row.binary || row.oversize) {
    return { binary: true, size: row.size ?? null, oversize: row.oversize };
  }
  // A live text row without a hash has no bytes to decode; keep it distinct
  // from the binary/oversize marker.
  if (!row.hash) return { error: "file has no stored version" };
  const bytes = await (await getLoopFiles()).readBlob(row.hash);
  if (!bytes) return { error: "file not found" }; // blob bytes not (yet) stored
  return { text: bytes.toString("utf8") };
}

export interface ArtifactBytes {
  status: number;
  bytes?: Buffer;
  binary?: boolean;
  filename?: string;
}

/**
 * Resolve a loop file name to its stored bytes for the download route. Names are
 * matched exactly against stored rows; tombstoned/absent → 404. The bytes stream straight from the BlobStore.
 */
export async function readLoopArtifactBytes(loopId: string, rawPath: string): Promise<ArtifactBytes> {
  const row = await store.getArtifactFile(loopId, rawPath);
  if (!row || row.deleted || !row.hash) return { status: 404 };
  const bytes = await (await getLoopFiles()).readBlob(row.hash);
  if (!bytes) return { status: 404 };
  return { status: 200, bytes, binary: row.binary, filename: rawPath };
}
