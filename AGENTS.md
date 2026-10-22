# Pievo agent guide

Pievo is a single-user scheduled prompt runner and status ledger for one person's
devices on a LAN or tailnet. The TanStack Start server owns scheduling, queueing,
persistence, and byte serving; the `@kky42/pievo` CLI runs the server (`pievo server`)
and the daemon (`pievo daemon`), which runs Claude Code, Codex, or Pi on each device.

## Invariants

- **Zero exec:** server code never launches an LLM or executes user code. Only the
  daemon is an execution plane; server computations must be bounded and pure. The
  server launcher may run the local `tailscale` CLI (bounded) to publish HTTPS;
  request handling never spawns processes.
- A loop has one exclusive cron or continuous schedule, one machine/workdir/agent,
  a non-empty stored prompt, all three status definitions, optional model/effort and
  up to four artifact file names, and an enabled state.
  `packages/server/src/gateway/loopConfig.ts` is the canonical create/edit validator;
  unknown keys fail.
- Database cadence facts and durable pending runs are authoritative. Timers and
  dispatcher wakeups are hints. Operations on one loop are serialized under its
  lock; each loop has at most one pending and one running row.
- Pause/Start/Stop/Delete use dedicated lifecycle transitions. Stop records durable
  cancellation intent; running becomes canceled only with daemon proof. Delete never
  removes local project files. Preserve `store.forceDeleteLoop` as the authority-
  retirement path used by owner/server lifecycle flows.
- Delivery is the stored prompt unchanged, status definitions, the loop-file
  contract, and the final-line `STATUS: keep|no-change|block` contract
  (`gateway/prompt.ts`). The status comes only from the provider's final response;
  runs have no CLI. A provider launches once, without retry or session resume.
- Protocol v5 recovery and the daemon SQLite outbox make terminal reports durable.
  Lease/report/lifecycle transitions stay loop-locked. Breaking protocol behavior
  requires updating `gateway/protocol.ts` and the matching daemon release together.
- Loop files (`gateway/loopFiles.ts`): the server owns each loop's required
  `MEMORY.md` (8000 characters) and up to four `.md`/`.html` artifacts (2 MB). A run
  downloads them into `~/.pievo/runs/<run>`, uploads changed versions with its run
  token, and the terminal transaction applies them only if the version the run
  started from is still current (owner edits win). Over-limit versions are rejected,
  never truncated. Daemon limits mirror the server's.
- No login: the network is the human access boundary. `src/start.ts` rejects every
  request whose peer is not loopback, private LAN, or Tailscale
  (`server/networkAccess.ts`); `tailscale serve` traffic arrives from loopback. Never
  add a route that bypasses it. Device tokens impersonate machines and first contact
  requires a live connect key; run tokens authorize only the terminal report and
  that run's loop-file transfer. `PIEVO_ROOTS` is an always-applied daemon cwd jail,
  and server roots may only narrow it.
- Exactly one server process owns a data directory (embedded PGlite plus local
  blobs). Keep heavy/native server dependencies out of client bundles via dynamic
  imports.
- Server state lives in `~/.pievo-server`, daemon state in `~/.pievo`. Source
  development entrypoints use repo-local, mutually isolated server/daemon state and a
  non-production port bound to loopback. Tests use temporary state. Explicit
  environment overrides are intentional opt-outs. Never auto-start the daemon from
  the development server.

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
- `packages/server/src/gateway/{cli,loopConfig,loopFiles,prompt,protocol}.ts`: CLI
  routing, config validation, loop-file limits and bytes, prompt/status contract, and
  wire version.
- `packages/server/src/db/{schema,store}.ts`: baseline schema and loop-locked state
  transitions.
- `packages/server/src/server/boot.ts`: singleton scheduler/gateway/blob-store boot.
- `packages/server/src/{start.ts,server/networkAccess.ts}`: network access guard.
- `packages/server/scripts/{pievo-server,server-cli-lib,server-network}.mjs`: server
  lifecycle launcher, pid/lock safety, and LAN/Tailscale URL publishing.
- `packages/server/src/types.ts`: client-safe shared types and coding-agent enum.
- `packages/daemon/src/{route,runner,cli-client,server-cli}.ts`: command routing,
  provider spawn, server-rendered CLI transport, and `pievo server` delegation.
- `packages/daemon/src/report-outbox.ts`: durable terminal report persistence/retry.
- `packages/daemon/src/loop-files.ts`: per-run loop-file download, collection, and upload.

## Commands

```bash
pnpm dev
pnpm --filter @kky42/pievo-server test
pnpm --filter @kky42/pievo test
pnpm -r typecheck
pnpm --filter @kky42/pievo-server db:generate
```

Server typecheck generates `src/routeTree.gen.ts`. Run one Vitest file by appending
its path. Live provider-schema validation is the explicit spend-bearing exception:

```bash
PIEVO_REAL_LLM_TESTS=1 pnpm --filter @kky42/pievo test src/telemetry.real.test.ts
```

## Release and deployment sharp edges

- Keep SQL migrations reviewed: `0000_baseline` defines the 3.x schema and later
  schema changes append forward migrations, applied in-process at boot. Do not commit
  generated Drizzle snapshots. Document data-loss risks of destructive migrations.
- `server-v*` publishes only `@kky42/pievo-server`; `v*` publishes only
  `@kky42/pievo`, which depends on the server by semver range. Publish the server
  first. Tag and package versions must match.
- Publishing uses npm OIDC/trusted publishing and repository provenance. Do not add
  `registry-url` or `NPM_TOKEN`; pnpm comes from the root `packageManager`.
- Keep server runtime output, public assets, PGlite assets, migrations, launcher
  scripts, and provenance metadata in the published package
  (`verify:package` checks this).
- Public install prose uses `@latest`. Development servers may provide `PIEVO_CLI`
  verbatim and must not add a global-install step.

Keep this file concise and durable. Prefer authoritative modules and tests over copied
implementation detail or task history.
