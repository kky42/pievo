# @kky42/pievo

The CLI for [Pievo](https://github.com/kky42/pievo), a single-user scheduled prompt
runner for your own devices. `pievo server` hosts the dashboard and scheduler on one
device (via the bundled `@kky42/pievo-server`); `pievo daemon` runs on every device
that executes loops. The daemon polls the server, launches Claude Code, Codex, or Pi
in a configured local working directory, and durably reports the result.

The server schedules and stores data but never starts an LLM or executes user code.
The daemon is the execution plane and uses the provider credentials, files, and tools
available on its device. See the [project README](https://github.com/kky42/pievo#readme)
for server setup and LAN/Tailscale access.

## Requirements

- Node.js `>=22.13` (Pi 0.82.1 itself requires Node.js `>=22.19`)
- Claude Code (`claude`), Codex (`codex`), or Pi (`pi`) installed and authenticated
- a Pievo server URL and connect command from its dashboard

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

Server (dashboard device)
  server start [--foreground] [--port <n>] [--host <addr>] [--no-https]
  server status | stop | restart

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
  file list|get|set <loop> [<name>] [--from <path|->]
  skill [status|install]
```

Run `pievo --help` or `<command> --help` for the complete current syntax. `new` also
accepts `--json -` on stdin. The canonical configuration contains a name, one
exclusive cron or continuous schedule, an absolute working-directory path, agent,
stored prompt, and all three status definitions, with optional provider settings,
enabled state, and artifact file names.

> `daemon stop --force` and `daemon restart --force` may discard a terminal result
> that is not durable yet and may leave local or external side effects uncertain.

## Runtime behavior

The daemon has no inbound listener. It polls the server, runs each delivered prompt
once, and saves the terminal payload to an owner-only, server-specific SQLite outbox
until that server accepts it. There is no provider retry or session resume. Different loops may run
concurrently, while each loop remains serialized.

Each loop has server-owned files: `MEMORY.md` (at most 8000 characters), its memory
across runs, plus up to four configured `.md`/`.html` artifacts (2 MB each) that the
dashboard renders. For each run the daemon downloads them into a private
`~/.pievo/runs/<run>` directory, tells the agent the path, and uploads changed
versions with the durable terminal report. A version over its limit is rejected and the
previous one kept; an owner edit (`pievo file set`) made during a run wins.

A run reports through its final response, which must end with a last line
`STATUS: keep|no-change|block`; `pievo` commands are unavailable inside a run.

## Local security controls

- `PIEVO_ROOTS=/allowed/root,/another/root` creates an always-applied cwd jail;
  server-provided roots may only narrow it. Empty means unrestricted.
- Child environments are provider-specific allowlists. Claude Code receives only
  Claude/Anthropic credentials; Codex receives only Codex/OpenAI credentials; Pi
  receives its documented config and built-in-provider credential keys.
- The detached daemon and provider child argv omit device and run credentials; local
  credential files use owner-only permissions. The initial `--connect-key` command is
  the explicit exception and should be treated as secret.
- Process cancellation targets the whole POSIX process group with TERM then KILL.
- `PIEVO_EXEC_TIMEOUT_MS` accepts a positive override; otherwise the provider timeout
  is 12 hours.

Useful binary overrides are `PIEVO_CLAUDE_BIN`, `PIEVO_CODEX_BIN`, and `PIEVO_PI_BIN`.

## Owner skill

The package bundles a small owner-facing skill for connection, creation, and editing.
`daemon start` best-effort copies it directly to `~/.claude/skills/pievo` and
`~/.agents/skills/pievo` (used by Codex and Pi). Each refresh replaces any same-named
`pievo` skill with the copy bundled in the current CLI. Installation failure never
blocks execution, and runtime prompts do not depend on the skill. Inspect or refresh
it with `pievo skill status|install`.

## License

[MIT](LICENSE)
