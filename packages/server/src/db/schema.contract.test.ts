import { beforeAll, expect, test } from "vitest";

import { client, runMigrations } from "./index.js";

beforeAll(async () => {
  await runMigrations();
});

const queryClient = client as unknown as {
  query<T>(query: string): Promise<{ rows: T[] }>;
};

const canonicalLoopColumns = [
  "prompt",
  "status_keep",
  "status_no_change",
  "status_block",
  "agent",
  "schedule_mode",
  "cron_overlap",
  "continuous_delay_minutes",
];

test("fresh loop schema has no defaults for canonical required fields", async () => {
  const result = await queryClient.query<{ column_name: string; column_default: string | null }>(`
    SELECT column_name, column_default
    FROM information_schema.columns
    WHERE table_name = 'loops'
      AND column_name IN (${canonicalLoopColumns.map((name) => `'${name}'`).join(", ")})
  `);
  expect(result.rows).toHaveLength(canonicalLoopColumns.length);
  expect(Object.fromEntries(result.rows.map((row) => [row.column_name, row.column_default]))).toEqual(
    Object.fromEntries(canonicalLoopColumns.map((name) => [name, null])),
  );
});

test("loop tag database constraints protect count and reserved names", async () => {
  const insert = (id: string, tags: string) => queryClient.query(`
    INSERT INTO loops (
      id, machine_id, name, tags, prompt, status_keep, status_no_change,
      status_block, cron, schedule_mode, cron_overlap, continuous_delay_minutes,
      workdir, agent, enabled, created_at, updated_at
    ) VALUES (
      '${id}', 'm', 'Tags', ${tags}, 'task', 'keep', 'none', 'block',
      '0 0 1 1 *', 'cron', 'skip', 1, '/work', 'pi', true, 'now', 'now'
    )
  `);
  await expect(insert("schema-too-many-tags", "ARRAY['a','b','c','d','e']::text[]")).rejects.toThrow(/loops_tags_count_check/);
  await expect(insert("schema-reserved-tag", "ARRAY['active']::text[]")).rejects.toThrow(/loops_tags_reserved_check/);
});

test("every migration is applied and Pi is a valid agent", async () => {
  const migrations = await queryClient.query<{ count: string }>(`SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations`);
  expect(migrations.rows).toEqual([{ count: "2" }]);

  await queryClient.query("BEGIN");
  try {
    await queryClient.query(`
      INSERT INTO loops (
        id, machine_id, name, prompt, status_keep, status_no_change,
        status_block, cron, schedule_mode, cron_overlap, continuous_delay_minutes,
        workdir, agent, enabled, created_at, updated_at
      ) VALUES (
        'schema-pi-loop', 'm', 'Pi', 'task', 'keep', 'none', 'block',
        '0 0 1 1 *', 'cron', 'skip', 1, '/work', 'pi', true, 'now', 'now'
      )
    `);
    await queryClient.query(`
      INSERT INTO runs (id, loop_id, machine_id, agent, phase, requested_by, ts)
      VALUES ('schema-pi-run', 'schema-pi-loop', 'm', 'pi', 'running', 'owner', 'now')
    `);
    const result = await queryClient.query<{ loop_agent: string; run_agent: string; tags: string[] }>(`
      SELECT loops.agent AS loop_agent, runs.agent AS run_agent, loops.tags
      FROM loops JOIN runs ON runs.loop_id = loops.id
      WHERE loops.id = 'schema-pi-loop'
    `);
    expect(result.rows).toEqual([{ loop_agent: "pi", run_agent: "pi", tags: [] }]);
  } finally {
    await queryClient.query("ROLLBACK");
  }
});
