# Pievo agent guide

Pievo is a single-user scheduled prompt runner and status ledger for one person's
devices on a LAN or tailnet. The TanStack Start server owns scheduling, queueing,
persistence, and byte serving; the `@kky42/pievo` CLI runs the server (`pievo server`)
and the daemon (`pievo daemon`), which runs Claude Code, Codex, or Pi on each device.

## Documents

- `HUMAN.md`: the owner's statement of purpose and meta design. Read it before
  design decisions. Only the owner edits it; never change it, even to fix a typo.
- `AGENTS.md` (this file, also `CLAUDE.md`): rules and guidelines for agents.
- `README.md`: user documentation. Update it when user-visible behavior changes.
- `CONTRIBUTING.md`: setup, commands, the end-to-end recipe, migrations, and release.

Do not add other documentation files. Durable knowledge goes in one of these four,
in code, or in tests.

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
  `MEMORY.md` (8000 characters) and up to four text/code artifacts (256 KB). A run
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

## Verification

Pievo's executors are coding agents and its interface is a dashboard, so the proof
that a change works is an end-to-end run, not a unit test. Follow the recipe in
`CONTRIBUTING.md` ("End-to-end check").

- **Agent behavior** (prompt, delivery, runner, provider spawn, telemetry, status
  parsing, loop files, protocol, scheduling, lifecycle): run a real loop with a real
  agent on the dev server and confirm the run's terminal state, status, summary, and
  file updates. Use a disposable working directory, the cheapest suitable model, and
  a small prompt.
- **Dashboard** (components, styles, routes, server functions): open the dev
  dashboard in a real browser, check how it renders, and use the changed flow the
  way the owner would: clicks, forms, confirmations, loading/empty/error states,
  light and dark mode, and a narrow window with no horizontal page scroll.
- **CLI and skill**: run the changed commands through `pnpm dev:daemon` against the
  dev server.
- Always also run `pnpm -r typecheck` and both test suites.
- Report what you ran and what you saw. If you could not run the end-to-end check
  (for example, no provider credentials), say so plainly; never call the change
  verified. Clean up dev daemons, loops, and scratch directories you created.

## Tests

Unit tests guard core mechanisms that are hard to reach end to end: loop-locked
state transitions, leases and report durability, protocol decoding, loop-file limits
and conflict rules, scheduling and cadence, process and pid safety, and security
boundaries (network guard, roots jail, environment allowlists, token handling,
artifact-serving headers, request size caps).

- Add a regression test at the lowest level that reproduces a bug in one of those
  mechanisms.
- Do not add tests that compare copy, labels, help text, CSS classes, or formatted
  strings; restate constants or file lists; assert values a mock was told to return;
  or cover trivial mappers. Verify those end to end instead.
- When a change leaves an existing test trivial or redundant, delete it.

## Comments

Code should explain itself through names, types, and structure. Keep a comment only
for what the code cannot say:

- why: trade-offs, rejected alternatives, deliberate compromises;
- magic numbers and defaults: the unit, where the value came from (measurement,
  experiment, external limit), and what changing it breaks;
- protocol, compatibility, and security constraints, and non-obvious risks;
- TODOs with enough context to act on.

Delete comments that paraphrase the code: symbols, branches, return types, CSS,
section headings, tests, or assertions. Keep each comment next to the code it
explains and update it when the behavior changes.

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

## Changes that need extra care

Migrations, releases, and publishing follow `CONTRIBUTING.md` exactly. Server
typecheck regenerates `src/routeTree.gen.ts`.

Keep this file concise and durable. Prefer authoritative modules and tests over copied
implementation detail or task history.
