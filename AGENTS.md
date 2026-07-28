# Pievo agent guide

Pievo is a multi-user scheduled prompt runner and status ledger. The TanStack Start
server owns scheduling, queueing, auth, persistence, and byte serving; the
`@kky42/pievo` daemon runs Claude Code, Codex, or Pi on a user's machine.

## Invariants

- **Zero exec:** server code never launches an LLM or executes user code. Only the
  daemon is an execution plane; server computations must be bounded and pure.
- A loop has one exclusive cron or continuous schedule, one machine/workdir/agent,
  a non-empty stored prompt, all three status definitions, optional model/effort and
  exact artifact paths, and an enabled state. `packages/server/src/gateway/loopConfig.ts` is
  the canonical create/edit validator; unknown keys fail.
- Database cadence facts and durable pending runs are authoritative. Timers and
  dispatcher wakeups are hints. Operations on one loop are serialized under its
  lock; each loop has at most one pending and one running row.
- Pause/Start/Stop/Delete use dedicated lifecycle transitions. Stop records durable
  cancellation intent; running becomes canceled only with daemon proof. Delete never
  removes local project files. Preserve `store.forceDeleteLoop` as the authority-
  retirement path used by owner/server lifecycle flows.
- Delivery is the stored prompt unchanged, status definitions, and exactly one
  required `pievo report` instruction. A provider launches once, without retry or
  session resume. Terminal diagnostics remain separate from the agent report.
- Protocol v4 recovery and the daemon SQLite outbox make terminal reports durable.
  Lease/report/lifecycle transitions stay loop-locked. Breaking protocol behavior
  requires updating `gateway/protocol.ts` and the matching daemon release together.
- Artifact sync accepts configured exact workdir-relative paths only: no scan or
  globbing. Enforce lexical and realpath containment, regular files, and the 10 MB
  per-file rule. Every configured path is an explicit upload decision.
- Device tokens impersonate machines; run tokens authorize only report/help. Keep
  auth/team checks enumeration-safe. `PIEVO_ROOTS` is an always-applied daemon cwd
  jail, and server roots may only narrow it.
- Exactly one server process owns a database. Production must explicitly select
  PGlite when `DATABASE_URL` is absent. Keep heavy/native server dependencies out of
  client bundles via dynamic imports.

## Comment standard

- Keep comments only when they add durable context absent from the code: why and
  trade-offs, default-value rationale, TODOs, protocol/compatibility/security
  constraints, deliberate compromises, applicability limits, or non-obvious risks.
- Delete comments that paraphrase symbols, branches, return types, CSS properties,
  section headings, tests, or assertions. Prefer clear names, types, and tests.
- For limits and defaults, record the unit, rationale or source, and consequence of
  changing them. Keep comments next to the invariant and update them with behavior.

## Module map

- `packages/server/src/gateway/index.ts`: poll/report lifecycle, reconciliation,
  owner loop methods, sweep, and storage maintenance.
- `packages/server/src/gateway/{cli,loopConfig,sync,prompt,protocol}.ts`: CLI routing,
  config validation, exact-artifact ingress, prompt construction, and wire version.
- `packages/server/src/db/{schema,store}.ts`: baseline schema and loop-locked state
  transitions.
- `packages/server/src/server/boot.ts`: singleton scheduler/gateway/blob-store boot.
- `packages/server/src/auth.ts`: request/team authorization.
- `packages/server/src/types.ts`: client-safe shared types and coding-agent enum.
- `packages/daemon/src/{route,runner,cli-client}.ts`: command routing, provider spawn,
  and server-rendered CLI transport.
- `packages/daemon/src/report-outbox.ts`: durable terminal report persistence/retry.
- `packages/daemon/src/artifacts.ts`: exact local artifact collection.

## Commands

```bash
pnpm dev
pnpm --filter @kky42/pievo-server test
pnpm --filter @kky42/pievo test
pnpm -r typecheck
pnpm --filter @kky42/pievo-server db:generate
pnpm --filter @kky42/pievo-server db:migrate
```

Server typecheck generates `src/routeTree.gen.ts`. Run one Vitest file by appending
its path. Live provider-schema validation is the explicit spend-bearing exception:

```bash
PIEVO_REAL_LLM_TESTS=1 pnpm --filter @kky42/pievo test src/telemetry.real.test.ts
```

## Release and deployment sharp edges

- Keep SQL migrations reviewed: `0000_baseline` defines the original schema and
  deployed schema changes append forward migrations. Do not commit generated Drizzle
  snapshots. Hosted migrations require a direct Postgres URL when runtime uses a
  transaction pooler.
- `server-v*` publishes only `@kky42/pievo-server`; `v*` publishes only
  `@kky42/pievo`. Tag and package versions must match.
- Publishing uses npm OIDC/trusted publishing and repository provenance. Do not add
  `registry-url` or `NPM_TOKEN`; pnpm comes from the root `packageManager`.
- Keep server runtime output, public assets, PGlite assets, migrations, launcher
  scripts, and provenance metadata in the published package.
- Fly examples are single-process/manual and own no app, origin, region, or volume.
  Persist PGlite/local blobs; external Postgres plus R2 is stateless.
- Public install prose uses `@latest`. Development servers may provide `PIEVO_CLI`
  verbatim and must not add a global-install step.

Keep this file concise and durable. Prefer authoritative modules and tests over copied
implementation detail or task history.
