# Daemon agent notes

Package: `@kky42/pievo`. Read the repository-level [`AGENTS.md`](../../AGENTS.md)
first. The daemon is Pievo's only execution plane; the server remains zero-exec.

## One binary, three contexts

Pure routing lives in `src/route.ts` `classify(argv, env)` and must stay testable
without subprocesses:

- `PIEVO_RUN_TOKEN` wins first: callback mode accepts only `report` and help.
- Outside a run, bare `pievo` is the machine home.
- Local lifecycle is only `pievo daemon start|stop|restart|status`.
- Owner server verbs include `new`, `loops`, `show`, `log`, `edit`, `pause`, `start`,
  `stop`, `delete`, and `run stop`.
- Help/version are local fast paths and never start a daemon.

`cli-client.ts` is the shared HTTP transport for callback and owner verbs. It chooses
the run token before the persisted device token and posts `{argv}` only to
`/api/machine/cli`. Reports accept only `--message`. The daemon prints server-rendered `text`
and exits with `exitCode`; missing `text` is an invalid server response. There is no
fallback transport.

## Canonical owner configuration

`pievo new --json '<object>'` (or `--json -`) sends the complete server config:
required name, exclusive cron/continuous schedule, workdir, agent, prompt, and all
three status definitions; optional model, reasoning effort, exact artifact paths, and
enabled. `pievo edit` accepts one JSON patch. The server is the semantic validator;
local checks reject only malformed JSON, unsupported agent values, obvious cron shape,
and unknown CLI flags. Both commands support `--dry-run`.

Real creates derive a stable idempotency key from machine ID plus canonical JSON of the
entire resolved body, including claim. Retrying identical input within the server window
must not create a twin; any config/team change must produce a different key.

Loop resolution for `show` and `log` is client-side by explicit ID/unique name or
current cwd against the loop `workdir`. There is no separate local content directory.

## Daemon lifecycle

`daemon start` is detached and idempotent by default; `--foreground` runs the same
poller attached. Persist server URL and device token under `PIEVO_HOME` (default
`~/.pievo`) with owner-only permissions. Reuse a stored device token before a supplied
connect key so a restart keeps machine identity.

Detached re-exec uses `daemon start --foreground`; the token travels in environment,
never argv. Readiness requires a fresh server heartbeat, not stale online state. The
pid file records pid plus process start time, so a reused pid is never signaled.

`daemon stop` asks every executing process group to terminate, waits for exact terminal
payloads to reach the SQLite durability boundary, then stops report transport. Its
default wait is correctness-first; `--force` bounds the wait and may kill. `restart` is
stop + start of the currently installed package and preserves configuration. npm alone
performs upgrades.

`daemon start` and successful `new` best-effort refresh the public skill and PATH shim.
The shim:

- is written only from a durable install, never an npx/cache entry;
- never overwrites a foreign `pievo`;
- prefers npm's bin then `~/.local/bin`;
- re-execs the exact current launcher.

**Test hazard:** uninjected `ensureBinShim()` can write the real home. Lifecycle tests
must no-op it; shim tests inject env/fs seams.

## Poll runtime and durable outbox

`daemon.ts` maintains an unbounded map of active runs across different loops. It rejects
a second delivery for the same loop. Every protocol-v4 poll sends
`daemonInstanceId`, `recoveryComplete:true`, and all `currentRuns` as
`executing|reporting`; outbox rows are hydrated before the first poll.

A run remains active until:

1. provider execution returns one exact terminal payload;
2. that payload is committed synchronously to `pending-reports.sqlite` with
   `synchronous=FULL`;
3. the report worker gets a definitive report-ID-bound ACK.

Each outbox row is independent. Local persistence failures retry forever without
releasing the loop; transport and non-current response shapes back off without stopping
heartbeats or unrelated loop execution. Only the server's exact current 200 normal or
digest-bound handled ACK and exact 410 `RETIRED` ACK consume a row. Every other response,
including 409/422 conflict/invalid shapes, remains diagnostic and retryable after restart.

Idle server polls may be held; active polls return quickly for heartbeat/cancellation
and may receive another loop. All HTTP uses `boundedFetch`.

## Provider execution and report contract

`runner.ts` resolves the configured `workdir`, applies effective roots, and starts the
selected provider exactly once. There is no provider retry or resume.

- Claude Code: stream JSON, verbose, bypass permissions, optional model/effort, and
  disallow provider self-scheduling tools.
- Codex: `codex exec --json`, bypass approvals/sandbox, skip git check, optional
  model/effort, and force full shell-environment inheritance so the run callback shim
  remains first on PATH.

The child gets an agent-specific environment allowlist, not the whole daemon env.
Process termination targets the POSIX process group with TERM then KILL. The default
wall-clock timeout is 12 hours; only a positive `PIEVO_EXEC_TIMEOUT_MS` overrides it.

Deliveries contain no system-prompt field. Their one user turn is the stored prompt
plus status definitions and report command. `runIndex` remains a wire/history fact but
must not enter the prompt.

Inside the run, callback mode exposes only:

```text
pievo report --status keep|no-change|block --message <text>
```

Status and non-empty message are required and can be recorded once. Provider terminal
diagnostics are independent: duration, exit code, error, session ID, final assistant
text, and normalized input/output/cache token usage. Never substitute final assistant
text for the required report. Session IDs are retained only as diagnostics; never
resume them.

## Exact artifact collection

After the provider exits and before outbox persistence, `artifacts.ts` processes only
the configured exact paths relative to `workdir`:

- reject absolute, empty/dot/traversal paths and lexical escapes;
- realpath both root and file, rejecting symlink escapes;
- accept regular files only;
- tolerate missing/unreadable files and network failures;
- read at most 10 MB + 1 byte; larger files are metadata-only;
- no globbing, directory walk, filename/extension/secret/content filter, or aggregate
  directory cap.

The manifest contains only these paths. The server returns missing hashes; the daemon
re-reads and verifies each requested hash, then PUTs up to four concurrently.
Artifact failure never changes the provider result. The server snapshot is correct only
because sync completes before terminal report persistence; preserve that ordering.

## Local jail and credentials

`PIEVO_ROOTS` is the always-applied local cwd jail. Server-sent roots may only narrow
it; normalize resolved paths before prefix comparison. With no roots, execution is
unrestricted. Configured artifacts have the additional realpath confinement above.

The device token fully impersonates the machine and the run token authorizes one run.
Keep tokens out of argv/logs and local files mode 0600. Callback PATH prepends the
run-scoped wrapper. `spawn.execEnv` requires an explicit agent argument. Agent child
environments expose only necessary provider credentials: Anthropic/Claude values to
Claude Code, OpenAI/Codex values to Codex.

The daemon intentionally installs no coding-agent session-start hook. Normal sessions
use explicit `pievo` or the user-scope owner skill; run delivery is self-contained.

## Skill packaging

`scripts/sync-skill.mjs` selectively copies exactly:

- `SKILL.md`;
- `references/connect.md`;
- `references/create.md`;
- `references/update.md`.

Never recurse into the server skill directory. The generated `packages/daemon/skill/`
is build output and is ignored. `SKILL_TARGET_AGENTS` drives both install argv and
status paths; use repeated `-a claude-code -a codex`, never a comma value or wildcard.
Installation is user-scoped, best-effort, and must never delay polling or fail create.
Runtime execution cannot depend on it.

## Protocol and tests

The server requires daemon `2.4.0` on protocol v4. Any wire change needs a coordinated
daemon version and server `MIN_DAEMON_VERSION` bump before unsupported daemons can
claim. Preserve explicit 426/upgrade diagnostics rather than allowing a mid-run failure.

External process/network/filesystem touches should remain injectable. Ordinary suites
are hermetic. Provider JSONL fixture tests cover parser behavior but do not prove real
CLI schemas; changes claiming Claude Code/Codex schema acceptance must run:

```bash
PIEVO_REAL_LLM_TESTS=1 pnpm --filter @kky42/pievo test src/telemetry.real.test.ts
```

This opt-in test spends real credentials and must verify both providers, terminal
session ID, exact final text, positive normalized input/output usage, and no resume.

## Release

`publish-daemon.yml` publishes only this package from `v*` through npm OIDC. The tag
must match `package.json`. Do not add `registry-url` or `NPM_TOKEN`; npm 11 trusted
publishing and the package repository object are required for provenance. Build must
run the selective skill copy and include only `dist`, `skill`, and `LICENSE` from the
package `files` list.
