/**
 * Embedded PGlite (WASM Postgres) database, file-backed at `<dataDir>/pgdata`,
 * plus the Drizzle handle. A `globalThis` guard keeps the handle a singleton
 * across dev HMR reloads (the Scheduler shares it in-process). Exactly one
 * server process may own a data directory.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";

import { dataDir } from "../env.js";
import { logger } from "../logger.js";
import { machines, loops, runs, blobs, artifactFiles, runSnapshots, runLeases, runReportReceipts, terminalReportIncidents, connectKeys } from "./schema.js";

const schema = {
  machines,
  loops,
  runs,
  blobs,
  artifactFiles,
  runSnapshots,
  runLeases,
  runReportReceipts,
  terminalReportIncidents,
  connectKeys,
};

type Db = PgliteDatabase<typeof schema>;

const g = globalThis as unknown as { __pievoDb?: Db; __pievoClient?: PGlite };

function open(): { db: Db; client: PGlite } {
  if (g.__pievoDb && g.__pievoClient) return { db: g.__pievoDb, client: g.__pievoClient };
  const dir = path.join(dataDir(), "pgdata");
  logger.info({ pgdata: dir }, "database: pglite");
  fs.mkdirSync(dataDir(), { recursive: true });
  const client = new PGlite(dir);
  const db = drizzle(client, { schema });
  g.__pievoClient = client;
  g.__pievoDb = db;
  return { db, client };
}

const opened = open();
export const db: Db = opened.db;
/** Raw PGlite handle for tests' low-level seeding; app code uses `db`. */
export const client: PGlite = opened.client;

/**
 * Migrations dir. In DEV this file lives at `src/db`, so the folder is at the
 * package root (`../../drizzle`). In the BUILT server the module is bundled under
 * `.output/server/{_ssr,_libs}` and `copy-pglite-assets.mjs` lands the folder at
 * `.output/server/drizzle` (`../drizzle`). Return the first candidate that exists
 * so the database migrates in-process from either layout.
 */
function migrationsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const devDir = path.resolve(here, "..", "..", "drizzle"); // dev: src/db → package root
  const builtDir = path.resolve(here, "..", "drizzle"); // built: .output/server/{_ssr,_libs} → .output/server/drizzle
  if (fs.existsSync(devDir)) return devDir;
  if (fs.existsSync(builtDir)) return builtDir;
  return devDir;
}

/** Apply generated migrations in-process (idempotent). */
export async function runMigrations(): Promise<void> {
  const dir = migrationsDir();
  if (!fs.existsSync(dir)) return; // not generated yet (pre-`db:generate`)
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  await migrate(opened.db, { migrationsFolder: dir });
}

/**
 * Best-effort clean shutdown of the database client (called from the
 * boot AbortController on SIGINT/SIGTERM). PGlite must be closed explicitly:
 * after migrations it owns a referenced WASM timer that otherwise keeps Node
 * alive until the managed launcher's graceful-stop deadline. Never throws —
 * shutdown must not wedge on a slow drain.
 */
export async function closeClient(): Promise<void> {
  try {
    await opened.client.close();
  } catch {
    // ignore — process is exiting
  }
}

export * from "./schema.js";
