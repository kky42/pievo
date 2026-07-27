# Server agent notes

Package: `@kky42/pievo-server`. Read the repository-level [`AGENTS.md`](../../AGENTS.md)
first. This file keeps server-specific interfaces and sharp edges; do not duplicate
ordinary code structure here.

## Runtime shape

One TanStack Start/Nitro process owns:

- the web UI and server functions;
- the in-process `Scheduler`;
- `MachineGateway` for poll/report/sweep/retention and owner methods;
- `CliGateway` for device-vs-run credential dispatch;
- `ArtifactSync` for exact manifest/blob ingress;
- one Drizzle database and one shared `BlobStore`.

`server/boot.ts` constructs the blob adapter once and passes the same instance to
`MachineGateway` and `ArtifactSync`. This is required for memory-test adapters and keeps
sync, reads, and GC on the same byte store. `ensureServer()` caches the in-flight boot
promise on `globalThis`; do not create a second scheduler in another entry point.

Import direction is `gateway/index.ts` core → satellite helpers, with generic wire
plumbing in leaf `gateway/http.ts`. Keep `gateway/layout.test.ts` green when moving seams.
Route files should dynamically import server-only/native dependencies inside handlers.

## Canonical configuration

`gateway/loopConfig.ts` owns the only current create/edit grammar:

```ts
{
  name,
  schedule:
    | { mode: "cron", cron, timezone, overlap: "skip" | "queue-one" }
    | { mode: "continuous", delayMinutes },
  workdir,
  agent,
  model,
  reasoningEffort,
  prompt,
  statusDefinitions: { keep, noChange, block },
  artifacts,
  enabled,
}
```

New loops require every field except provider settings, artifacts, and enabled.
Provider settings are arbitrary strings; `null` delegates to the selected CLI. Prompt
and status definition whitespace is preserved after non-empty/NUL/size validation.
Artifacts are an optional array of unique exact relative paths. Unknown keys and mixed
schedule shapes are 400s. Web `patchLoop` and machine `editLoop` both reuse this validator.

DB cadence columns are internal. Continuous rows use a harmless cron placeholder so
one internal non-null cadence column can serve both modes; never expose it as a second
schedule. Retired product columns and run roles do not exist.

## Schedule and queue transactions

`db/store.ts` is the authority. All same-loop decisions lock the loop row.

- `createLoop`: enabled cron gets its next future occurrence; enabled continuous is due
  immediately; disabled gets no cadence facts.
- `advanceDueSchedules`: locks and rechecks due facts, coalesces at most one pending run,
  and advances cron strictly after `at`. A cron occurrence with an open run obeys
  `cronOverlap`; continuous skips materialization while open. One-shot and recurring
  facts due together coalesce.
- `claimReadyRunForMachine`: locks the machine, selects one FIFO pending ordinary run,
  locks loop/run, rechecks exclusion, assigns `runIndex`, captures provider settings,
  transitions to running, and inserts the hashed active lease in one transaction.
- `terminalLifecycleTx`: restores continuous cadence only for done/error, atomically
  pauses on `block`, and applies the consecutive-error breaker. Pending system rows are
  canceled on automatic pause.
- `updateLoopTx`: owns pause/start/schedule-edit cadence changes and tombstones removed
  artifact config paths. Do not reproduce these rules in a gateway or server fn.

Partial unique indexes enforce one pending and one running row per loop. Timers are
hints; scheduler startup and every poll converge on persisted due facts. There is no
historical occurrence reconstruction.

Owner lifecycle meanings:

- Pause: disable cadence, clear schedule facts, cancel pending system work; running and
  owner-requested work survive.
- Start: clear pause cause and re-arm the existing schedule.
- Stop: Pause + cancel every pending row + set current-run cancellation intent.
- Delete: set the durable delete marker, Stop, then delete once open work/authority is
  gone. Force delete is team-owner-only, retires authority, and logs the destructive
  uncertainty. It never touches machine-local files.

`pauseCause` is only an annotation (`owner`, `blocked`, or `failure-streak`), not a
separate lifecycle state. Timeout reclaim does not pass the breaker threshold while its
result can still reconcile.

## Poll, lease, and terminal report protocol

Current daemon protocol is 4; `gateway/protocol.ts` requires daemon `2.4.0`. Unknown or
unsupported package versions get `needsUpdate` and no delivery; protocol mismatch gets
426. For any breaking daemon-produced payload or behavior, bump `MIN_DAEMON_VERSION`
to the matching package in the same change and update pinned fixtures/UI copy.

Idle `pollV4Wait()` parks for at most 20 seconds on a process-local per-machine waiter.
Active/reporting polls never park. Each successful poll may claim one run, so repeated
polls permit cross-loop concurrency. `currentRuns` updates provider-neutral liveness;
`daemonInstanceId + recoveryComplete` is the authoritative startup recovery snapshot.

Leases are durable in `run_leases`, keyed by SHA-256 of the full `rk_…` wire token:

- `active` authorizes the once-only callback and terminal payload;
- inactivity reclaim moves it to blocking `terminal-grace` for 24 hours;
- an absent run in a completed daemon snapshot becomes `reconciliation-only`, allowing
  successor work while retaining one late report;
- expiry becomes non-authorizing `retired`, consumed only with the matching durable 410.

Normal finalize and one reconciliation consume authority in the same loop-lock
transaction as run/loop writes and report receipt. A report-only reconciliation changes
only the historical run/receipt. Loop deletion preserves retired evidence. Startup
`repairTerminalRunLeases()` repairs active leases attached to terminal rows.

The callback records `{status,message}` exactly once through `recordRunReportOnce`.
Only `keep|no-change|block` and a non-empty message are accepted. A successful provider
terminal without both becomes an error.

`/machine/report` is idempotent by report ID and exact payload evidence. Its JSON object
has one exact top-level allowlist; every present optional diagnostic is type-checked,
and `usage` is an exact-key object of bounded non-negative integer token counts. A
correlatable semantic failure becomes a durable `reportIncident`, exact-digest handled
200 ACK, and run error (or diagnostics-only rejection for a prior reconciliation
outcome), all in one transaction. Never turn these into mutation-free retries that
occupy a daemon slot. Per-report-ID advisory locking serializes receipt races across
loop locks.

## CLI dispatch

`POST /api/machine/cli` branches on credential type before verb:

- `dk_` device credential: `new`, `loops`, `edit`, `pause`, `start`, `stop`, `delete`,
  `run stop`, `log`, `show`, and `home`; `report` is 403.
- `rk_` run lease: only `report` and help; owner/read/control verbs are forbidden.

The run-token restriction is defense in depth with daemon callback routing. Do not add
run-scoped reads or loop mutation verbs.

`gateway/toon.ts` is the pure TOON serializer. `/api/machine/cli` finalization retains
only `{text,exitCode,loops,runs}`: text is the render, while loops/runs are data channels
for cwd resolution and JSON history. Missing `text` is an invalid server response. No
endpoint aliases or daemon fallback transport exist.

`show --json` emits `id` plus the exact editable envelope. `log` is bounded by row,
response, detail-text, diff-file, diff-input, and emitted-diff caps in
`gateway/history.ts`. History exposes report, error, and final assistant output as
separate facts; token totals exclude cache fields from the displayed total while raw
normalized usage remains stored.

## Exact artifact ingress

`ArtifactSync.sync()` requires a registered device token and loop-machine match. Its
only POST envelope is `{loopId,manifest}`; both the top level and each complete manifest
item are exact, strictly typed schemas. It accepts only paths literally present in the
loop's current `artifacts` array. The daemon sends the full existing-file manifest after
provider exit; absence tombstones prior live rows. Validation completes before writes.
Store helpers lock/recheck the current allowlist so an edit racing sync cannot revive a
removed path or tombstone a newly added one.

Security and durability constraints:

- `POST /api/machine/sync`: 32 MB body cap.
- blob bytes: 10 MB per-file cap; larger files are metadata-only.
- verified SHA-256 for every blob PUT.
- PUT accepts only a hash referenced by a live configured artifact on this machine.
- metadata and byte presence are separate; missing byte objects are requested again.
- there is intentionally no aggregate per-loop byte cap or filename/content filter.

Do not add directory traversal, recursive scanning, or secret-name policy. The daemon
is responsible for realpath confinement; the server also validates relative wire paths
and the exact config allowlist.

Snapshots are captured after terminal sync and keyed by run. `runDiff.ts` computes
text diffs lazily with a 512 KB per-side file guard plus caller budgets; server diffing
is pure string computation and preserves zero-exec. Snapshot retention defaults to 20.
GC uses a one-hour grace period, fresh reference rechecks, and bytes-before-metadata
delete ordering. Bias toward keeping a leaked blob rather than deleting live bytes.

`createBlobStore()` selection:

- explicit `local`: `<PIEVO_DATA_DIR>/blobs`;
- explicit `r2`: requires complete `PIEVO_R2_*`;
- explicit `memory`: loud ephemeral/data-loss warning;
- absent selector: complete R2 config, else local. Partial R2 config fails boot.

## Artifact serving and browser containment

`routes/api.artifact.$loopId.$.ts` uses the same session/team authorization as server
functions and returns flat 404 across scope. Default disposition is attachment. Only
known image extensions may use `?view=inline`, with the real allowlisted MIME,
`X-Content-Type-Options: nosniff`, and `Content-Security-Policy: sandbox`.

The browser viewer:

- HTML uses `srcDoc` in `sandbox="allow-scripts"` **without** `allow-same-origin`;
- images, including SVG, use the hardened image URL and are never inserted as markup;
- Markdown uses the sanitized shared pipeline;
- binary files download; oversize files have no bytes.

Vite's static layer intercepts asset-extension routes in development. Verify image
serving against a Nitro production build (`pnpm build && pnpm start`, bind with `PORT`).
Markdown byte reads use a server function and are unaffected.

## Auth, teams, and machine enrollment

`lib/loginGate.ts` is the one lightweight gate condition: both GitHub OAuth values must
exist. `auth.ts` throws at module load if the gate is on without
`PIEVO_AUTH_SECRET`. Empty `PIEVO_ALLOWED_LOGINS` means every GitHub account may sign
in; entries may be exact emails or domain wildcards. Gate off means one open shared
workspace.

`requestScope(explicitTeam?)` gives the URL team precedence over the last-used cookie,
membership-validates either, and otherwise selects the personal team. `canAccessLoop`
authorizes a direct loop link against that loop's team even when another team is active.
A denied team/loop/artifact is indistinguishable from not found.

Machine plaintext device tokens are owner-only under auth; teammates may see a
membership-visible machine but receive `token:null`. Poll is the sole self-enrollment
surface. Gate on requires a live 24-hour connect-key row; gate off permits anonymous
well-shaped tokens. Existing machines recheck the full token hash.

A connect key is indexed by derived machine ID, not stored plaintext. It binds minter
and team across deploys. Create rechecks machine ownership and live team membership.
Machine home team remains its owner's personal team; each loop lands in the validated
claim team. One machine can serve every team its owner belongs to.

Team rules live in framework-free `server/teamAdmin.ts`; `teamFns.ts` is a thin RPC
wrapper. Management is owner-only, direct-add requires an existing account, invite
links are single-use for seven days, last-owner removal/demotion is transactionally
blocked, personal teams cannot be left/deleted, and deletion is blocked while loops
exist. Invites never bypass the login allowlist because redemption requires sign-in.

## Rate and wire boundaries

`readJsonBody()` caps ordinary machine JSON at 2 MB before parsing. Sync has its own
32 MB cap; blob PUT is bounded by the route and 10 MB ingress check.

Every machine route except sync/blob calls `machineRouteLimit()` before gateway work:
per-IP and per-token in-process buckets, bounded key maps, 429 when spent. Defaults are
240 burst + 8/s per IP and 120 burst + 4/s per token. Rate limiting defaults off in
tests, on elsewhere, and is tunable with `PIEVO_RL_*` / `PIEVO_RATE_LIMIT`.

Byte ingress is entirely exempt from token buckets. It is not anonymous: unknown device
tokens are 401, and exact path/hash authorization plus body/file caps bound accepted
writes. Do not cite a nonexistent aggregate storage cap as its guard.

Client IP order is `Fly-Client-IP`, first `X-Forwarded-For`, `X-Real-IP`, then one
shared `unknown` bucket. This assumes the deployment edge overwrites/trusts those
headers; add network-layer controls when exposing the service directly.

## Database and migrations

Driver selection in `db/index.ts`:

- `DATABASE_URL` set: postgres-js. Transaction pooler detection uses `:6543` unless
  `PIEVO_DB_POOL_MODE` overrides; transaction mode disables prepared statements.
- unset: file-backed PGlite at `<PIEVO_DATA_DIR>/pgdata`. Production requires
  `PIEVO_DB=pglite`; tests/dev do not.

Hosted migrations run out-of-process in `scripts/prestart.mjs` through
`DIRECT_DATABASE_URL` (or a safe non-pooler runtime URL). PGlite migrations run
in-process at boot. `db:migrate` is for a configured real Postgres only.

The project targets fresh deployments. `drizzle/0000_baseline.sql` and the single
journal entry must match `db/schema.ts`; no prior SQL, data transforms, migration
fixtures, or generated snapshots are retained. Verify both fresh PGlite boot and the
Postgres-dialect baseline. Drizzle `text(...,{enum})` is TypeScript-only and creates no
DB CHECK.

The external-Postgres watchdog is on by default outside tests and exits after sustained
timed-out `select 1` probes. Fly health checks only de-route; the watchdog is what lets
an on-failure supervisor recover a wedged pool.

## Published launcher and deployment

`@kky42/pievo-server` ships Nitro output, copied PGlite assets, the baseline migration,
and `scripts/{pievo-server,server-cli-lib,prestart}.mjs`. Runtime paths are
resolved from the installed package root, never cwd.

Launcher invariants:

- detached/idempotent start; foreground for containers/supervisors;
- local defaults `127.0.0.1:3000`, data/pid/lock/log under `PIEVO_DATA_DIR`;
- no `DATABASE_URL` injects `PIEVO_DB=pglite` for this local launcher path;
- lifecycle lock spans detached readiness;
- `starting` pid authority is recorded before async prestart;
- authority is pid + process start time + launch nonce;
- `/api/ready` waits for full boot and echoes the nonce;
- stop clears records only after exact-process death is proven;
- restart selects by data dir and preserves bind unless explicitly overridden.

Production `pnpm start` and Docker always run prestart. Without external Postgres they
require the explicit PGlite opt-in and persistent data directory. Run one process only.
The included Fly files are unconfigured single-process examples; workflows are manual
and fail preflight without explicit app/origin/token settings.

`publish-server.yml` uses npm OIDC on `server-v*`. Keep tag/version identity, npm 11,
no token-based registry config, workspace tests/typecheck, strict PGlite asset build,
package verification, repository provenance, and package `bin`/`files` intact.

## Web UI rules

- Team is in `/t/$teamId`; bare `/` is open mode or gated redirect. Keep
  `DashboardView key={teamId}` for same-route remount semantics.
- Dashboard and detail refreshes are fetch-then-set; transient failures keep stale data.
- Loop and run detail are standalone pages. Base UI dialog parts require a root.
- Keep `min-w-0` through flex/grid boundaries and put horizontal scrolling inside the
  owning diff/table pane, never on the page.
- The loop form mirrors only the canonical config union. Loop detail shows lifecycle,
  machine presence, complete stored config, exact artifacts, and runs. Run detail keeps
  report, error, final assistant output, session ID, token usage, incident, and diff
  distinct.
- Semantic status colors: keep green, no-change gray, block yellow, execution error red.
  Do not add aggregate status visualization in this iteration.

## Skill surface

Source of truth:

- `src/skill/bootstrap.md`: server-only first-contact flow at `/api/bootstrap`;
- `src/skill/SKILL.md` and `references/{connect,create,update}.md`: public owner skill;
- no runtime prose file: `gateway/prompt.ts` assembles the complete report contract.

`daemon/scripts/sync-skill.mjs` must copy exactly those four public files. Never make it
recursive. The three references are also served from the exact static route map.
`?raw` imports compile Markdown into the server bundle, so prose changes require a new
build/deployment. Skill installation is best-effort and cannot be a runtime dependency.

## Maintenance

Keep this file about durable server-specific invariants. If code changes make a note
false, rewrite or remove it in the same change. Prefer module/test pointers over batch
history or duplicated implementation detail.
