/**
 * Artifact sync - the byte-ingress half of the machine gateway, split out of
 * `MachineGateway` (which keeps poll/report/CLI/retention). Same wire surface,
 * framework-agnostic like the rest of the gateway (`{ status, body }` results):
 *
 *   POST /api/machine/sync        (Bearer device token) → manifest reconcile
 *   PUT  /api/machine/blob/:hash  (Bearer device token) → negotiated blob upload
 *
 * plus `readBlob` (the download seam the artifact/diff readers resolve bytes
 * through). Boot constructs ONE BlobStore and hands the SAME instance to this
 * class and to `MachineGateway` (whose `maintainStorage` GC deletes the bytes
 * written here).
 */
import { logger } from "../logger.js";
import * as store from "../db/store.js";
import { createBlobStore, type BlobStore } from "./blobstore.js";
import { BLOB_CAP, isValidHash, parseArtifactSyncBody, sha256Buf } from "./artifacts.js";
import { authenticateDeviceToken } from "./deviceAuth.js";
import type { HttpResult } from "./http.js";

// Same `mod` tag as the rest of the gateway - these log lines predate the split.
const log = logger.child({ mod: "gateway" });
const BLOB_PRESENCE_CONCURRENCY = 16;

async function mapConcurrent<T>(items: T[], limit: number, visit: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await visit(item);
    }
  }));
}

export class ArtifactSync {
  constructor(
    /** Artifact bytes (local filesystem by default, R2 when configured; injectable in tests). */
    private readonly blobStore: BlobStore = createBlobStore(),
  ) {}

  // ---- POST /api/machine/sync ----

  /**
   * Reconcile one complete configured-path manifest after a run. Missing hashes
   * are returned for upload through the raw blob PUT endpoint.
   */
  async sync(deviceToken: string, rawBody: unknown): Promise<HttpResult> {
    const auth = await authenticateDeviceToken(deviceToken);
    if (!auth.ok) return auth.response;
    const { machineId } = auth;

    const body = parseArtifactSyncBody(rawBody);
    if (!body) return { status: 400, body: { error: "invalid sync body" } };
    const { loopId, manifest } = body;
    const loop = await store.getLoop(loopId);
    if (!loop || loop.machineId !== machineId) return { status: 404, body: { error: "no such loop on this machine" } };
    const allowedPaths = new Set(loop.artifacts);
    if (manifest.some((entry) => !allowedPaths.has(entry.path))) {
      return { status: 400, body: { error: "manifest path is not configured on this loop" } };
    }

    const keepPaths: string[] = [];
    const needHashes = new Set<string>();
    // Metadata and byte storage are separate durability facts. Cache their joined
    // state per hash so a manifest that reuses one blob performs at most one DB
    // lookup and one filesystem/R2 probe.
    const storedState = new Map<string, { metadata: boolean; bytes: boolean }>();
    const stateFor = async (hash: string): Promise<{ metadata: boolean; bytes: boolean }> => {
      const cached = storedState.get(hash);
      if (cached) return cached;
      const metadata = await store.blobExists(hash);
      const state = { metadata, bytes: metadata && await this.blobStore.has(hash) };
      storedState.set(hash, state);
      return state;
    };
    // Presence checks can be filesystem stats or R2 HEAD requests. Prewarm each
    // in-cap hash with bounded concurrency so missing byte objects are repaired
    // without serializing remote round trips.
    const manifestHashes = new Set(
      manifest.flatMap((entry) => entry.oversize ? [] : [entry.hash]),
    );
    await mapConcurrent([...manifestHashes], BLOB_PRESENCE_CONCURRENCY, async (hash) => { await stateFor(hash); });

    for (const entry of manifest) {
      if (entry.oversize) {
        const accepted = await store.upsertConfiguredArtifactFile({
          loopId,
          path: entry.path,
          hash: null,
          size: entry.size,
          binary: entry.binary,
          oversize: true,
        });
        if (accepted) keepPaths.push(entry.path);
        continue;
      }

      const hash = entry.hash;
      const stored = await stateFor(hash);
      const accepted = await store.upsertConfiguredArtifactFile({
        loopId,
        path: entry.path,
        hash,
        size: entry.size,
        binary: entry.binary,
        oversize: false,
      });
      if (!accepted) continue;
      if (!stored.bytes) needHashes.add(hash);
      keepPaths.push(entry.path);
    }

    // Missing configured paths become tombstones. Paths removed from the
    // allowlist cannot be revived by a stale manifest.
    const tombstoned = await store.reconcileConfiguredArtifacts(loopId, [...allowedPaths], keepPaths);

    log.info(
      { machineId, loopId, files: keepPaths.length, need: needHashes.size, tombstoned },
      "sync: reconciled",
    );
    return { status: 200, body: { ok: true, needHashes: [...needHashes] } };
  }

  // ---- PUT /api/machine/blob/:hash ----

  /**
   * Upload one content-addressed blob's raw bytes (Bearer device token). The
   * server recomputes sha256(body) and rejects any mismatch before storing —
   * integrity + anti-poisoning, so a blob's bytes always match its key.
   */
  async putBlob(deviceToken: string, hash: string, bytes: Buffer): Promise<HttpResult> {
    const auth = await authenticateDeviceToken(deviceToken);
    if (!auth.ok) return auth.response;
    const { machineId } = auth;
    if (!isValidHash(hash)) return { status: 400, body: { error: "invalid hash (expect sha256 hex)" } };
    if (bytes.length > BLOB_CAP) return { status: 413, body: { error: "blob exceeds size cap" } };
    if (sha256Buf(bytes) !== hash) return { status: 400, body: { error: "hash mismatch (sha256(body) !== :hash)" } };
    // Upload gate: only accept bytes the sync handshake actually asked THIS machine
    // for — i.e. a hash a live artifact_files row on one of its loops points at
    // (the row sync wrote when it returned the hash in needHashes). Any other PUT
    // (an arbitrary self-hashed blob nothing references) is refused, so a device
    // token can't be used as an uncapped blob write channel. A re-PUT of a still-
    // referenced hash stays accepted (idempotent — daemon retries are safe).
    if (!(await store.machineReferencesBlob(machineId, hash))) {
      return { status: 403, body: { error: "hash was not requested for this machine (sync a manifest first)" } };
    }

    await this.blobStore.put(hash, bytes);
    await store.recordBlob(hash, bytes.length);
    return { status: 200, body: { ok: true } };
  }

  /** Read stored content-addressed bytes, or null when absent. */
  readBlob(hash: string): Promise<Buffer | null> {
    if (!isValidHash(hash)) return Promise.resolve(null);
    return this.blobStore.get(hash);
  }
}
