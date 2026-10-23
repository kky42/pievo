# Contributing to Pievo

Pievo is personal software for one user's devices; read [HUMAN.md](HUMAN.md) for its
purpose and design intent before proposing larger changes. The rules every change
must respect (invariants, testing policy, comment standard) are in
[AGENTS.md](AGENTS.md); they apply to human contributors too.

## Layout

- `packages/server` (`@kky42/pievo-server`): TanStack Start dashboard, scheduler,
  embedded PGlite database, and the `pievo-server` launcher.
- `packages/daemon` (`@kky42/pievo`): the `pievo` CLI, daemon, provider runner,
  and the bundled owner skill (`skill/`).
- `scripts/`: shared development helpers.

## Setup

Requirements: Node.js `>=22.13` (`>=22.19` for Pi), pnpm from the root
`packageManager` field, and at least one of Claude Code, Codex, or Pi installed and
authenticated for end-to-end checks.

```bash
pnpm install
cp .env.example packages/server/.env   # optional overrides
```

Development entrypoints use repo-local, isolated state under `.pievo/development/`
(server and daemon kept apart) and serve on `http://127.0.0.1:3001`, so they never
touch a production `~/.pievo-server` or `~/.pievo`.

## Checks

```bash
pnpm -r typecheck                          # also regenerates src/routeTree.gen.ts
pnpm --filter @kky42/pievo-server test
pnpm --filter @kky42/pievo test
pnpm --filter @kky42/pievo test src/runner.test.ts   # one file
```

Live provider-schema validation spends real credits and runs only on request:

```bash
PIEVO_REAL_LLM_TESTS=1 pnpm --filter @kky42/pievo test src/telemetry.real.test.ts
```

## End-to-end check

Unit tests do not prove that an agent run or the dashboard works. Before calling a
behavior change done, exercise it for real:

1. Start the server: `pnpm dev`. The dev server never starts a daemon itself.
2. Open `http://127.0.0.1:3001` in a real browser and click **New Loop**. The
   connect command it shows runs the in-repo CLI; run it, or run
   `pnpm dev:daemon daemon connect --server-url http://127.0.0.1:3001 --connect-key <dk_…>`.
   `pnpm dev:daemon <args>` runs any `pievo` command against the dev state.
3. Create a loop whose working directory is a disposable scratch folder, with a
   real agent, the cheapest suitable model, and a small prompt. Use the dashboard
   flow, the owner skill, or `pnpm dev:daemon new --json '<config>'`.
4. Click **Run once** and watch it reach a terminal state. Check the reported
   status and attention, the run summary, the loop's `MEMORY.md` in the dashboard
   memory panel and any "Memory not kept" notice on the run, the token curve on the
   timeline, and any lifecycle action you touched
   (Pause, Start, Stop, Delete).
5. For dashboard changes, interact with the affected screens in the browser:
   loading, empty and error states, light and dark mode, and a narrow window (the
   page must never scroll horizontally).
6. Clean up: `pnpm dev:daemon daemon stop`, stop `pnpm dev`, and delete the scratch
   folder and any loops you created.

### Agent scenarios

- Keep everything for one check in a single `mktemp -d` folder: workdirs, wrapper,
  seeded files, transcripts.
- Make the workdir inputs small files the prompt reads (for example `disk.txt` holding
  `83`). Then edit them between runs to drive each outcome: a value over a threshold
  (attention), the same value again (ok, nothing to flag), a removed file (block), and a changed
  format (a lesson worth remembering).
- After each run, read `pnpm dev:daemon log <loop> --run <n>`, `memory <loop>`, and
  `show` (enabled, pauseCause, nextFire).
- Click **Run once** in the browser to start runs. There is no owner CLI for it.

### Owner skill

1. Connecting or restarting the dev daemon (`pnpm dev:daemon daemon restart`)
   reinstalls the repo skill into `~/.claude/skills/pievo` and
   `~/.agents/skills/pievo`. Confirm with
   `diff -r packages/daemon/skill ~/.claude/skills/pievo`.
2. Give the agent a CLI wrapper in the scratch folder:
   `exec node <repo>/packages/daemon/scripts/dev.mjs "$@"`. Don't use
   `pnpm dev:daemon` here: `pnpm run` re-quotes arguments through a shell and expands
   `$PIEVO_LOOP_DIR` inside JSON configs.
3. Run the agent headless from the scratch folder and state the wrapper path as
   the CLI prefix in the request. Let it propose, then confirm in a second turn:
   - Claude Code: `claude -p "/pievo <request>" --output-format json --allowedTools "Bash(<wrapper>:*)" Read Write`,
     then `claude -p "go ahead" --resume <session_id> …`. Put the message before
     `--allowedTools`, which consumes every argument after it.
   - Pi: `pi -p --model <model> --session-id <uuid> "/skill:pievo <request>"`,
     then the same `--session-id` with the confirmation.
4. Read the created or edited loop back with `show --full` and `memory`, then run it
   at least once.

## Database migrations

`packages/server/drizzle/0000_baseline` defines the 3.x schema; later changes append
reviewed forward migrations (`pnpm --filter @kky42/pievo-server db:generate`) that
the server applies in-process at boot. Do not commit generated Drizzle snapshots,
and document the data-loss risk of any destructive migration.

## Release

- `server-v*` tags publish only `@kky42/pievo-server`; `v*` tags publish only
  `@kky42/pievo`, which depends on the server by semver range. Publish the server
  first. Tag and package versions must match.
- Publishing uses npm OIDC trusted publishing with repository provenance. Do not add
  `registry-url` or `NPM_TOKEN`; pnpm comes from the root `packageManager`.
- The server package must ship its runtime output, public assets, PGlite assets,
  migrations, launcher scripts, and provenance metadata;
  `pnpm --filter @kky42/pievo-server verify:package` checks this.
- A breaking protocol change updates `gateway/protocol.ts` and ships with the
  matching daemon release.
- Public install instructions use `@latest`. Development servers may set
  `PIEVO_CLI` (used verbatim) and must not add a global-install step.
