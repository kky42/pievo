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

> **Package cutover:** `@kky42/pievo` is the final package identity. Until this
> repository's first Pievo daemon release is published, npm's `@latest` may still
> resolve the legacy project being taken over; do not use these install commands
> before that release.

```bash
npm install -g @kky42/pievo
# or run ad-hoc:
npx @kky42/pievo --help
```

## Connect your machine

```bash
pievo up --server-url <url> --connect-key <dk_…>
```

`up` is idempotent: it registers this machine (first time), stores the
credentials under `~/.pievo/`, and spawns a detached daemon if none is
running. It also refreshes the user-scope pievo skill and the `pievo` PATH
shim. After that, `pievo up` alone reconnects.

## Commands

```
pievo                 Show the content-first HOME: this machine's live loops +
                        recent runs (the poll loop moved to `up --foreground`).

Setup
  up [--foreground]       Connect this machine / ensure its daemon is running
                          (idempotent; refreshes the pievo skill and the `pievo`
                          PATH shim). --foreground runs the poll loop attached in
                          this terminal instead of detached.
  new --json '<config>'   Create a loop from an inline JSON config (--json - reads
                          stdin). --dry-run validates + previews, creates nothing.
  skill [status|install]  Manage the pievo agent skill install (user scope by
                          default; --project installs into the current directory).
  update                  Update this machine's daemon to the version you invoked
                          (run via npx @kky42/pievo@latest update): stops the
                          running daemon, starts the new one, refreshes the
                          skill/shim.

Management
  status                  Is the daemon running? Show pid + server connection.
  down                    Stop the detached daemon started with `up`.
  show [<id>]             Show a loop's full editable config + recent state (the
                          device credential inspects any loop on this machine).
  log [<loop>]            Show a loop's recent runs (status, metrics, session id;
                          --json for machines).

Interactive
  loops [--fields a,b]    List your loops (default columns id/name/cron/enabled/
                          nextFire; --fields adds timezone/notify/model/goal/
                          taskFile/runs/lastOutcome; --json for machines).
  edit <id> --json '<obj>'  Edit a loop (JSON-only + --workflow-file/--ui-file/
                          --schema-file; --dry-run previews before/after).
```

Run `pievo --help` for the full usage text, or `pievo <verb> --help` for a
single verb's concise usage (prints and exits, running no side effect - safe to
inspect foot-guns like `update` or `down`).

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
agent how to author and evolve loops; `pievo up` (and `pievo new`) install
it at user scope for every coding agent pievo knows about (Claude Code
`~/.claude/skills/pievo/` and Codex `~/.agents/skills/pievo/` today)
automatically, so any loop on this machine can discover it. Run `pievo skill
status` to see each agent's install location.
