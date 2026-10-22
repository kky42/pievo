/** Read-only access to a loop's current files, shared by the dashboard server
 * functions and the download route. Bytes are decoded as text, never interpreted. */
import * as store from "../db/store.js";
import { getLoopFiles } from "./boot.js";
import { loopFileNames } from "../gateway/loopFiles.js";
import { toArtifactSummary } from "./loopProjection.js";
import type { ArtifactContent, ArtifactSummary } from "../types.js";

export async function listLoopArtifacts(loopId: string): Promise<ArtifactSummary[]> {
  const loop = await store.getLoop(loopId);
  if (!loop) return [];
  const rows = new Map((await store.listArtifacts(loopId)).map((row) => [row.path, row]));
  return loopFileNames(loop)
    .map((path) => {
      const row = rows.get(path);
      return row
        ? toArtifactSummary(row)
        : { path, size: 0, updatedAt: loop.updatedAt, binary: false, oversize: false };
    })
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/**
 * One file's content for inline display: decoded text for a text file, or a
 * binary/oversize marker (the UI then offers the download route). A configured
 * file with no stored version reads as empty; an unknown name is an error —
 * never throws.
 */
export async function readLoopArtifact(loopId: string, rawPath: string): Promise<ArtifactContent> {
  const loop = await store.getLoop(loopId);
  if (!loop) return { error: "file not found" };
  const row = await store.getArtifactFile(loopId, rawPath);
  if (!row || row.deleted) {
    return loopFileNames(loop).includes(rawPath) ? { text: "" } : { error: "file not found" };
  }
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
 * Resolve a loop file name to its stored bytes for the download route. A
 * configured file with no stored version serves empty bytes; an unknown name is
 * 404. The bytes stream straight from the BlobStore.
 */
export async function readLoopArtifactBytes(loopId: string, rawPath: string): Promise<ArtifactBytes> {
  const loop = await store.getLoop(loopId);
  if (!loop) return { status: 404 };
  const row = await store.getArtifactFile(loopId, rawPath);
  if (!row || row.deleted || !row.hash) {
    return loopFileNames(loop).includes(rawPath)
      ? { status: 200, bytes: Buffer.alloc(0), binary: false, filename: rawPath }
      : { status: 404 };
  }
  const bytes = await (await getLoopFiles()).readBlob(row.hash);
  if (!bytes) return { status: 404 };
  return { status: 200, bytes, binary: row.binary, filename: rawPath };
}
