# @kky42/pievo

The **Pievo daemon** - runs on your machine, connects to a Pievo server, and
executes your scheduled agent loops locally via your own coding agent.

Pievo is **BYOA** (bring your own agent): the server schedules, stores, and
notifies, but never runs an LLM or executes your code. This daemon is the
execution half - it polls the server for due runs, spawns the loop's coding agent
(Claude Code or `codex exec` for a `codex` loop) in the loop's working directory,
and reports the results back.

## Requirements

- Node.js >= 22
- [Claude Code](https://claude.com/claude-code) installed (`claude` on your PATH),
  or the OpenAI Codex CLI (`codex` on your PATH) for a `codex` loop
- A Pievo server - its dashboard gives you the `server-url` and one-time
  `connect-key` used below

## Install

```bash
npm install -g @kky42/pievo@latest
pievo --help
```

## Connect your machine

```bash
pievo daemon start --server-url <url> --connect-key <dk_…>
```

`daemon start` is detached and idempotent by default: it registers this machine
(first time), stores configuration under `~/.pievo/`, and starts one daemon.
Use `--foreground` to run attached; first connection flags work there too.

## Commands

```
pievo                 Show this machine's live loops and recent runs.

Daemon lifecycle
  daemon start [--foreground] [--server-url <url>] [--connect-key <dk_…>]
                          Start detached by default; idempotent.
  daemon stop [--force]   Stop; --force bounds the durability wait.
  daemon restart [--force]
                          Stop then start the currently installed version.
  daemon status           Show pid, connection, run, and report diagnostics.

Setup and management
  new --json '<config>'   Create a loop from an inline JSON config (--json - reads
                          stdin). --dry-run validates + previews, creates nothing.
  skill [status|install]  Manage the user-scope pievo agent skill install.
  show [<id>]             Show a loop's full editable config + recent state (the
                          device credential inspects any loop on this machine).
  log [<loop>]            Show a loop's recent runs (status, metrics, session id;
                          --json for machines).

Interactive
  pause <loop>            Pause future runs; current work continues.
  start <loop>            Start a paused loop with its existing cadence.
  stop <loop>             Pause, cancel queued work, and request run termination.
  delete <loop> [--force] Stop then delete server history and synced metadata.
  run stop <run>          Stop one run without pausing its loop.
  loops [--fields a,b]    List your loops (default columns id/name/cron/enabled/
                          nextFire; --fields adds timezone/notify/model/goal/
                          taskFile/runs/lastOutcome; --json for machines).
  edit <id> --json '<obj>'  Edit a loop (JSON-only + --ui-file/--schema-file;
                          --dry-run previews before/after).
```

Run `pievo --help` for the full usage text. Nested lifecycle help such as
`pievo daemon restart --help` prints and exits without side effects.

Upgrade explicitly:

```bash
npm install -g @kky42/pievo@latest
pievo daemon restart
```

## How it works

The daemon polls the server over HTTPS - no inbound ports, no websockets. While
idle it opts into a bounded server-held long-poll so a due run dispatches almost
instantly; with a run in flight it keeps a short poll carrying the active run ids.
When a run is due it executes the loop's coding agent in the loop's own folder, live-syncs
that folder's files back to the server (secrets and junk like `.env*`,
`node_modules`, `.git`, `.worktrees`, and build/tool caches are never sent), and
reports the outcome. The loop folder is a synced **content home** (reports,
state, ui, small artifacts) - not a scratch workspace: heavy work products (a
repo clone, a git worktree, build output) belong outside it, and the daemon
defensively caps how much it syncs per loop (`PIEVO_SYNC_MAX_FILES` /
`PIEVO_SYNC_MAX_BYTES`) so a stray checkout can never flood the sync. Your code
and credentials stay on your machine.

## Provider telemetry schema validation

Fixture tests cover collector edge cases, but they are **not sufficient** to
validate provider telemetry schemas: Claude Code and Codex can change their
JSONL event shapes independently of Pievo. Any collector/schema validation must
run the opt-in real-provider test against both installed CLIs:

```bash
PIEVO_REAL_LLM_TESTS=1 pnpm --filter @kky42/pievo test src/telemetry.real.test.ts
```

This spends real provider credits. It runs Claude Haiku with high effort and
Codex `gpt-5.6-luna` with high reasoning in temporary directories, and is skipped
unless `PIEVO_REAL_LLM_TESTS=1`. It validates terminal session id, exact final
text, and positive normalized token usage. It never resumes a provider session.

The package also bundles the **pievo agent skill**, which teaches a coding
agent how to author and evolve loops; `pievo daemon start` (and `pievo new`) install
it at user scope for every coding agent pievo knows about (Claude Code
`~/.claude/skills/pievo/` and Codex `~/.agents/skills/pievo/` today)
automatically, so any loop on this machine can discover it. Run `pievo skill
status` to see each agent's install location.
