# Contributing to Pievo

Pievo is personal software for one user's devices; read [HUMAN.md](HUMAN.md) for its
purpose and design intent before proposing larger changes. The rules every change
must respect (invariants, testing policy, comment standard) are in
[AGENTS.md](AGENTS.md); they apply to human contributors too.

## Layout

- `packages/server` (`@kky42/pievo-server`): TanStack Start dashboard, scheduler,
  embedded PGlite database, blob store, and the `pievo-server` launcher.
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
   status, the run summary, `MEMORY.md` and artifact updates, their rendering and
   diff in the dashboard, and any lifecycle action you touched (Pause, Start, Stop,
   Delete).
5. For dashboard changes, interact with the affected screens in the browser:
   loading, empty and error states, light and dark mode, and a narrow window (the
   page must never scroll horizontally).
6. Clean up: `pnpm dev:daemon daemon stop`, stop `pnpm dev`, and delete the scratch
   folder and any loops you created.

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
