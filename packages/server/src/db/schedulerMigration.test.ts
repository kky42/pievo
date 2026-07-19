import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "vitest";

async function apply(client: PGlite, file: string): Promise<void> {
  const sql = fs.readFileSync(path.resolve("drizzle", file), "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim()) await client.exec(statement);
  }
}

test("0003 converts legacy markers once, preserves real one-shots, and backfills run ages", async () => {
  const client = new PGlite();
  try {
    await apply(client, "0000_round_marauders.sql");
    await apply(client, "0001_naive_silver_fox.sql");
    await apply(client, "0002_funny_sage.sql");

    const loopValues = (id: string, enabled: boolean, nextRunAt: string | null, evolveDue: boolean, editRequest: string | null) => [
      id, "u1", "m1", id, "0 8 * * *", "auto", true, "claude-code", enabled,
      nextRunAt, evolveDue, editRequest, "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z",
    ];
    for (const values of [
      loopValues("edit-loop", false, "2000-02-01T00:00:00.000Z", false, "legacy owner edit"),
      loopValues("evolve-loop", true, "2000-02-02T00:00:00.000Z", true, null),
      loopValues("one-shot-loop", true, "2026-02-03T00:00:00.000Z", false, null),
      loopValues("running-edit-loop", true, "2099-02-04T00:00:00.000Z", false, "already running"),
      loopValues("future-marker-loop", true, "2099-03-01T00:00:00.000Z", true, null),
    ]) {
      await client.query(
        `INSERT INTO loops
          (id,user_id,machine_id,name,cron,notify,allow_control,agent,enabled,next_run_at,evolve_due,edit_request,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        values,
      );
    }
    await client.query(
      `INSERT INTO runs (id,loop_id,user_id,machine_id,phase,role,ts) VALUES
       ('old-run','one-shot-loop','u1','m1','pending','exec','2026-01-03T00:00:00.000Z'),
       ('running-edit','running-edit-loop','u1','m1','running','edit','2026-01-04T00:00:00.000Z')`,
    );

    await apply(client, "0003_optimal_slapstick.sql");

    const queued = await client.query<{
      loop_id: string;
      role: string;
      requested_by: string;
      request_text: string | null;
      created_at: string;
      updated_at: string;
    }>(`SELECT loop_id,role,requested_by,request_text,created_at,updated_at FROM runs ORDER BY loop_id,role`);
    expect(queued.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ loop_id: "edit-loop", role: "edit", requested_by: "owner", request_text: "legacy owner edit" }),
      expect.objectContaining({ loop_id: "evolve-loop", role: "evolve", requested_by: "system" }),
      expect.objectContaining({ loop_id: "one-shot-loop", role: "exec", requested_by: "system", created_at: "2026-01-03T00:00:00.000Z", updated_at: "2026-01-03T00:00:00.000Z" }),
    ]));

    const facts = await client.query<{ id: string; next_run_at: string | null; next_cadence_at: string | null }>(
      `SELECT id,next_run_at,next_cadence_at FROM loops ORDER BY id`,
    );
    expect(facts.rows.find((r) => r.id === "edit-loop")?.next_run_at).toBeNull();
    expect(facts.rows.find((r) => r.id === "evolve-loop")?.next_run_at).toBeNull();
    expect(facts.rows.find((r) => r.id === "one-shot-loop")?.next_run_at).toBe("2026-02-03T00:00:00.000Z");
    expect(facts.rows.find((r) => r.id === "running-edit-loop")?.next_run_at).toBe("2099-02-04T00:00:00.000Z");
    expect(facts.rows.find((r) => r.id === "future-marker-loop")?.next_run_at).toBe("2099-03-01T00:00:00.000Z");
    expect(facts.rows.every((r) => r.next_cadence_at == null)).toBe(true);

    const legacyColumns = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'loops' AND column_name IN ('edit_request','evolve_due')`,
    );
    expect(legacyColumns.rows.map((r) => r.column_name).sort()).toEqual(["edit_request", "evolve_due"]);
    const cleared = await client.query<{ edit_request: string | null; evolve_due: boolean | null }>(
      `SELECT edit_request,evolve_due FROM loops WHERE id = 'running-edit-loop'`,
    );
    expect(cleared.rows[0]).toEqual({ edit_request: null, evolve_due: false });

    // A rollback-era image omits the new timestamp columns on INSERT. Defaults
    // keep that write compatible during a pragmatic one-release rollback window.
    await client.query(
      `INSERT INTO runs (id,loop_id,user_id,machine_id,phase,role,ts)
       VALUES ('rollback-insert','one-shot-loop','u1','m1','done','exec','2026-03-01T00:00:00.000Z')`,
    );
    const rollbackInsert = await client.query<{ created_at: string; updated_at: string }>(
      `SELECT created_at,updated_at FROM runs WHERE id = 'rollback-insert'`,
    );
    expect(rollbackInsert.rows[0]?.created_at).toBeTruthy();
    expect(rollbackInsert.rows[0]?.updated_at).toBeTruthy();
  } finally {
    await client.close();
  }
});
