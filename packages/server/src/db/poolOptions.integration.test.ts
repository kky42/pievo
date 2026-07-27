/**
 * Real-driver coverage for the session-mode pool under concurrency. Gated on a
 * separately configured Postgres instance so the ordinary suite remains hermetic.
 *
 *   PG_INTEGRATION_URL='postgresql://postgres:test@127.0.0.1:5433/postgres' \
 *     pnpm --filter @kky42/pievo-server test -- --run src/db/poolOptions.integration.test.ts
 */
import { describe, it, expect } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";

import { poolOptionsFor } from "./poolOptions.js";

const URL = process.env.PG_INTEGRATION_URL;
const suite = URL ? describe : describe.skip;

suite("poolOptions — real postgres-js + drizzle", () => {
  it("session-mode options survive a burst of transactions and prepared queries", async () => {
    const opts = poolOptionsFor(URL!);
    expect(opts.prepare).toBe(true);
    expect("max_pipeline" in opts).toBe(false);

    const client = postgres(URL!, opts as Parameters<typeof postgres>[1]);
    const db = drizzle(client);
    try {
      await client`drop table if exists wd_burst`;
      await client`create table wd_burst (id serial primary key, n int)`;

      const count = 120;
      const operations: Promise<unknown>[] = [];
      for (let i = 0; i < count; i++) {
        if (i % 2 === 0) {
          operations.push(db.execute(sql`select ${i}::int as x`));
        } else {
          operations.push(
            db.transaction(async (tx) => {
              await tx.execute(sql`insert into wd_burst (n) values (${i})`);
              await tx.execute(sql`select count(*)::int from wd_burst`);
            }),
          );
        }
      }

      const settled = await Promise.allSettled(operations);
      const failures = settled
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
      expect(failures).toEqual([]);

      const rows = await client<{ count: number }[]>`select count(*)::int as count from wd_burst`;
      expect(rows[0]?.count).toBe(count / 2);
    } finally {
      await client.end({ timeout: 5 });
    }
  }, 30_000);
});
