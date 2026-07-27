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
    "team_invites_role_check",
    "team_members_role_check",
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

test("fresh ownership rows always materialize team scope", async () => {
  const result = await queryClient.query<{ table_name: string; is_nullable: string }>(`
    SELECT table_name, is_nullable
    FROM information_schema.columns
    WHERE column_name = 'team_id'
      AND table_name IN ('machines', 'loops', 'connect_keys')
    ORDER BY table_name
  `);
  expect(result.rows).toEqual([
    { table_name: "connect_keys", is_nullable: "NO" },
    { table_name: "loops", is_nullable: "NO" },
    { table_name: "machines", is_nullable: "NO" },
  ]);
});
