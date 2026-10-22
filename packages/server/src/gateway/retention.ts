/**
 * Loop-file storage retention. Blob bytes are content-addressed and shared, so
 * replacing a file never frees its old blob by itself. pruneSnapshots() bounds
 * per-loop snapshot history; gcBlobs() then deletes bytes no file row and no
 * retained snapshot references. Correctness wins over aggressiveness: a leaked
 * blob is a storage cost the next pass reclaims, a deleted live blob is data loss.
 */
import { logger } from "../logger.js";
import * as store from "../db/store.js";
import { BLOB_GC_GRACE_MS, SNAPSHOT_RETENTION } from "../env.js";
import type { BlobStore } from "./blobstore.js";

const log = logger.child({ mod: "retention" });

export interface MaintainResult {
  snapshotsPruned: number;
  blobsReclaimed: number;
}

/**
 * Prune every loop's run snapshots down to the configured retention window
 * (most-recent-N). Returns the total number pruned. This is what makes an old
 * snapshot's now-unreferenced blobs collectable by gcBlobs().
 */
export async function pruneSnapshots(keep: number = SNAPSHOT_RETENTION): Promise<number> {
  let pruned = 0;
  for (const loopId of await store.loopIdsWithSnapshots()) {
    pruned += await store.pruneRunSnapshots(loopId, keep);
  }
  return pruned;
}

/**
 * Reclaim unreferenced blob bytes; returns the number collected. Safe alongside
 * owner writes and run uploads because of three guards:
 *  - grace window: blobs whose metadata row is younger than `graceMs` are skipped;
 *  - per-candidate re-check right before deletion: an indexed file-row lookup plus
 *    a snapshot-hash set rebuilt only when the snapshot count changes (a concurrent
 *    report), instead of an O(garbage x snapshots) scan;
 *  - bytes before metadata: the metadata row is dropped after the bytes even if a
 *    writer raced the delete, so blobExists() is false and that writer re-uploads.
 */
export async function gcBlobs(blobStore: BlobStore, graceMs: number = BLOB_GC_GRACE_MS): Promise<number> {
  const refs = await store.liveBlobRefs();
  const cutoff = new Date(Date.now() - graceMs).toISOString();
  const candidates = await store.blobHashesOlderThan(cutoff);
  const garbage = candidates.filter((h) => !refs.has(h));

  let snapCount = await store.countRunSnapshots();
  let snapRefs = await store.snapshotBlobRefs();

  let reclaimed = 0;
  for (const hash of garbage) {
    const count = await store.countRunSnapshots();
    if (count !== snapCount) {
      snapCount = count;
      snapRefs = await store.snapshotBlobRefs();
    }
    if ((await store.artifactFileReferencesHash(hash)) || snapRefs.has(hash)) continue;
    try {
      await blobStore.delete(hash);
      // Unconditional: if a writer re-referenced the hash during the await, dropping its
      // row makes it re-upload the bytes. The pre-delete guard is the correctness gate.
      await store.deleteBlob(hash);
      reclaimed++;
    } catch (err) {
      // A failed byte-delete leaves BOTH the bytes and the metadata row intact, so a
      // later pass simply retries — no live row ever points at deleted bytes.
      log.warn({ hash, err: err instanceof Error ? err.message : String(err) }, "gc: blob byte-delete failed");
    }
  }
  return reclaimed;
}

/**
 * One full storage-maintenance pass: prune snapshots, then GC the blobs they
 * freed (plus any already-unreferenced). Order matters — pruning first lets the
 * same pass reclaim the blobs it just unpinned. Idempotent and safe with no
 * garbage (returns zeros).
 */
export interface MaintainOptions {
  keep?: number;
  graceMs?: number;
}

export async function maintainStorage(blobStore: BlobStore, options: MaintainOptions = {}): Promise<MaintainResult> {
  const snapshotsPruned = await pruneSnapshots(options.keep);
  const blobsReclaimed = await gcBlobs(blobStore, options.graceMs);
  if (snapshotsPruned || blobsReclaimed) {
    log.info({ snapshotsPruned, blobsReclaimed }, "storage maintenance");
  }
  return { snapshotsPruned, blobsReclaimed };
}
