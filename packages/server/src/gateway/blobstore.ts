/**
 * Content-addressed blob byte store for live-synced loop artifacts.
 *
 * Bytes are keyed by their sha256 hash (content-addressed ⇒ deduped across every
 * loop/run). The store ONLY writes/reads bytes — it never executes or interprets
 * them — preserving the server's zero-exec invariant.
 *
 * `LocalBlobStore` is the durable store under `<dataDir>/blobs`;
 * `MemoryBlobStore` is the injected test fake.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { dataDir } from "../env.js";
import { logger } from "../logger.js";

const log = logger.child({ mod: "blobstore" });

export interface BlobStore {
  has(hash: string): Promise<boolean>;
  put(hash: string, bytes: Buffer): Promise<void>;
  get(hash: string): Promise<Buffer | null>;
  /** Reclaim a blob's bytes (GC). Idempotent — deleting an absent hash is a no-op. */
  delete(hash: string): Promise<void>;
}

const SHA256_HEX = /^[a-f0-9]{64}$/;

/** Durable filesystem adapter. Hash sharding bounds entries per directory; atomic
 * temp-file renames ensure readers see either complete bytes or no object. */
export class LocalBlobStore implements BlobStore {
  private initialized?: Promise<void>;

  constructor(readonly root: string = path.join(dataDir(), "blobs")) {}

  private file(hash: string): string {
    if (!SHA256_HEX.test(hash)) throw new Error("invalid sha256 blob key");
    return path.join(this.root, hash.slice(0, 2), hash);
  }

  async has(hash: string): Promise<boolean> {
    const target = this.file(hash);
    await this.ensureInitialized();
    try {
      return (await fs.stat(target)).isFile();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }

  private async syncDir(dir: string): Promise<void> {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(dir, "r");
      await handle.sync();
    } catch (err) {
      // Directory fsync is unsupported on Windows and some filesystems. Atomic
      // rename still holds there; POSIX filesystems get the stronger durability.
      const code = (err as NodeJS.ErrnoException).code;
      if (!(["EINVAL", "ENOTSUP", "EBADF", "EPERM", "ENOENT"] as Array<string | undefined>).includes(code)) throw err;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  private ensureInitialized(): Promise<void> {
    return this.initialized ??= (async () => {
      await fs.mkdir(this.root, { recursive: true });
      // Persist every possibly-new directory entry in the root chain so blob
      // metadata never outlives a newly-created data dir after a crash.
      await this.syncDir(path.dirname(path.dirname(this.root)));
      await this.syncDir(path.dirname(this.root));
      await this.syncDir(this.root);

      // A killed process can strand synced temp files. Single-server ownership
      // means no live writer exists while a new adapter initializes, so reclaim
      // only our exact temp-name format before serving reads/writes.
      for (const shard of await fs.readdir(this.root, { withFileTypes: true })) {
        if (!shard.isDirectory() || !/^[a-f0-9]{2}$/.test(shard.name)) continue;
        const dir = path.join(this.root, shard.name);
        let removed = false;
        for (const name of await fs.readdir(dir)) {
          if (!/^\.[a-f0-9]{64}\.\d+\.[0-9a-f-]+\.tmp$/.test(name)) continue;
          await fs.rm(path.join(dir, name), { force: true });
          removed = true;
        }
        if (removed) await this.syncDir(dir);
      }
    })();
  }

  async put(hash: string, bytes: Buffer): Promise<void> {
    const target = this.file(hash);
    await this.ensureInitialized();
    const dir = path.dirname(target);
    await fs.mkdir(dir, { recursive: true });
    // Persist a newly-created shard directory before the file.
    await this.syncDir(this.root);
    const temp = path.join(dir, `.${hash}.${process.pid}.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(temp, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      try {
        await fs.rename(temp, target);
        await this.syncDir(dir);
      } catch (err) {
        // Windows may refuse replacing a target another same-hash writer just
        // committed. That winner is equivalent because keys are content hashes.
        if (["EEXIST", "EACCES", "EPERM"].includes((err as NodeJS.ErrnoException).code ?? "") && await this.has(hash)) {
          await fs.rm(temp, { force: true });
          return;
        }
        throw err;
      }
    } catch (err) {
      await handle?.close().catch(() => {});
      await fs.rm(temp, { force: true }).catch(() => {});
      throw err;
    }
  }

  async get(hash: string): Promise<Buffer | null> {
    const target = this.file(hash);
    await this.ensureInitialized();
    try {
      return await fs.readFile(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async delete(hash: string): Promise<void> {
    const target = this.file(hash);
    await this.ensureInitialized();
    await fs.rm(target, { force: true });
    // GC drops metadata after this resolves; persist the byte deletion first so a
    // crash cannot resurrect an untracked file after its DB row is gone.
    await this.syncDir(path.dirname(target));
  }
}

export class MemoryBlobStore implements BlobStore {
  private readonly map = new Map<string, Buffer>();
  async has(hash: string): Promise<boolean> {
    return this.map.has(hash);
  }
  async put(hash: string, bytes: Buffer): Promise<void> {
    this.map.set(hash, Buffer.from(bytes));
  }
  async get(hash: string): Promise<Buffer | null> {
    return this.map.get(hash) ?? null;
  }
  async delete(hash: string): Promise<void> {
    this.map.delete(hash);
  }
}

/** The one local blob store shared by sync writes, artifact reads, and GC. */
export function createBlobStore(): BlobStore {
  const local = new LocalBlobStore();
  log.info({ root: local.root }, "blob store: local filesystem");
  return local;
}
