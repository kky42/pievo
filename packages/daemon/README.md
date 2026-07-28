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
- a Pievo server URL and secret device/connect credential from its web UI

> The daemon launches coding agents in unattended mode. They can use the files,
> commands, and credentials exposed to the process. Use a disposable project or set
> `PIEVO_ROOTS` to restrict allowed working directories.

## Install and connect

```bash
npm install -g @kky42/pievo@latest
pievo daemon connect --server-url <url> --connect-key <dk_…>
```

`daemon connect` saves a per-server machine credential in owner-only
`PIEVO_HOME/connections.json` (default `~/.pievo/connections.json`), selects that
server, and ensures its daemon is running. A saved URL can later be selected without
a key. Switching servers force-stops the current daemon and runs before activating
the target. Use `pievo daemon connections` to list saved URLs.

`daemon start` starts the active connection and is detached and idempotent by default.
It waits for a fresh server heartbeat and prints `daemon online` on first success.
`--foreground` stays attached for a supervisor or debugging.

The `dk_…` credential is a persistent bearer secret. The generated initial connect
command passes it as `--connect-key`, so protect the command and your shell history.

Upgrade explicitly; restart never updates npm:

```bash
npm install -g @kky42/pievo@latest
pievo daemon restart
```

## Commands

```text
pievo                         Show this machine's loops and recent runs.

Daemon lifecycle
  daemon connect --server-url <url> [--connect-key <dk_…>]
  daemon connections
  daemon start [--foreground]
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
accepts `--json -` on stdin. The canonical configuration contains a name, one
exclusive cron or continuous schedule, an absolute working-directory path, agent,
stored prompt, and all three status definitions, with optional provider settings,
enabled state, and exact artifact paths.

> `daemon stop --force` and `daemon restart --force` may discard a terminal result
> that is not durable yet and may leave local or external side effects uncertain.

## Runtime behavior

The daemon has no inbound listener. It polls the server, runs each delivered prompt
once, and saves the terminal payload to an owner-only, server-specific SQLite outbox
until that server accepts it. There is no provider retry or session resume. Different loops may run
concurrently, while each loop remains serialized.

Artifacts are exact workdir-relative file paths—never globs or directory scans. Pievo
rejects path escapes and files over 10 MB are metadata-only. Sync is best-effort and
does not prevent terminal-result persistence. Configuring a path is an explicit upload
decision; Pievo does not filter files by name, extension, MIME type, or content.

## Local security controls

- `PIEVO_ROOTS=/allowed/root,/another/root` creates an always-applied cwd jail;
  server-provided roots may only narrow it. Empty means unrestricted.
- Child environments are provider-specific allowlists. Claude Code receives only
  Claude/Anthropic credentials; Codex receives only Codex/OpenAI credentials.
- The detached daemon and provider child argv omit device and run credentials; local
  credential files use owner-only permissions. The initial `--connect-key` command is
  the explicit exception and should be treated as secret.
- Process cancellation targets the whole POSIX process group with TERM then KILL.
- `PIEVO_EXEC_TIMEOUT_MS` accepts a positive override; otherwise the provider timeout
  is 12 hours.

Useful binary overrides are `PIEVO_CLAUDE_BIN` and `PIEVO_CODEX_BIN`.

## Owner skill

The package bundles a small owner-facing skill for connection, creation, and editing.
`daemon start` best-effort installs it at user scope for Claude Code and Codex.
Installation failure never blocks execution, and runtime prompts do not depend on the
skill. Inspect or refresh it with `pievo skill status|install`.

## License

[MIT](LICENSE)
