# Pievo agent guide

Pievo is a multi-user **scheduled prompt runner and status ledger**. The TanStack
Start server schedules, queues, stores, authenticates, and serves bytes. Execution is
BYOA through the `@kky42/pievo` daemon on a user's machine.

**Zero-exec invariant:** server code must never start an LLM or execute user code.
It may store/read bytes and run bounded pure computations such as validation, hashing,
and text diffs. The daemon is the only execution plane.

`CLAUDE.md` symlinks to this file. Keep it concise, project-intrinsic, and current;
prefer pointers to authoritative code/tests over task history.

## Repository

pnpm monorepo:

- `packages/server` (`@kky42/pievo-server`): TanStack Start web UI and server fns,
  in-process `croner` scheduler, machine gateway, Better Auth, Drizzle, Postgres/PGlite,
  and local/R2 artifact storage.
  - `src/gateway/index.ts`: poll/report lifecycle, owner loop methods, sweep, storage maintenance.
  - `src/gateway/cli.ts`: device-vs-run credential routing and owner CLI rendering.
  - `src/gateway/loopConfig.ts`: canonical create/edit validator.
  - `src/gateway/sync.ts`: exact-artifact manifest/blob ingress.
  - `src/db/store.ts`: loop-locked queue, cadence, lease, terminal, and storage transitions.
  - `src/server/boot.ts`: one-process boot and shared scheduler/gateway/blob-store wiring.
  - `src/skill/`: owner-facing connection/create/edit prose.
- `packages/daemon` (`@kky42/pievo`): one binary acting as local poll daemon,
  owner CLI, and the in-run report callback. It launches Claude Code or Codex.

## Commands

```bash
pnpm dev
pnpm --filter @kky42/pievo-server test
pnpm --filter @kky42/pievo test
pnpm -r typecheck
pnpm --filter @kky42/pievo-server db:generate
pnpm --filter @kky42/pievo-server db:migrate
```

Server typecheck generates `src/routeTree.gen.ts` first. For one Vitest file, append
its path to the package test command; use `vitest run -t "name"` for one case.
Provider-schema acceptance is the explicit spend-bearing exception:

```bash
PIEVO_REAL_LLM_TESTS=1 pnpm --filter @kky42/pievo test src/telemetry.real.test.ts
```

## Canonical loop model

Every new loop is validated by `gateway/loopConfig.ts` and contains only:

- required `name` and machine binding;
- required exclusive `schedule` union:
  - `{mode:"cron", cron, timezone, overlap:"skip"|"queue-one"}`;
  - `{mode:"continuous", delayMinutes}`;
- required `workdir`, `agent`, and non-empty server-stored `prompt`;
- optional `model` and `reasoningEffort` (`null` means provider default);
- required non-empty `statusDefinitions.{keep,noChange,block}`;
- optional `artifacts`: exact paths relative to `workdir`;
- `enabled`.

Never expose the denormalized cadence columns as an alternative write interface.
Cron and continuous fields are mutually exclusive at CLI, web, and validator seams.
Unknown config keys fail loudly. `CODING_AGENTS` in `server/src/types.ts` is the
server-side source for the agent enum; widen the daemon executor alongside it.

Fresh deployments use one baseline schema. Retired strategy/config/run-role columns,
data transforms, and backward-compatible write surfaces do not exist.

## Scheduling and lifecycle

Authoritative facts are `loops.nextCadenceAt`, the independent internal one-shot fact,
and durable `runs.phase=pending` rows. Scheduler timers and dispatcher wakeups are
latency hints; every machine poll advances due facts before claiming.

- There is one pending row and at most one running row per loop, enforced by partial
  unique indexes. Same-loop requests coalesce; owner authority promotes a system row
  and is never downgraded.
- Repeated polls can claim different loops, so there is no machine-wide concurrency
  cap. A loop remains serialized.
- Cron advances to the first occurrence strictly after the advancement clock.
  With an open run, `skip` consumes the occurrence without a follow-up;
  `queue-one` retains at most one coalesced follow-up.
- Continuous clears its due fact when materialized and restores
  `terminalAt + delayMinutes` only after `done` or `error`. It never overlaps.
  Cancellation does not restart continuous cadence.
- Boot does no inferred history catch-up. It initializes missing enabled cron facts
  to a future occurrence, then consumes only persisted facts that are actually due.
- **Pause** disables future cadence and cancels pending system work; a current run
  continues. An owner Run-once row may still be claimed while paused.
- **Start** clears the pause cause and re-arms the existing schedule.
- **Stop** pauses, cancels all pending work, and records durable cancellation intent
  for the current run. Running becomes `canceled` only after daemon proof.
- **Delete** is Stop plus server-data removal. Normal deletion waits for execution
  authority; the team-owner force path retires authority and may leave a local process
  running. Local project files are never deleted.

`done + keep` and `done + no-change` continue normally. `done + block` atomically
pauses with `pauseCause.kind="blocked"`. Consecutive `error` rows since the last
successful row trigger the loop-locked breaker at
`PIEVO_FAILURE_AUTOPAUSE_STREAK` (default 3, 0 disables). Canceled rows neither reset
nor increment the streak. A timeout reclaim remains provisional during reconciliation
and does not itself trip the breaker.

## Prompt, report, and provider diagnostics

`gateway/prompt.ts` is intentionally tiny. The first user turn is exactly:

1. `loop.prompt`, byte-for-string unchanged;
2. the three status definitions;
3. the one required `pievo report --message "<summary>" --status
   <keep|no-change|block>` instruction.

Do not inject loop identity, run index, working-directory prose, schedule controls,
history methods, or execution methodology. The daemon sets cwd through spawn.
Delivery has no system-prompt field or Claude system-prompt-file branch.

A run credential authorizes only `report` and its help. The callback requires one
valid status and a non-empty message, records them once under the loop lock, and rejects
duplicate reports. A provider process that exits successfully without a complete
report protocol is finalized as `error`.

Each delivery launches the selected provider exactly once—no provider retry or session
resume. Retain terminal diagnostics independently from the agent report: duration,
exit code, error, session ID, final assistant text, and normalized input/output/cache
token usage. Provider event streams and dollar cost are not transported. The web UI
shows input + output usage; cache fields remain stored.

Claude Code and Codex spawn surfaces live in `daemon/src/runner.ts`. Optional model and
effort flags are emitted only when configured. Codex's
`shell_environment_policy.inherit=all` override is load-bearing so the run-scoped
`pievo` shim stays first on PATH. The default provider timeout is 12 hours;
`PIEVO_EXEC_TIMEOUT_MS` accepts only a positive override.

## Queue, leases, reconciliation, and outbox

Protocol v4 polls carry a per-start `daemonInstanceId`, `recoveryComplete:true`, and
all local `currentRuns` as `executing|reporting`. Idle polls may park for 20 seconds;
active/reporting polls return immediately. `machines.lastSeen` and run heartbeats are
write-throttled.

Claim and hashed lease insertion are one transaction. Wire run tokens are `rk_…`;
only SHA-256 is stored. The lease states are:

- `active`: run callback and terminal report authority;
- `terminal-grace`: blocking report-only authority after inactivity reclaim;
- `reconciliation-only`: late-report authority remains, but successor work may claim;
- `retired`: no authority; durable evidence until a matching report receives 410.

The server reclaims a silent run after `PIEVO_RUN_TIMEOUT_MS` (default 20 minutes) and
keeps a 24-hour late-report window. A completed daemon recovery snapshot moves absent
reclaimed runs to report-only state. Their late report may update only the old run and
receipt, never successor cadence or breaker state. Normal finalization, reconciliation,
lease consumption, loop lifecycle, and durable report receipt are serialized under the
loop lock. Retired tombstones survive loop deletion.

The daemon writes each exact terminal JSON payload and digest to an owner-only SQLite
outbox before the run leaves `executing`. Independent rows retry to a definitive,
report-ID-bound ACK; one slow row does not block other loops. Only the current exact
200 normal/handled ACK shapes and exact 410 `RETIRED` shape consume a row; every other
response remains diagnostic and retryable. Startup hydrates every outbox row as
reporting before its first recovery poll. Daemon Stop waits for terminal-report
persistence by default; `--force` bounds that wait.

A correlatable but invalid terminal payload is not an endless retry: after lease auth,
the server records a structured incident and exact-digest durable ACK, terminalizes an
active run as `error` or preserves an already terminal reconciliation result, and
consumes authority atomically. Missing, NUL-bearing, or over-cap report IDs stay
authenticated but mutation-free 400s.

Pending system work on a machine that remains offline for seven days is retired as a
canceled/skipped ledger row. Owner work is not expired by that backstop.

## Exact artifacts and retention

There is no directory scanner. After provider exit and before outbox persistence, the
daemon processes only configured exact paths:

- no globs or recursive walk;
- reject absolute, empty/dot/traversal paths and lexical escapes;
- resolve real paths and reject symlink escapes outside the real `workdir`;
- accept only regular files; missing/unreadable files are best-effort omissions;
- read at most 10 MB + 1 byte; larger files become metadata-only;
- apply no filename, extension, secret, MIME, or content classification policy.

Because there is no secret-name filter, treat every configured artifact as an explicit
upload decision. Never document an aggregate loop-byte cap that does not exist.

The daemon posts a full manifest of the configured paths, receives missing hashes, and
uploads verified bytes four-at-a-time. Sync uses a device token; the server accepts only
paths still in the loop allowlist and blob hashes referenced by that machine's live
manifest. `POST /api/machine/sync` is capped at 32 MB; each blob PUT at 10 MB. Missing
byte objects are requested again. A removed config path is tombstoned under the loop
lock so stale manifests cannot revive it.

Artifact bytes are content-addressed and deduplicated in one shared `BlobStore`:
local `<PIEVO_DATA_DIR>/blobs` by default, complete R2 config when selected, memory only
by explicit data-loss opt-in. The daemon sync completes before terminalization, then
the server captures a run snapshot. `server/runDiff.ts` computes bounded text diffs
lazily; binary/oversize files show size changes.

Retention prunes to `PIEVO_SNAPSHOT_RETENTION` (default 20), then GC deletes
unreferenced blobs older than the grace window (default 1 hour). GC rechecks references
and deletes bytes before metadata; when uncertain it keeps data. Maintenance runs every
15 minutes by default and uses an in-flight latch. Loop deletion removes current files,
snapshots, and non-retired leases; global unreferenced bytes leave through GC.

## Security and authorization

- Standard machine JSON bodies are capped at 2 MB before parse. Prompt/diagnostic
  string caps are row budgets, not the request security boundary.
- The device token fully impersonates a machine. Its plaintext is stored for reconnect
  UX but serialized only to its owner under auth. Existing machines recheck the full
  token hash, not only the truncated derived machine ID.
- `poll` is the only enrollment surface. In open mode a shaped `dk_` token may enroll
  into the shared workspace. With the GitHub gate enabled, first contact requires a
  live connect key bound to a signed-in user; every other unknown-machine route is 401.
- Connect-key bindings are durable for 24 hours, keyed by the derived machine ID rather
  than plaintext. Loop creation revalidates minter, machine owner, and team membership.
- Machine routes except sync/blob ingress use bounded in-process token buckets per IP
  and per credential. Defaults are 240 burst/8 s⁻¹ per IP and 120 burst/4 s⁻¹ per
  token; tests default off. `Fly-Client-IP`, first `X-Forwarded-For`, then
  `X-Real-IP` determine the IP; missing values share one fail-closed `unknown` bucket.
  Byte ingress is exempt because it already requires a registered device token and the
  exact-path/hash handshake plus body/file caps.
- `PIEVO_ROOTS` is an always-applied local cwd jail. Server roots may only narrow it.
  Resolve-normalize before prefix checks. Child environments are agent-specific
  allowlists, HTTP uses bounded fetches, and termination targets the process group.
- Artifact reads use web sessions plus loop-team membership. Unknown/cross-scope
  resources return a flat 404.

GitHub auth turns on only when both OAuth credentials exist. With the gate on,
`PIEVO_AUTH_SECRET` is mandatory; an empty login allowlist allows any GitHub account.
With the gate off, the app is deliberately open. `requestScope(explicitTeam)` gives URL
team IDs precedence over the last-used cookie and membership-validates both. Direct
loop links authorize against the loop's team, not the active tab. Team management is
owner-only, last-owner transitions are transactional, personal teams cannot be left or
deleted, and teams with loops cannot be deleted.

## Server, database, and deployment gotchas

- **Exactly one server process owns a database.** `ensureServer()` caches the in-flight
  boot promise across HMR. Fly examples use `--ha=false`.
- Vite binds `127.0.0.1`. Production reads `PORT`/`NITRO_PORT`; the published launcher
  accepts `PIEVO_PORT` as its public bind override.
- PGlite lives at `<PIEVO_DATA_DIR>/pgdata`. Production source/Docker requires explicit
  `PIEVO_DB=pglite` when `DATABASE_URL` is absent. The published launcher injects that
  opt-in for its local default.
- External runtime Postgres uses `DATABASE_URL`. Supabase transaction-pooler URLs use
  `prepare:false`; migrations require `DIRECT_DATABASE_URL` and fail loudly rather
  than route DDL/advisory locks through `:6543`.
- Hosted Postgres migration runs in `scripts/prestart.mjs`; PGlite migrates in-process.
  The hosted DB watchdog exits after sustained failed probes so a supervisor can restart
  a wedged process.
- The repository currently targets fresh deployments with one reviewed baseline SQL
  and one journal entry. Do not commit generated Drizzle snapshots. `db:migrate` targets a configured real
  Postgres, not local PGlite. Drizzle text enums are TypeScript-only, not DB CHECKs.
- Route handlers should dynamically import native/heavy server dependencies so they do
  not enter the client bundle. `routeTree.gen.ts` is generated and ignored.

The published `pievo-server` launcher resolves runtime paths from its package root,
runs prestart, records `starting` before the signalable migration child, and accepts
readiness only from `/api/ready` with its per-launch nonce. Lifecycle authority is pid +
process start time; uncertain identity is never signaled or cleared. Detached start is
idempotent, foreground is the supervisor path, and restart preserves recorded bind
settings unless explicitly overridden.

The repository owns no Fly app, origin, region, or volume. Both Fly workflows are
manual examples and verify the configured origin serves the pushed SHA. Persist `/data`
for PGlite or local artifact bytes; external Postgres plus R2 is stateless.

## Daemon protocol gotchas

- Breaking server/daemon behavior must bump `gateway/protocol.ts`
  `MIN_DAEMON_VERSION` to the matching daemon release in the same change.
  Current protocol is v4 and current minimum is `2.4.0`; unknown/unsupported versions receive
  `needsUpdate` and no delivery. Protocol mismatch is HTTP 426.
- `route.ts classify(argv, env)` is the pure routing source. A run token wins first;
  inside a run only `report` is accepted. Outside a run, bare `pievo` is machine home.
  Daemon lifecycle exists only under `daemon start|stop|restart|status`.
- `daemon start` is detached/idempotent by default; foreground accepts initial
  connection flags. The detached token travels in env, never argv. The pid file records
  pid + process start time. `restart` uses the installed version and preserved config;
  npm alone performs upgrades.
- The PATH shim is written only from durable installs, never overwrites a foreign
  `pievo`, and falls back to `~/.local/bin`. Tests touching daemon lifecycle must inject
  `ensureBinShim`; otherwise they can write the real home directory.
- `cli-client.ts` is the shared device/run transport and only posts to
  `/api/machine/cli`. The daemon is a text sink for server-rendered TOON and retains
  structured `loops`/`runs` only for local resolution and JSON history. Missing `text`
  is an invalid server response; there is no endpoint fallback.
- No coding-agent session-start hook is installed. Normal sessions discover Pievo via
  explicit `pievo` or the user-scope skill; runtime delivery is self-contained.

## Web UI and skill

- Team scope lives in `/t/$teamId`; the cookie is only the bare-`/` redirect hint.
  Mount `DashboardView` keyed by team ID so a same-route team switch reseeds state.
- Loop and run details are pages, not modals. Never render Base UI dialog parts without
  a `Dialog.Root` ancestor.
- Background refresh is fetch-then-set and retains stale data on transient errors;
  do not replace it with route invalidation. Run detail polls every 3 seconds while
  queued/running/reconciling. Provider tool activity is intentionally absent.
- Keep page-level horizontal overflow impossible: `min-w-0` on flex/grid children and
  local `overflow-x-auto` for diffs/tables.
- Status colors are semantic: `keep` green, `no-change` gray, `block` yellow, execution
  error red. Keep lifecycle controls, machine presence, report/final output, provider
  diagnostics, artifact viewer, and run diffs. Do not add aggregate status widgets.
- HTML artifacts render only in `sandbox="allow-scripts"` without
  `allow-same-origin`. Images, including SVG, use the hardened inline route; never put
  synced SVG/HTML directly in the app DOM. Default byte serving is attachment; known
  images may be inline with `nosniff` and sandbox CSP.
- Vite intercepts asset-extension URLs before the SSR artifact route, so direct image
  serving must be tested against a Nitro production build. Markdown uses the server fn
  and is unaffected.

Public skill source is exactly `skill/SKILL.md` plus
`references/{connect,create,update}.md`. `bootstrap.md` is server-only first contact.
`daemon/scripts/sync-skill.mjs` must remain an exact selective whitelist—never recurse.
The daemon best-effort installs the bundled skill at user scope for Claude Code and
Codex during `daemon start` and after `new`; installation failure must never block.
Runtime agents do not depend on the installed skill because delivery contains the full
report contract. Markdown imported with `?raw` requires a server rebuild/deploy.

## Releases

- `server-v*` publishes only `@kky42/pievo-server` through npm OIDC. Tag and package
  version must match. CI runs workspace typecheck/tests, strict build, and package
  verification. Keep `.output`, public files, PGlite assets, migrations, launcher
  scripts, `files`/`bin`, and repository provenance metadata in the package.
- `v*` publishes only `@kky42/pievo` through npm OIDC. Do not add `registry-url` or an
  `NPM_TOKEN`; npm 11 trusted publishing and the package repository object are
  required for provenance. pnpm version comes only from root `packageManager`.
- Public connection prose installs `@latest`; source/dev servers use `PIEVO_CLI`
  verbatim and must not add a global-install step.

## Maintaining this file

Record only durable architecture, release, security, and sharp-edge knowledge useful to
most sessions. Delete obsolete guidance instead of appending a correction. Keep English
prose tight and point to the owning module or test whenever the code is clearer.
