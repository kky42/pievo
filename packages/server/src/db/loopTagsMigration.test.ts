import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { expect, test } from 'vitest'

const migrations = path.resolve(import.meta.dirname, '../../drizzle')

async function apply(client: PGlite, name: string) {
  const sql = fs.readFileSync(path.join(migrations, name), 'utf8')
  for (const statement of sql.split('--> statement-breakpoint').map((part) => part.trim()).filter(Boolean)) {
    await client.exec(statement)
  }
}

test('the tags migration preserves existing loops and gives them no tags', async () => {
  const client = new PGlite()
  try {
    await apply(client, '0000_baseline.sql')
    await apply(client, '0001_add_pi_agent.sql')
    await apply(client, '0002_remove_teams.sql')
    await client.exec(`
      INSERT INTO loops (
        id, user_id, machine_id, name, prompt, status_keep, status_no_change,
        status_block, cron, schedule_mode, cron_overlap, continuous_delay_minutes,
        workdir, agent, enabled, created_at, updated_at
      ) VALUES (
        'existing-loop', 'user-a', 'machine-a', 'Existing loop', 'task', 'keep',
        'none', 'block', '0 6 * * *', 'cron', 'skip', 1, '/work',
        'claude-code', false, 'created', 'updated'
      )
    `)

    await apply(client, '0003_add_loop_tags.sql')

    const result = await client.query<{ id: string; name: string; enabled: boolean; tags: string[] }>(
      `SELECT id, name, enabled, tags FROM loops WHERE id = 'existing-loop'`,
    )
    expect(result.rows).toEqual([{ id: 'existing-loop', name: 'Existing loop', enabled: false, tags: [] }])
  } finally {
    await client.close()
  }
})
