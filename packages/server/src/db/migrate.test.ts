import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, expect, test } from "vitest";

const drizzleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "drizzle");
const legacyTags = ["0000_baseline", "0001_loop_files", "0002_run_attention", "0003_run_status_ok"];

const memoryText = "# Lessons\n\nCheck the log before rerunning.\n";
const memoryHash = createHash("sha256").update(memoryText).digest("hex");
const missingHash = createHash("sha256").update("missing bytes").digest("hex");
const notesHash = createHash("sha256").update("notes").digest("hex");

let tmp: string;
let db: typeof import("./index.js");

async function loopMemory(): Promise<Record<string, string>> {
  const result = await db.client.query<{ id: string; memory: string }>("SELECT id, memory FROM loops ORDER BY id");
  return Object.fromEntries(result.rows.map((row) => [row.id, row.memory]));
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-migrate-"));
  process.env.PIEVO_DATA_DIR = tmp;
  process.env.PIEVO_LOG_LEVEL = "silent";

  // A 5.0.0 data directory has only 0000-0003 applied; the truncated journal
  // makes the migrator treat 0004 as pending.
  const legacyDir = path.join(tmp, "drizzle-legacy");
  fs.mkdirSync(path.join(legacyDir, "meta"), { recursive: true });
  for (const tag of legacyTags) {
    fs.copyFileSync(path.join(drizzleDir, `${tag}.sql`), path.join(legacyDir, `${tag}.sql`));
  }
  const journal = JSON.parse(fs.readFileSync(path.join(drizzleDir, "meta", "_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  journal.entries = journal.entries.filter((entry) => legacyTags.includes(entry.tag));
  fs.writeFileSync(path.join(legacyDir, "meta", "_journal.json"), JSON.stringify(journal));

  const legacy = new PGlite(path.join(tmp, "pgdata"));
  await migrate(drizzle(legacy), { migrationsFolder: legacyDir });

  const insertLoop = (id: string, name: string) =>
    legacy.query(
      `INSERT INTO loops (
        id, machine_id, name, tags, prompt, artifacts, cron, schedule_mode, cron_overlap,
        continuous_delay_minutes, workdir, agent, enabled, created_at, updated_at
      ) VALUES ($1, 'm', $2, ARRAY[]::text[], 'task', '[]'::jsonb, '0 0 1 1 *', 'cron', 'skip', 1, '/work', 'pi', true, 'now', 'now')`,
      [id, name],
    );
  await insertLoop("loop-a", "A");
  await insertLoop("loop-b", "B");

  const blobDir = path.join(tmp, "blobs", memoryHash.slice(0, 2));
  fs.mkdirSync(blobDir, { recursive: true });
  fs.writeFileSync(path.join(blobDir, memoryHash), memoryText);
  await legacy.query(`INSERT INTO blobs (hash, size, created_at) VALUES ($1, $2, 'now'), ($3, 5, 'now')`, [
    memoryHash,
    memoryText.length,
    notesHash,
  ]);

  const insertArtifact = (id: string, loopId: string, filePath: string, hash: string) =>
    legacy.query(
      `INSERT INTO artifact_files (id, loop_id, path, hash, size, updated_at)
       VALUES ($1, $2, $3, $4, 1, 'now')`,
      [id, loopId, filePath, hash],
    );
  await insertArtifact("artifact-a-memory", "loop-a", "MEMORY.md", memoryHash);
  await insertArtifact("artifact-a-notes", "loop-a", "notes.txt", notesHash);
  await insertArtifact("artifact-b-memory", "loop-b", "MEMORY.md", missingHash);

  await legacy.close();
  db = await import("./index.js");
  await db.runMigrations();
});

afterAll(async () => {
  try {
    await db?.client.close();
  } catch {
    // setup.ts closes the singleton too
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("the 0004 upgrade carries MEMORY.md bytes into loops.memory", async () => {
  expect(await loopMemory()).toEqual({ "loop-a": memoryText, "loop-b": "" });
});

test("the 0004 upgrade drops legacy tables and blob bytes", async () => {
  const result = await db.client.query<{ artifacts: string | null; snapshots: string | null; blobs: string | null }>(
    `SELECT to_regclass('public.artifact_files') AS artifacts,
            to_regclass('public.run_snapshots') AS snapshots,
            to_regclass('public.blobs') AS blobs`,
  );
  expect(result.rows[0]).toEqual({ artifacts: null, snapshots: null, blobs: null });
  expect(fs.existsSync(path.join(tmp, "blobs"))).toBe(false);
});

test("running the migrations again keeps the carried memory", async () => {
  await db.runMigrations();
  expect(await loopMemory()).toEqual({ "loop-a": memoryText, "loop-b": "" });
});
