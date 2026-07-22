# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Published server launcher

- `@kky42/pievo-server` ships `.output`, source and bundled migrations, copied pglite
  assets, and `scripts/{pievo-server,server-cli-lib,prestart}.mjs`. The global binary
  resolves all runtime paths from its installed package root, never cwd, and launches
  Nitro `.output/server/index.mjs` only. `start` is detached/idempotent;
  `start --foreground` is the supervisor/container path; `restart` never updates npm.
- CLI-local defaults are `127.0.0.1:3000`, `<PIEVO_DATA_DIR>/server.pid`, and
  `<PIEVO_DATA_DIR>/server.log`. With no `DATABASE_URL`, the CLI injects
  `PIEVO_DB=pglite`, then always runs `scripts/prestart.mjs`. The starting process is
  recorded before the async prestart child runs; PID authority requires pid + process
  start time, and uncertain identity is never signaled/cleared. One per-data-dir
  lifecycle lock spans detached readiness. `/api/ready` awaits `ensureServer()` and
  echoes a random launch nonce, so shallow health or another port owner cannot satisfy
  startup. Signal cleanup aborts Pievo internals but leaves HTTP draining to Nitro.
  `restart --data-dir` selects the instance and preserves its recorded host/port unless
  a bind flag/env overrides them. Existing `pnpm start` and Docker startup are unchanged.
- Blob selection remains one adapter instance from `boot.ts`: absent selector uses
  complete R2 config when present, otherwise fixed `<PIEVO_DATA_DIR>/blobs`; partial
  R2 config fails loud. `local|r2|memory` are explicit selectors. Memory is accepted
  by the production launcher only as an explicit ephemeral opt-in, emits a loud
  data-loss warning, and is never selected as fallback.

## axi-conformance CLI (`gateway/toon.ts` — the TOON spine, batch 1)

- `gateway/toon.ts` is a PURE, dependency-free TOON serializer (no I/O, no clock):
  `scalar`/`quote`/`needsQuote`, `detailBlock`, `countLine`, `listBlock`,
  `emptyList`, `inlineArray`, `helpBlock`, `errorBlock`/`codeForStatus`, `truncate`,
  `doc`. Unit-tested in isolation (`toon.test.ts`). Quoting rule mirrors gh-axi:
  a value is bare unless empty or it carries whitespace/comma/colon/quote. The
  absent-value placeholder is a bare em-dash `—` (`ABSENT`); truncation hints and
  `classification:`/`finished:` lines DELIBERATELY use `—` to match the axi reference
  shapes verbatim (the one place em-dashes are intentional in this repo).
- **Superset body (batch 1, RETIRED in batch 7)**: batch 1 had every `/api/machine/cli`
  verb return its axi TOON in a `text` field (+ `exitCode`) ALONGSIDE its structured JSON
  fields, so the 0.11 daemon could keep rendering structured while `text` shipped
  server-first with no daemon release. `renderLoopLog`/`listLoops`/`createLoop`/`editLoop`
  add `text` at the source (so the legacy routes benefit too); `finalizeCli` (wraps
  `cli()`) fills `text` from a structured `{error}` and ensures `exitCode`. **Batch 7
  retired the superset**: `finalizeCli` now STRIPS the cli body to `{text, exitCode,
  loops, runs}` (the daemon is a pure text sink) — see the batch-7 section below. The
  legacy endpoints skip `finalizeCli`, so their full structured bodies are unchanged.
- **F2** (in-run `pievo log` printed nothing): fixed for free by `renderLoopLog`
  gaining `text` — the in-run callback already prints `body.text`. Proven at the
  callback boundary by `daemon/src/callback.test.ts` (a stub server returning the new
  body, asserting non-empty stdout — that test changes NO daemon source).
- **F5** (fail-loud): `dispatch` `report` requires `kept|no-change|blocked` plus a
  non-empty message. Exec runs with a metric schema also require `--metrics` with
  exactly every declared key; edit/evolve runs reject metrics.
- All dispatch errors render via `derr(code, message, slug?)` → `errorBlock` (slug
  defaults from HTTP status).

## axi-conformance CLI (batch 4 — per-verb `--help`, in-run help TOON, F4)

- **F4 naming**: `applyMutation` reschedule reads `str("run-at") ?? str("next")` —
  `--run-at` is canonical (matches the `runAt` edit key + all help text), `--next`
  stays a working back-compat alias. This closed the shipped drift where the help
  documented `--run-at` but the code only read `--next` (following the help failed).
- **In-run `help`** (`helpText`) renders the §4.9 TOON: a `verbs:` top key with
  grouped typed lists (`always[3]`, `schedule[4]`) + `dashboard/gate:`
  lines, each carrying an availability TAG that flips with the lease caps (exec vs
  evolve/edit: `evolve/edit pass only — this run is "exec"` ↔ `available to this run`;
  schedule tag gates on `allowControl`), then a trailing `help[]`. The schedule list
  header carries its tag AFTER the `{…}:` (a list-header-with-tag, hand-built since
  `listBlock` emits a bare header); groups are nested under `verbs:` via `indent()`.
- **Per-verb `--help`** (P10): `<verb> --help` returns `verb:`/`syntax:`/`summary:`
  (+ role-aware `availability:` for a run) + a short `help[]`, via `verbHelpText(verb,
  lease?)` over two spec maps — `RUN_VERB_HELP` (lease present ⇒ role-aware) and
  `DEVICE_VERB_HELP` (owner surface, no availability line; `new`/`edit` summaries list
  `EDITABLE_LOOP_FIELDS` so schemas are discoverable without failing). Help is
  intercepted in THREE places: `deviceCli` + `runCli` (unified CLI,
  after the DEVICE_ONLY/loop-fence checks so an owner-only verb still 403s on a run
  credential, never leaks help) and at the top of `dispatch` (the legacy
  `/agent-api/loop` transport). An unknown verb has no spec → `verbHelpText` returns
  undefined and the caller falls through to its unknown-command 400 (device) / 400
  (run dispatch). Availability values are multi-word ⇒ TOON-quoted (`availability:
  "available to this run"`); inner `"exec"` quotes escape inside the quoted value.

## axi-conformance CLI — `show` full editable envelope (batch 2)

- **`show` emits the FULL editable envelope** keyed EXACTLY as `edit --json` accepts
  (`loopEnvelope(loop)`: id + every `EDITABLE_LOOP_FIELDS` key — name, cron, timezone,
  notify, model, reasoningEffort, agent, allowControl, taskFile, enabled, runAt,
  goal, ui, metricSchema) PLUS the derived read-only aggregates `nextFire`/`lifecycle`/`runs`.
  `renderShowText` is the pure TOON renderer; `describe(loopId, {allowControl,
  full})` wraps it with the loop lookup + runs tally. Large fields (`ui`)
  render as `present, N bytes — use --full to see` (or `absent`); `metricSchema` renders
  STRUCTURALLY (`[N]{key,label,unit}:` rows); `--full` inlines complete bodies (scalar-
  quoted, newlines escaped). A RUN credential adds the effective `selfSchedule`
  line + run help; a DEVICE credential gets owner help (edit/log).
- **Naming (F4):** the writable pinned override is `runAt` (the edit key; the DB column
  stays `nextRunAt`); the derived cron fire is the read-only `nextFire` (formatted in the
  loop's own tz via Intl, `nextFireDisplay`). The old wire display name `nextRunAt`
  retired. Both `runAt` and `nextFire` appear in `show`, distinct.
- **`show --json`** emits the envelope with COMPLETE bodies (no truncation) — body
  `{ok, loop: <env>, text: JSON.stringify(env)}`, served by the device `show` handler
  and a runCli `show --json` special-case (dispatch returns text-only, so `--json` can't
  ride the TOON path). Derived aggregates are NOT in the `--json` envelope (only the 14
  editable keys + id), so dropping `id` yields a clean no-op `edit` patch.
- **Read/write identity is REAL, pinned by the roundtrip test:** `show --json` minus
  `id` fed to `edit --dry-run` reports zero changes. Two `buildEditUpdate` changes make
  this hold: (1) `set()` still writes to `update` but only RECORDS a change when the
  value actually differs (`sameLoopValue`, structural, null≡undefined) — so an all-no-op
  patch is a harmless idempotent re-apply (still 200, not "nothing to change"), while the
  dry-run preview shows zero changes; (2) `runAt`/`ui`/`metricSchema` accept
  `null` as an explicit clear (symmetric with `goal:null`), which is what `show --json`
  re-feeds for an unset field — a no-op when already null.

## axi-conformance CLI (batch 3 — list/create aggregates, edit no-op, `new` idempotency)

- **`loops` `--fields`**: default columns are the minimal `{id,name,cron,enabled,nextFire}`
  (`LIST_DEFAULT_FIELDS`); `--fields` EXTENDS them from the optional set
  `LIST_OPTIONAL_FIELDS` = `{timezone,notify,model,reasoningEffort,goal,taskFile,runs,lastOutcome}`
  (request order, deduped, never re-listing a default). An unknown field — including
  a DEFAULT column requested as an extra — fails loud: 400 `VALIDATION_ERROR`,
  `unknown field(s): … — available: <optional set>`, exit 1. `listLoops(deviceToken,
  fieldsFlag?)` computes per-loop `nextFire` (derived cron fire in the loop's tz, `—`
  when paused), `runs` (`countRuns`), and `lastOutcome` (`runOutcomeToken` of the
  newest run). The structured `loops` body carries the WHOLE `LoopListRecord` — a
  RETAINED data channel (`CLI_RETAINED_KEYS`, batch 7) the daemon reads to resolve
  cwd→loop client-side, not for rendering; `renderLoopsText(records, fields)` picks
  columns via `loopCell` into the `text` the daemon prints.
- **`new` idempotency (F8, OQ3)**: the daemon (`create.ts`) computes
  `idempotencyKey = sha256(machineId + canonicalJson(resolvedBody))` over the ENTIRE
  outgoing request body (config + `timezone` + `claim`/connect-key + `agent`) MINUS the
  `idempotencyKey` nonce itself — `machineId` derived from the device token by the SAME
  frozen `m-sha256(tok)[:16]` scheme. Hashing the full resolved body (not a cherry-picked
  subset) closes the whole envelope-collision class: a genuine retry has identical
  argv+env ⇒ identical body ⇒ same key (still dedupes), while ANY envelope difference —
  a different `--tz`, `--connect-key`/team, `--agent`, or config field — yields a DISTINCT
  key so genuinely-different creates never collide. Deliberate, documented deviation from
  the literal §8.1 "config-without-nonce" wording (intent: collapse exactly the retry
  case). Sent on REAL creates only (a dry-run creates nothing). Server keeps an in-memory `newIdempotency` map
  (`tokens.ts`, 15-min TTL `NEW_IDEMPOTENCY_TTL_MS`, pruned on write like
  `claimIntents`); `readNewIdempotency(key, machineId)` also rechecks the record's
  machineId (a cross-machine key never replays another machine's loop) and
  `createLoop` rechecks the loop still exists + belongs to the machine before
  replaying. A live-key hit returns the existing loop with `idempotent:true` + the
  §4.5 replay TOON (`renderReplayText`), never a twin; an absent key ⇒ no dedupe (old
  daemons keep working). The replay body ALSO echoes `ui: existing.ui != null` (like the
  real-create + dry-run branches) so the daemon's `dashboard ui: applied|not applied`
  line stays factually accurate on a timed-out retry of a create that DID apply a
  dashboard. The check sits AFTER validation and the dry-run branch, and
  the create is recorded only on success. Additive body field: old servers ignore it.
- **`edit --json '{}'`** is now a VALID no-op (feedback #3): status 200, exit 0,
  `nothing to change:` + the editable-key list (`renderEditNoopText`), not the old
  bare-usage 400. **`edit --dry-run`** with a rejection now signals **exit 1** via an
  explicit `body.exitCode` (HTTP stays 200 with the rich changes/rejections tables —
  `finalizeCli` leaves a pre-set `exitCode` alone).

## axi-conformance CLI (batch 5 — skill/prose alignment)

- Batch 5 is PROSE/markdown + the demo script ONLY (no gateway/daemon source): it
  aligns the `?raw`-bundled public skill (`skill/references/{run,evolve}.md`) with the
  TOON surface batches 1-4 shipped. `run.md` already carried the camelCase
  `selfFinish`/`selfSchedule` show keys (batch 2 #75 did that); batch 5 only adds the
  "`--run-at` is canonical; `--next` is a back-compat alias" note to the reschedule
  lever (F4). `evolve.md`'s "reading the log" survey now names the shipped
  `renderLogText` header verbatim — `runs[N]{ts,role,outcome,metrics,session,message}`
  + the `summary:` tally — and clarifies that `pievo log`'s `metrics` column shows
  `key=value` while the task-message inline table is metric-KEYS-only. `exec-core.md`
  and `run/edit.md` were verified conformant and left untouched.
- **When you change the `pievo log` TOON columns (`renderLogText`) you MUST update
  `evolve.md`'s survey prose** — the pair is pinned by `-api.skill.references.test.ts`
  ("evolve.md log survey names the shipped TOON columns"), which substring-matches the
  exact header + `summary:` + the `key=value` phrasing. That serving test is the
  lightweight guard for this batch (it also pins run.md's `--run-at`/`--next` note and
  that the retired kebab `self-schedule:` display key never reappears).
- `scripts/demo-cookie-unified.sh` create body used a stale `task:` field; `createLoop`
  dropped the `task` column (batch 2) and 400s without `taskFile`, so the
  demo was actually broken — batch 5 renames it to `taskFile` (review F7).
- These `.md` edits compile into the server bundle via `?raw`, so this batch DEPLOYS
  server-side AND rides the next `@kky42/pievo` npm tarball for the installed skill
  (`sync-skill.mjs` whitelist is untouched — still SKILL.md + the 4 references).

## axi-conformance CLI (batch 6 — daemon text sink + content-first home)

- **Server `home` verb** (`gateway/cli.ts`): bare `pievo` posts `["home", …ctx]`.
  DEVICE branch (`homeDevice`) is handled in `deviceCli` BEFORE the unknown-machine 401
  guard, so an unregistered machine renders the DEFINITIVE `machine: not connected — run
  \`pievo daemon start\`` state (never a 401/empty, P5/P8). A registered machine → `machinePresence`
  (`lib/machinePresence.ts`) line + cwd-scoped loop list + `recentMachineRuns` across the
  machine + help. RUN branch (`homeRun`, in `runCli` before the read branch) → the lease's
  OWN loop context (`renderRunHomeText`: identity + role + goal + recent), scoped to
  `lease.loopId`. Both render via pure helpers (`renderHomeText`/`renderRunHomeText`).
- **Text-sink render is server-side; local facts ride as flags.** The daemon can't have
  the server render `bin:`/`daemon pid`/cwd-scoping, so it passes them as `home` argv
  flags: `--bin`/`--pid`/`--server` (header) + `--cwd`/`--home` (scoping). `scopeLoopsByCwd`
  replicates the daemon's `resolveLoopDir` (dirname(taskFile)→workdir, tilde-expanded
  against the passed `--home` since the SERVER's home is irrelevant) to split loops into
  "here" vs an `elsewhere` count; no cwd (or none matching) ⇒ ALL loops are "here". This
  is the one place `gateway/cli.ts` imports `node:path` (pure, no I/O).
- **Daemon is a text sink** (`packages/daemon/src`): every server-verb path PRINTS
  `body.text`+`body.exitCode` via the shared `cli-client.ts`. Batch 6 had `printText`
  return null on a text-less OLD server for a one-release structured fallback; **batch 7
  retired that fallback** — `printTextOrTooOld` now prints a definitive `SERVER_TOO_OLD`
  error instead (the render-only `printLoops`/`printEditDryRun`/`printCreateDryRun`/
  `formatRun`-fallback were deleted; `home` prints a definitive `tooOldHome` exit 0). See
  the batch-7 section below. `--json` (log/show) stays the structured-data escape hatch.
  Converged on
  `callback`/`interactive`/`log`/`create`/`show`/`home`.
- **Routing lives in the pure `route.ts` `classify(argv, env)`** (unit-tested; `cli.ts`
  maps a `Route` to its lazily-imported handler). The Batch-6 behavior change (OQ1): bare
  `pievo` = the content-first HOME (device out-of-run; in-run bare posts `home` on the
  run cred). Lifecycle exists only under `pievo daemon start|stop|restart|status`;
  detached re-exec uses `daemon start --foreground` and keeps the token env-only.
  Top-level `up|down|status|doctor|update`, raw lifecycle flags, `--api-key`, and
  `finish|complete` are unknown. `report` outside a run is forwarded to the server
  (device cred → the crafted run-only 403, F3). `pievo show` out-of-run resolves the loop client-side (like
  `log`, reusing `log.ts` `resolveLoopId`) then forwards.
- **No coding-agent SessionStart hook.** Pievo does not inject home into unrelated
  Claude Code/Codex sessions. Ordinary sessions discover it through the user-scope skill
  or explicit `pievo`; daemon edit/evolve/exec runs use the self-sufficient server-delivered
  first user turn. `daemon start` and `new` refresh the skill + PATH shim. Home still uses a
  bounded fetch (`HOME_TIMEOUT_MS`) so explicit interactive use degrades quickly.
- **PATH shim** (`bin-shim.ts`, feedback #4): `pievo daemon start`/`new` write a `pievo`
  re-exec wrapper (same launcher-replay as `callback-bin.ts`) to the npm global bin
  (`npm_config_prefix`) else `~/.local/bin`, with one-line PATH guidance when the dir
  isn't on PATH. `home` reports the shim as `bin:` via `existingBinShim`. HARDENED so
  the durable shim is never fragile/destructive: it lands ONLY from a durable install
  (`isEphemeralEntry` skips an npx/npm-cache `/_npx/`,`/_cacache/` re-exec entry, with
  `npm install -g @kky42/pievo@latest` guidance) and NEVER clobbers a foreign `pievo` (only refreshes our own
  shim, detected by the `SHIM_MARKER` prefix); `ensureBinShim` returns
  `{path,onPath,written}` so callers/tests can assert skipped-vs-written.
- **TEST HAZARD**: `ensureBinShim` writes the REAL `~/.local/bin` if not injected.
  `daemon-lifecycle.test.ts`'s `seams()` MUST no-op it (it does); bin-shim tests inject
  fs/env seams and never touch the real home.

## axi-conformance CLI (prod-E2E fixes — gate for batch 7)

Conformance/polish fixes from the 0.12.0 production E2E (`e2e-axi-prod-v1`). Split
server (deploys) vs daemon (rides the NEXT `@kky42/pievo` npm release):
- **`loops` flag cluster (F1–F4), ONE root cause: the daemon `interactive.ts` loops
  path HARDCODED `postCli(["loops"])`, dropping every user flag** — the server never
  saw `--fields`/`--json`/unknown flags. Fix is BOTH sides: the daemon now forwards
  `--fields`/`--json` (+ `--help`), rejects an unknown loops flag CLIENT-side (exit 2,
  same as an unknown VERB — exit 2 is a client concern, `route.ts`), and `parseFlags`
  learned the `--k=v` form; the server `listLoops(token, fields?, json?)` gained
  `--json` → `text = JSON.stringify(records)` (real JSON, mirroring `show --json`;
  `--fields` validation was already correct). **`log`/`show` had the lesser variant**
  (they honored known flags but silently IGNORED unknown ones) — now they reject an
  unknown flag client-side too (uniform exit 2). `new`/`edit` already rejected unknowns.
- **NOT_FOUND (F5)**: `log`/`show` resolve the loop id CLIENT-side (`resolveLoopId`,
  `log.ts`), so a nonexistent explicit id never reaches the server. It used to print a
  prose `pievo:` line at exit 2 (a usage failure). Now `resolveLoopId` tags the
  explicit-not-found case `code: "NOT_FOUND"` and the shared `renderResolveError`
  emits `error:`/`code: NOT_FOUND` to STDOUT at exit 1 (message quoted via
  `JSON.stringify`, keeping the actionable "run `pievo loops`" guidance). Other
  resolve failures (no-folder-match, ambiguous) STAY prose/exit-2 usage errors.
- **`bin:` line always (F7, P8)**: the home MUST lead with `bin:`. The daemon `home.ts`
  now resolves the durable bin via `resolveDurableBinPath` (shim OR non-ephemeral PATH
  global, real path) and passes `--bin` when known; the server `renderHomeText` renders
  the honest `bin: (not on PATH — run \`npm install -g @kky42/pievo@latest\`)` fallback when
  `--bin` is absent (both the connected and not-connected branches). The daemon-local
  homes (`notConnectedHome`/`degradedHome`/`fallbackHome`) lead with the same
  `binLine(bin)`.
- **`edit --json '{}'` no-op (F8)**: the SERVER already renders the `nothing to change:`
  + editable-key list (batch 3). The daemon short-circuited an empty patch to the usage
  screen (exit 2) BEFORE the server. Fix: only show usage when NO input flag was given
  (`--json`/`--*-file` absent); an explicit `--json '{}'` forwards → the server no-op.
- **`nextRuns` tz (F9)**: `new`'s `nextRuns` rendered raw unlabeled UTC while `show`'s
  `nextFire` renders loop-tz. New shared `fmtTimeZoned(iso, tz, {seconds?})` (Intl, zone
  label) backs BOTH — `nextFireDisplay` (seconds) and the create/dry-run `nextRuns`
  (minute granularity + zone label).
- **home header (F11)**: the cwd-scoped list block is `loops here[N]` (design §5.1) only
  when there IS an elsewhere count (`elsewhere > 0`); an unscoped full-machine view stays
  the plain `loops[N]`.

## axi-conformance CLI (batch 7 — retire the superset scaffolding)

The final axi batch: the daemon is a PURE text sink, so the transitional "superset" render
fields are retired. Ships server-first (deploys); the daemon changes ride the next
`@kky42/pievo` npm release (0.13.0) with PR #80's daemon fixes.
- **Server strips at the cli boundary.** `finalizeCli` (wraps `cli()` ONLY) now reduces
  every `/api/machine/cli` body to `CLI_RETAINED_KEYS` = `{text, exitCode, loops, runs}`
  after filling `text`/`exitCode` — dropping the render-only `ok`/`id`/`name`/`loop`/
  `loopId`/`changes`/`rejections`/`applied`/`config`/`nextRuns`/`classification`/`ui`/
  `warning`/`idempotent`/`dryRun`. `loops` (client-side cwd→loop resolution) and `runs`
  (`log --json` normalized-data escape hatch) are RETAINED data channels, not scaffolding
  — the daemon reads them as data, and the server's `log`/`show` dispatch needs an explicit
  id (design §3), so resolution must stay client-side. The verb HANDLERS still construct the
  full structured bodies (createLoop/editLoop/listLoops/renderLoopLog) because the LEGACY
  endpoints (`/api/machine/loop|log`, `/agent-api/loop`) call the methods DIRECTLY (not
  through `finalizeCli`) and their bodies are UNCHANGED — a pre-0.12 daemon on the postCli
  404-fallback still renders. `--json` is unaffected: it renders JSON into `text`
  (`show`/`loops`) which the daemon prints verbatim.
- **Daemon has no structured-render fallback.** `cli-client.ts` `printTextOrTooOld` replaces
  the per-verb `printText`-null → `printLoops`/`printEditDryRun`/`printCreateDryRun`/
  `formatRun` fallback: when `text` is ABSENT (a pre-0.12 server) it prints a definitive
  `error:`/`code: SERVER_TOO_OLD` to stdout, exit 1, never blank. `home` is the ONE
  exception — it stays never-empty/never-alarm for interactive use, rendering a
  definitive `tooOldHome` (exit 0). `log --json` reads the retained normalized `runs`.

## Run telemetry

- Poll liveness is provider-neutral: a protocol-v2 daemon sends its one `currentRun` and stage (`executing|reporting`); the machine/phase-scoped update refreshes that run's `heartbeatAt` (claim `ts` is the pre-first-heartbeat fallback). Offline pending notification dedup uses separate `runs.deferredAt`.
- Claim atomically copies `loops.agent` to nullable `runs.agent`, preserving the actual executor as run history even after an owner edits the loop agent. Final reports store normalized `exitCode`, `durationMs`, `sessionId`, `finalText`, `error`, and provider-neutral token `usage`; each run has exactly one provider invocation. `sessionId` is metadata for future use — there is no current resume UI or command generation. Dollar cost, provider activity/progress, slim transcripts, and transcript-derived run artifacts are not stored or rendered. Live artifact sync + `artifact_files`/`blobs`/`run_snapshots` remain the file/diff authority.
- `/machine/report` treats a correlatable but semantically invalid terminal payload as a durable terminal attempt, never a poison retry: after lease auth, `store.rejectTerminalReport` loop-locks, rechecks the hashed lease, writes `runs.reportIncident`, applies the ordinary failure lifecycle (or preserves a terminal-grace outcome), consumes the lease, and inserts the exact 200 ACK in `terminal_report_incidents`. The receipt key is `sha256(reportId + daemon-byte-compatible JSON payload digest)` and survives loop deletion; payload drift after a normal same-run commit replays that authoritative ACK, while rejected attempts replay only on an exact digest and a cross-run reportId conflict terminalizes the currently leased run. Missing/non-string/NUL/over-cap reportIds remain authenticated, mutation-free 400s. Per-reportId transaction advisory locking serializes normal and incident receipts across different loop locks.

## Poll transport (long-poll + hot-path budget)

- `/api/machine/poll` is the breaking protocol-v2 `gateway.pollV2Wait()` seam.
  Idle requests park automatically on the per-machine waiter (held <=
  `LONG_POLL_WAIT_MS` 20s); executing/reporting requests never park and receive no
  delivery. Dispatcher wakeups resolve the in-memory waiter so durable pending work
  claims promptly; a deploy merely drops the hint and the daemon re-polls. A
  protocol mismatch returns `426 UPGRADE_REQUIRED` and updates the authenticated
  machine's stored protocol so Dashboard capability cannot stay stale.
- Daemon side (`daemon.ts`): one fixed slot sends `currentRun` + stage; it is cleared
  only after execution's exact terminal payload is durable in the local SQLite
  outbox and receives a definitive report ACK. Startup replays that outbox before
  its first poll. `nextPollDelayMs(elapsed)` keeps the short-poll/held-poll cadence.
- Poll hot-path DB budget: `machines.lastSeen` re-stamps only when the flag must
  flip or the stamp is older than `LAST_SEEN_REFRESH_MS` (10s) - an idle poll is
  read-only when no schedule fact is due. Poll first calls
  `advanceDueSchedules(machineId)`, then `store.claimReadyRunForMachine`: a
  targeted pending scan plus machine advisory lock gives one claim across all
  loops on that machine, picks `edit > evolve > exec`, and inserts the hashed run
  lease before committing; the partial unique machine-running index is the final
  defense. `openRuns()` remains sweep-only.
- Watch set: served from a per-machine cache (`WATCH_CACHE_TTL_MS` 15s), response
  always carries `watchDigest`; when the daemon echoes a matching digest the
  `watch` array is OMITTED. Omission requires the echo (proof the client speaks
  the protocol) - an old daemon always gets the full list, and an ABSENT `watch`
  means "unchanged", never "empty" (`daemon.ts` only reconciles on `Array.isArray`).
  Any delivery forces a recompute (the run may belong to a brand-new loop whose
  folder must be watched before it writes); gateway `createLoop`/`editLoop` call
  `invalidateWatch`; store-direct write paths (web loopApi) are covered by the TTL.

## Durable schedule facts + run queue

- `loops.nextCadenceAt` is recurring work not yet materialized;
  `loops.nextRunAt` remains an independent one-shot. `advanceDueSchedules(now)`
  locks/rechecks each due loop, coalesces one system exec, consumes both facts when
  both are due, advances cron strictly after `now`, and clears continuous. Scheduler
  timers/Dispatcher wakes are hints; machine poll invokes the same seam before claim.
- Queue persistence reuses `runs`: `requestedBy: owner|system`, role-scoped
  `requestText`, immutable `createdAt`, and mutation `updatedAt`. One partial unique
  index enforces one pending row per loop+role. Coalescing only promotes
  system→owner; latest owner edit wins; a running role may retain one follow-up.
  Cross-role rows survive and claim priority is `edit > evolve > exec`.
- `store.updateLoop` owns lifecycle/cadence atomically. `loops.pauseCause` annotates an ordinary owner pause/stop vs circuit-breaker `failure-streak` (run/count); explicit start clears it. Pause clears both schedule
  facts and cancels pending system rows, but owner-requested exec/edit/evolve remain
  claimable while the loop stays paused; their terminal path cannot restore cadence.
  Mode switches never cancel queue rows: cron stores its next future occurrence; continuous stores
  null behind open exec, otherwise now. Create/resume use the same rules.
- Claim + run-lease insert are one store transaction returning run+loop+wire token.
  Every run-token mutation atomically rechecks its matching active lease and running
  run under the loop lock (`mutateForActiveRun`; terminal helpers use the same check).
  Only exec claim clears `nextCadenceAt`, and only exec done/error restores
  `terminalAt + delay` when no exec is open; edit/evolve never shift exec cadence
  and canceled exec never continues. Terminal run,
  cursor/task, cadence, auto-evolve system request, and lease retirement share the
  loop-lock transaction. Reclaim terminalizes its lease and writes provisional
  cadence atomically; due advancement fences on terminal-grace, and one unexpired
  late report may replace that fact before consuming the lease. Expiry is rechecked
  after taking the lock. The terminal transaction also computes the exec failure
  streak and atomically auto-pauses/clears facts/cancels pending system work.
- Migration 0003 converts and clears legacy edit/evolve markers but retains their
  deprecated columns/defaults only to reduce old-image SELECT/INSERT breakage. This
  is not rollback support: migrations are forward-only, post-migration legacy writes
  are unsupported, and new runtime never reads/drains them. Boot
  performs no history inference/misfire catch-up: it only initializes enabled cron
  rows with null cadence to the next future occurrence, idempotently. Pending system
  retention uses immutable `createdAt`, so coalescing cannot extend the 7d max life;
  final sweep writes recheck phase/authority/updatedAt/eligibility under the loop lock.

## Gateway layout (the MachineGateway decomposition)

- `gateway/index.ts` (`MachineGateway`) is the run-lifecycle core: poll/pollWait,
  report/reclaimRun/sweep, `maintainStorage` (retention/GC), the
  owner verbs (createLoop/listLoops/editLoop/loopLog/renderLoopLog), and the
  presence/watch state.
- The artifact byte-ingress cluster lives in `gateway/sync.ts` as `ArtifactSync`:
  `sync()` (POST /api/machine/sync manifest reconcile), `putBlob()` (PUT
  /api/machine/blob/:hash), `readBlob()` (the download seam `artifactFiles.ts` /
  `runDiff.ts` resolve bytes through), plus the private task-file mirror
  `refreshTaskFileContent`.
- The CLI dispatch cluster lives in `gateway/cli.ts` as `CliGateway`
  (constructor-injected with the `MachineGateway`): `cli()` (the unified
  /api/machine/cli credential router + `finalizeCli`), `agentApi()`
  (/agent-api/loop), the per-run `dispatch()` verb switch, and the CLI-only
  renders/help/home. It reuses the core's methods through the injected gateway -
  `renderLoopLog` (the flat-404 scoping body), the owner verbs, and
  the scheduler are public on `MachineGateway` for exactly that second consumer -
  so floors/allowControl and the credential-type-first routing flow
  through unchanged. `gateway/toon.ts` stays the shared render spine.
- `gateway/validate.ts` holds the ui/schema validators. ANTI-DRIFT
  INVARIANT: the owner edit surface (`createLoop`/`editLoop` in index.ts) and the
  run-token `set-*` surface (`applySet*` in cli.ts) import this ONE module, so the
  two write paths cannot validate differently.
- **Boot constructs ONE `createBlobStore()` and hands the SAME instance to
  `MachineGateway` and `ArtifactSync`** (`boot.ts`; accessors `getGateway()` /
  `getArtifactSync()` / `getCliGateway()`). This is load-bearing with the
  injected adapters and keeps all writes/reads/retention on one store instance;
  two in-memory test adapters would otherwise observe different bytes. Tests mirror the sharing
  (`retention.test.ts` `gatewayWithStore`).
- Import direction: the generic wire plumbing (`HttpResult`, `WIRE_TEXT_CAP`,
  `clipText`/`stripNul`, `nowIso`) lives in the leaf module `gateway/http.ts`,
  imported by index/cli/sync alike - one clipping/NUL-stripping discipline, no
  fork; domain helpers (caps, renders) still flow `index.ts` -> `cli.ts`/`sync.ts`,
  and `index.ts` never imports its satellites, so there is no cycle. The whole
  shape is pinned by `gateway/layout.test.ts`.
- The legacy `/api/machine/loop` + `/api/machine/log` routes call the owner-verb
  methods on `MachineGateway` directly; `/api/machine/cli` + `/agent-api/loop`
  route through `getCliGateway()`.

## Team CRUD + membership management

- **Logic lives in `server/teamAdmin.ts`; `server/teamFns.ts` is a THIN RPC wrapper.**
  teamAdmin is framework-free (plain async fns over `store`, `(actorUserId, ...)` in),
  so every rule is directly testable against real pglite without mocking the Start
  runtime (`server/teamCrud.integration.test.ts`, 15 scenarios). teamFns resolves the
  signed-in user (`currentUserId`) and delegates; team management is GATED (open mode /
  signed-out ⇒ a uniform "sign-in required").
- **Every fn takes an EXPLICIT teamId and authorizes by membership+role, NEVER the
  active-team cookie** (the URL report's hard lesson — managing team B while browsing A
  must work). `assertOwner` is the single owner-gate chokepoint; a non-member gets the
  enumeration-safe generic not-found, never the owner-only message.
- **The six approved design decisions (`data/teamcrud-design/report.md` §7):**
  (1) delete is BLOCKED while the team owns loops (`store.countLoopsForTeam(teamId)`),
  never cascaded — `store.deleteTeamCascade` only removes channels/invites/members and
  reassigns machine home-team pointers (cosmetic, machines are user-owned) to each
  owner's personal team; (2) invites are BOTH direct-add-by-email (existing account
  fast path) AND a single-use, 7-day invite link (`team_invites` table, migration
  `0002`); (3) an invite never bypasses `PIEVO_ALLOWED_LOGINS` (the redeemer already
  signed in through the gate); (4) team management is owner-only, loop creation stays
  any-member; (5) the personal team is renamable — **`store.ensureTeam` is now
  INSERT-ONLY for the name** (the old force-rename at every requestScope silently
  reverted manual renames); (6) multi-owner allowed, the ONLY invariant is the
  last-owner guard.
- **The last-owner guard is enforced TRANSACTIONALLY in the store**
  (`removeTeamMemberGuarded` / `setTeamMemberRoleGuarded` count owners + mutate in ONE
  txn → `'ok'|'last-owner'|'not-member'`), so two concurrent self-removals can't both
  win and strand a memberless team. `leaveTeam` reuses `removeTeamMemberGuarded` (self)
  and also blocks the personal team.
- **Invite redeem** (`/invite/$token` route → `redeemTeamInvite`): any signed-in user
  may redeem (the token is the authority). Outcomes: invalid / already-used (single-use,
  stamped `redeemedAt`) / expired / already-member (success, no double-add, still burns
  the link) / fresh join at the invite's role. The route forges nothing — a signed-out
  visitor hits the normal gated `SignIn` with `callbackURL` back to the invite.
- **UI**: `components/TeamsModal.tsx` (header "Teams" button in `DashboardView`, shown
  only when the user has teams). Master list + selected-team detail (rename, members
  with role select + remove, add-by-email, invite links + revoke, leave, delete with the
  blocked-by-loops disabled state). Owner-only controls hide for a plain member; the
  server re-authorizes regardless.
- **Verifying the gated flow in a browser without GitHub OAuth**: seed a `user` + a
  `session` row into a temp-`PIEVO_DATA_DIR` pglite, then forge the cookie
  `better-auth.session_token=<token>.<makeSignature(token, secret)>` (`makeSignature`
  from `better-auth/crypto`) — Better Auth verifies the HMAC signature regardless of
  cookie domain. pglite is single-writer, so seed in a separate process that exits
  before the dev server opens the same dir.

## Notification webhook SSRF guard (`gateway/webhookGuard.ts`)

- The built-in Feishu/Lark notifier POSTs to a user-supplied `webhookUrl`, so it is
  guarded against SSRF by `gateway/webhookGuard.ts` (pure, unit-tested):
  `validateFeishuWebhookUrl` (require `https:` + an EXACT host allowlist
  `FEISHU_WEBHOOK_HOSTS` + the `/open-apis/bot/v2/hook/` path shape) and
  `classifyAddress` (blocks loopback/RFC1918/link-local incl. `169.254.169.254`/
  ULA/multicast/reserved; IPv4 + IPv6 + IPv4-mapped). `safeWebhookFetch` composes
  them: allowlist → DNS-resolve + IP-guard EVERY host → bounded timeout
  (`WEBHOOK_TIMEOUT_MS`) + bounded response read (`WEBHOOK_MAX_BYTES`); redirects
  NOT auto-followed (`redirect:"manual"`, each hop re-runs the full guard).
- Enforced at BOTH ends: `CHANNELS.feishu.validate` runs the pure allowlist check at
  create/edit time (called by `notifyFns.createChannel` via the new optional
  `ChannelKind.validate` hook); `CHANNELS.feishu.send` runs the FULL DNS/IP guard at
  every send/test (a stored URL is untrusted - re-checked, never trusted from create).
- **Test seam**: `setWebhookFetchDeps({lookup, fetchImpl})` in `notify.ts` injects DNS
  + fetch so `notify.test.ts` exercises the guard without network (restore with `{}` in
  `afterEach`). `webhookGuard.test.ts` covers the pure helpers directly.
- Residual: global `fetch` re-resolves DNS on connect (no stdlib socket-pinning without
  a custom undici dispatcher, deliberately not pulled in) - the exact-host allowlist
  bounds any rebind to an official Feishu/Lark domain. Adding a NEW outbound integration?
  Reuse this module; do NOT reintroduce a raw `fetch(userUrl)`.
- FOLLOW-UP (audit H-02): channel create/test is any-member (open mode may be
  unauthenticated). The destination restriction closes the SSRF regardless of creator;
  tightening create to team-owner-only is a separate change.

## Maintaining this file

Keep entries durable and project-intrinsic (build/test/release, architecture, sharp
edges) — not task narration. Prefer a pointer to the authoritative file/command/test
over copying detail. Update or prune an entry when the code it describes changes; delete
what no longer holds rather than letting it drift. `CLAUDE.md` symlinks here, so one edit
serves both. English only, tight prose.
