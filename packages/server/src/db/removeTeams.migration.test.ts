import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "vitest";

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "drizzle");

function migration(name: string): string {
  return fs.readFileSync(path.join(migrationsDir, name), "utf8");
}

test("0002 removes teams without rewriting owned business data", async () => {
  const pg = new PGlite("memory://");
  try {
    await pg.exec(migration("0000_baseline.sql"));
    await pg.exec(migration("0001_add_pi_agent.sql"));
    await pg.exec(`
      INSERT INTO teams (id, name, owner_user_id, created_at)
      VALUES ('old-team', 'Old Team', 'owner-a', '2025-01-01T00:00:00.000Z');
      INSERT INTO team_members (id, team_id, user_id, role, created_at)
      VALUES ('old-team:owner-a', 'old-team', 'owner-a', 'owner', '2025-01-01T00:00:00.000Z');
      INSERT INTO team_invites (
        token, team_id, role, invited_by_user_id, expires_at, created_at
      ) VALUES (
        'inv-old', 'old-team', 'member', 'owner-a', '2026-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z'
      );
      INSERT INTO machines (
        id, user_id, team_id, name, token_hash, online, created_at
      ) VALUES (
        'machine-a', 'owner-a', 'old-team', 'Machine A', 'machine-hash', true, '2025-01-01T00:00:00.000Z'
      );
      INSERT INTO connect_keys (machine_id, user_id, team_id, minted_at)
      VALUES ('machine-a', 'owner-a', 'old-team', '2025-01-01T00:00:00.000Z');
      INSERT INTO loops (
        id, user_id, team_id, machine_id, name, prompt, status_keep,
        status_no_change, status_block, artifacts, cron, schedule_mode,
        cron_overlap, continuous_delay_minutes, timezone, workdir, agent,
        enabled, created_at, updated_at
      ) VALUES (
        'loop-a', 'owner-a', 'old-team', 'machine-a', 'Loop A', 'Prompt', 'Keep',
        'No change', 'Block', '["report.md"]'::jsonb, '0 6 * * *', 'cron',
        'queue-one', 1, 'UTC', '/work', 'pi', true,
        '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z'
      );
      INSERT INTO runs (
        id, loop_id, machine_id, agent, run_index, phase, requested_by, ts
      ) VALUES (
        'run-a', 'loop-a', 'machine-a', 'pi', 1, 'done', 'owner', '2025-01-01T01:00:00.000Z'
      );
      INSERT INTO blobs (hash, size, created_at)
      VALUES ('blob-a', 4, '2025-01-01T01:00:00.000Z');
      INSERT INTO artifact_files (
        id, loop_id, path, hash, size, "binary", oversize, deleted, updated_at
      ) VALUES (
        'artifact-a', 'loop-a', 'report.md', 'blob-a', 4, false, false, false, '2025-01-01T01:00:00.000Z'
      );
      INSERT INTO run_snapshots (run_id, loop_id, manifest, created_at)
      VALUES (
        'run-a', 'loop-a', '{"report.md":{"hash":"blob-a","size":4,"binary":false,"oversize":false}}'::jsonb,
        '2025-01-01T01:00:00.000Z'
      );
      INSERT INTO run_leases (token_hash, run_id, loop_id, machine_id, state, created_at)
      VALUES ('lease-a', 'run-a', 'loop-a', 'machine-a', 'retired', '2025-01-01T01:00:00.000Z');
      INSERT INTO run_report_receipts (
        report_id, run_id, payload_digest, ack_status, ack_body, created_at
      ) VALUES (
        'report-a', 'run-a', 'digest-a', 200, '{"ok":true}'::jsonb, '2025-01-01T01:00:00.000Z'
      );
    `);

    await pg.exec(migration("0002_remove_teams.sql"));

    const owners = await pg.query<{
      machine_user_id: string;
      loop_user_id: string;
      connect_user_id: string;
      run_id: string;
      artifact_id: string;
    }>(`
      SELECT machines.user_id AS machine_user_id,
             loops.user_id AS loop_user_id,
             connect_keys.user_id AS connect_user_id,
             runs.id AS run_id,
             artifact_files.id AS artifact_id
      FROM machines
      JOIN loops ON loops.machine_id = machines.id
      JOIN connect_keys ON connect_keys.machine_id = machines.id
      JOIN runs ON runs.loop_id = loops.id
      JOIN artifact_files ON artifact_files.loop_id = loops.id
      WHERE machines.id = 'machine-a'
    `);
    expect(owners.rows).toEqual([{
      machine_user_id: "owner-a",
      loop_user_id: "owner-a",
      connect_user_id: "owner-a",
      run_id: "run-a",
      artifact_id: "artifact-a",
    }]);

    const related = await pg.query<{
      blobs: number;
      snapshots: number;
      leases: number;
      receipts: number;
    }>(`
      SELECT
        (SELECT count(*)::int FROM blobs) AS blobs,
        (SELECT count(*)::int FROM run_snapshots) AS snapshots,
        (SELECT count(*)::int FROM run_leases) AS leases,
        (SELECT count(*)::int FROM run_report_receipts) AS receipts
    `);
    expect(related.rows).toEqual([{ blobs: 1, snapshots: 1, leases: 1, receipts: 1 }]);

    const removedTables = await pg.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('teams', 'team_members', 'team_invites')
    `);
    expect(removedTables.rows).toEqual([]);
  } finally {
    await pg.close();
  }
});
