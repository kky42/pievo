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
      id, machine_id, name, tags, prompt, cron, schedule_mode, cron_overlap, continuous_delay_minutes,
      workdir, agent, enabled, created_at, updated_at
    ) VALUES (
      '${id}', 'm', 'Tags', ${tags}, 'task',
      '0 0 1 1 *', 'cron', 'skip', 1, '/work', 'pi', true, 'now', 'now'
    )
  `);
  await expect(insert("schema-too-many-tags", "ARRAY['a','b','c','d','e']::text[]")).rejects.toThrow(/loops_tags_count_check/);
  await expect(insert("schema-reserved-tag", "ARRAY['active']::text[]")).rejects.toThrow(/loops_tags_reserved_check/);
});

test("every migration is applied and Pi is a valid agent", async () => {
  const migrations = await queryClient.query<{ count: string }>(`SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations`);
  expect(migrations.rows).toEqual([{ count: "4" }]);

  await queryClient.query("BEGIN");
  try {
    await queryClient.query(`
      INSERT INTO loops (
        id, machine_id, name, prompt, cron, schedule_mode, cron_overlap, continuous_delay_minutes,
        workdir, agent, enabled, created_at, updated_at
      ) VALUES (
        'schema-pi-loop', 'm', 'Pi', 'task',
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

test("a run has a status exactly when it is done", async () => {
  await queryClient.query(`
    INSERT INTO loops (
      id, machine_id, name, prompt, cron, schedule_mode, cron_overlap, continuous_delay_minutes,
      workdir, agent, enabled, created_at, updated_at
    ) VALUES (
      'schema-status-loop', 'm', 'Status', 'task',
      '0 0 1 1 *', 'cron', 'skip', 1, '/work', 'pi', true, 'now', 'now'
    )
  `);
  const insert = (id: string, phase: string, status: string | null) => queryClient.query(`
    INSERT INTO runs (id, loop_id, machine_id, phase, status, requested_by, ts)
    VALUES ('${id}', 'schema-status-loop', 'm', '${phase}', ${status === null ? "NULL" : `'${status}'`}, 'owner', 'now')
  `);
  await expect(insert("schema-done-null", "done", null)).rejects.toThrow(/runs_done_status_check/);
  await expect(insert("schema-error-ok", "error", "ok")).rejects.toThrow(/runs_done_status_check/);
  await expect(insert("schema-done-keep", "done", "keep")).rejects.toThrow(/runs_status_check/);
  await insert("schema-done-ok", "done", "ok");
  await insert("schema-done-block", "done", "block");
  await insert("schema-error", "error", null);
});
