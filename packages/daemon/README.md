# @kky42/pievo

The machine-side daemon and CLI for [Pievo](https://github.com/kky42/pievo), a
self-hosted scheduled prompt runner. It polls a Pievo server, launches Claude Code or
Codex in a configured local working directory, and durably reports the result.

Pievo is BYOA. The server schedules, authenticates, and stores data but never starts an
LLM or executes user code. This package is the execution plane and uses the provider
credentials, files, and tools available on your machine.

## Requirements

- Node.js `>=22.13`
- Claude Code (`claude`) or Codex (`codex`) installed and authenticated
- a Pievo server URL and one-time connect key from its web UI

> The daemon launches coding agents in unattended mode. They can use the files,
> commands, and credentials exposed to the process. Use a disposable project or set
> `PIEVO_ROOTS` to restrict allowed working directories.

## Install and connect

```bash
npm install -g @kky42/pievo@latest
pievo daemon start --server-url <url> --connect-key <dk_…>
```

`daemon start` is detached and idempotent by default. It stores the server URL and
machine token under `PIEVO_HOME` (default `~/.pievo`), waits for a fresh server
heartbeat, and prints `daemon online` on first success. Use `--foreground` for a
supervisor or debugging.

Upgrade explicitly; restart never updates npm:

```bash
npm install -g @kky42/pievo@latest
pievo daemon restart
```

## Commands

```text
pievo                         Show this machine's loops and recent runs.

Daemon lifecycle
  daemon start [--foreground] [--server-url <url>] [--connect-key <dk_…>]
  daemon stop [--force]
  daemon restart [--force]
  daemon status

Loop setup and management
  new --json '<config>' [--dry-run]
  loops [--fields a,b] [--json]
  show [<loop>] [--full] [--json]
  log [<loop>] [--limit N] [--status keep|no-change|block] [--json]
  edit <loop> --json '<patch>' [--dry-run]
  pause <loop>
  start <loop>
  stop <loop>
  delete <loop> [--force]
  run stop <run>
  skill [status|install]

Inside a run
  report --status keep|no-change|block --message <text>
```

Run `pievo --help` or `<command> --help` for the complete current syntax. `new` also
accepts `--json -` on stdin. The canonical configuration contains one exclusive cron or
continuous schedule, absolute working-directory path, agent, stored prompt, all three status
definitions, and optional provider settings and exact artifact paths.

## Execution and durability

The daemon has no inbound listener. It uses authenticated HTTP polling; idle polls may
be held by the server, while active polls carry every local run's `executing` or
`reporting` state. Different loops may run concurrently, but each loop stays
serialized.

For each delivery it:

1. verifies the working directory against `PIEVO_ROOTS` and starts the selected
   provider exactly once;
2. gives it the server-stored prompt plus Pievo's complete report contract;
3. after provider exit, collects only configured exact artifact paths;
4. commits the exact terminal payload to an owner-only SQLite outbox;
5. retries until the server returns a definitive report-ID-bound receipt.

There is no provider retry or session resume. The terminal record carries available
exit/duration/error data, session ID, final assistant text, and normalized token usage.
The required `pievo report` status/message is stored separately and may be submitted
only once.

Outbox rows are independent, so one slow or rejected report does not block other loops.
`daemon stop` waits for terminal-payload persistence by default; `--force` bounds that
wait and may kill local processes.

## Exact artifacts

Artifact configuration is an array of exact paths relative to the run working
directory. There are no globs and no directory walk. The daemon rejects lexical and
symlink escapes, accepts regular files only, and tolerates missing/unreadable files.
Files over 10 MB are metadata-only.

There is deliberately no filename, extension, secret-name, MIME, or content filter.
Anything explicitly configured is an upload decision. Smaller files are SHA-256
verified and sent through the server's content-addressed handshake before the terminal
payload is persisted.

## Local security controls

- `PIEVO_ROOTS=/allowed/root,/another/root` creates an always-applied cwd jail;
  server-provided roots may only narrow it. Empty means unrestricted.
- Child environments are provider-specific allowlists. Claude Code receives only
  Claude/Anthropic credentials; Codex receives only Codex/OpenAI credentials.
- Device and run tokens stay out of argv and are stored with owner-only permissions.
- Process cancellation targets the whole POSIX process group with TERM then KILL.
- `PIEVO_EXEC_TIMEOUT_MS` accepts a positive override; otherwise the provider timeout
  is 12 hours.

Useful binary overrides are `PIEVO_CLAUDE_BIN` and `PIEVO_CODEX_BIN`.

## Owner skill

The package bundles a small owner-facing skill for connection, creation, and editing.
`daemon start` best-effort installs it at user scope for Claude Code and Codex.
Installation failure never blocks execution, and runtime prompts do not depend on the
skill. Inspect or refresh it with `pievo skill status|install`.

## Provider schema validation

Fixture tests cover parser edge cases but do not prove live provider JSONL schemas.
Changes claiming real Claude Code or Codex schema support must run the opt-in,
credit-consuming test against both CLIs:

```bash
PIEVO_REAL_LLM_TESTS=1 pnpm --filter @kky42/pievo test src/telemetry.real.test.ts
```

It verifies terminal session ID, exact final text, positive normalized input/output
usage, and that Pievo does not resume the session.

## License

[MIT](LICENSE)
