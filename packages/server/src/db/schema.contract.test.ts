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

test("canonical text enums are enforced by database CHECK constraints", async () => {
  const expected = [
    "loops_agent_check",
    "loops_cron_overlap_check",
    "loops_schedule_mode_check",
    "run_leases_state_check",
    "runs_agent_check",
    "runs_phase_check",
    "runs_requested_by_check",
    "runs_status_check",
    "terminal_report_incidents_disposition_check",
  ];
  const result = await queryClient.query<{ conname: string }>(`
    SELECT conname
    FROM pg_constraint
    WHERE contype = 'c' AND conname IN (${expected.map((name) => `'${name}'`).join(", ")})
    ORDER BY conname
  `);
  expect(result.rows.map((row) => row.conname)).toEqual(expected);
});

test("all forward migrations are applied and Pi remains valid", async () => {
  const migrations = await queryClient.query<{ count: string }>(`SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations`);
  expect(migrations.rows).toEqual([{ count: "3" }]);

  await queryClient.query("BEGIN");
  try {
    await queryClient.query(`
      INSERT INTO loops (
        id, user_id, machine_id, name, prompt, status_keep, status_no_change,
        status_block, cron, schedule_mode, cron_overlap, continuous_delay_minutes,
        workdir, agent, enabled, created_at, updated_at
      ) VALUES (
        'schema-pi-loop', 'u', 'm', 'Pi', 'task', 'keep', 'none', 'block',
        '0 0 1 1 *', 'cron', 'skip', 1, '/work', 'pi', true, 'now', 'now'
      )
    `);
    await queryClient.query(`
      INSERT INTO runs (id, loop_id, machine_id, agent, phase, requested_by, ts)
      VALUES ('schema-pi-run', 'schema-pi-loop', 'm', 'pi', 'running', 'owner', 'now')
    `);
    const result = await queryClient.query<{ loop_agent: string; run_agent: string }>(`
      SELECT loops.agent AS loop_agent, runs.agent AS run_agent
      FROM loops JOIN runs ON runs.loop_id = loops.id
      WHERE loops.id = 'schema-pi-loop'
    `);
    expect(result.rows).toEqual([{ loop_agent: "pi", run_agent: "pi" }]);
  } finally {
    await queryClient.query("ROLLBACK");
  }
});

test("user ownership is required and team persistence is absent", async () => {
  const ownership = await queryClient.query<{ table_name: string; is_nullable: string }>(`
    SELECT table_name, is_nullable
    FROM information_schema.columns
    WHERE column_name = 'user_id'
      AND table_name IN ('machines', 'loops', 'connect_keys')
    ORDER BY table_name
  `);
  expect(ownership.rows).toEqual([
    { table_name: "connect_keys", is_nullable: "NO" },
    { table_name: "loops", is_nullable: "NO" },
    { table_name: "machines", is_nullable: "NO" },
  ]);

  const teamColumns = await queryClient.query<{ table_name: string }>(`
    SELECT table_name
    FROM information_schema.columns
    WHERE column_name = 'team_id'
      AND table_name IN ('machines', 'loops', 'connect_keys')
  `);
  expect(teamColumns.rows).toEqual([]);

  const teamTables = await queryClient.query<{ table_name: string }>(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('teams', 'team_members', 'team_invites')
  `);
  expect(teamTables.rows).toEqual([]);

  const ownershipIndexes = await queryClient.query<{ indexname: string }>(`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname IN ('machines_user_idx', 'loops_user_idx', 'machines_team_idx', 'loops_team_idx')
    ORDER BY indexname
  `);
  expect(ownershipIndexes.rows).toEqual([
    { indexname: "loops_user_idx" },
    { indexname: "machines_user_idx" },
  ]);
});
