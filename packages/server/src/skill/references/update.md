# Edit an existing loop

A loop has distinct control, instruction, and learned-context surfaces. Use the same **pievo-cli** prefix as for create (default `pievo`); it reuses this machine's persisted device token.

- **Schedule / delivery envelope + goal** — cadence, name, timezone, notify, model, reasoning effort, pause, goal, etc. Change it with `pievo edit --json '<patch>'`.
- **Standing instructions** — the task file (`pievo/<slug>/README.md`) contains one required authoritative `## Spec`. Edit the Spec directly. To point at a different README, patch `taskFile`.
- **Learned context** — sibling `COOKBOOK.md` contains `Consolidated through: #N`, `## Knowledge`, and `## Timeline`. Knowledge holds durable facts and reusable positive/negative evidence; Timeline holds only evolve/steer decision boundaries and stays bounded.
- **Dashboard / metric schema** — usually left to evolution. If the user explicitly asks, push them with `--ui-file` / `--schema-file`; schema changes are additive.

Find the loop id:

```bash
<pievo-cli> loops
```

Before reshaping behavior, read README and Cookbook. Gather history progressively: `<pievo-cli> log <loop-id> --summary --after N --json` first, then a filtered `<pievo-cli> log <loop-id> --after N`, then at most a few `<pievo-cli> log <loop-id> --run <index> [--diff]` details. Never replay history exhaustively.

For an existing loop with `## Current understanding` or a per-run `## Timeline` in README, the next evolve or steer moves useful learned content into COOKBOOK.md, leaves README's Spec authoritative, and records that migration boundary. An ordinary direct config edit need not rewrite content files.

To delegate a plain-language change as one owner-authorized agent pass, queue a steer run instead of patching configuration directly:

```bash
<pievo-cli> steer <loop-id> --message "change the schedule to weekdays at 9am"
<pievo-cli> steer <loop-id> --message-file instruction.txt
```

A pending steer coalesces and the latest owner instruction wins. `pievo edit` remains the direct configuration patch command.

## Edit the envelope

```bash
<pievo-cli> edit <loop-id> --json '{"cron":"0 9 * * *","notify":"always"}'
<pievo-cli> edit <loop-id> --json '{"scheduleMode":"continuous","continuousDelayMinutes":5}'
<pievo-cli> edit <loop-id> --json '{"enabled":false}'
<pievo-cli> edit <loop-id> --json '{"goal":"ship v1.0"}'
<pievo-cli> edit <loop-id> --json '{"goal":null}'
```

Accepted keys:

| key | value | effect |
|---|---|---|
| `name` | string | rename |
| `cron` | 5-field cron string | retained cron cadence |
| `scheduleMode` | `cron` \| `continuous` | switch cadence mode |
| `continuousDelayMinutes` | integer >= 1 | delay after each continuous exec terminal |
| `timezone` | IANA name | change cron zone |
| `notify` | `always` \| `auto` \| `never` | delivery policy |
| `model` | string or `null` | provider model; `null` uses CLI default |
| `reasoningEffort` | string or `null` | provider reasoning effort; `null` uses CLI default |
| `agent` | `claude-code` \| `codex` | coding agent used on the bound machine |
| `allowControl` | boolean | `false` pins the schedule |
| `enabled` | boolean | pause/resume |
| `runAt` | `2h` / ISO | one extra run soon |
| `taskFile` | absolute path | repoint at a different task-file README |
| `goal` | string or `null` | set/change/clear the standing objective |
| `ui` | HTML string | usually via `--ui-file` |
| `metricSchema` | array of `{key,label?,unit?}` | usually via `--schema-file` |

Preview with `--dry-run`.

## Content fields

```bash
<pievo-cli> edit <loop-id> --ui-file dash.html
<pievo-cli> edit <loop-id> --schema-file schema.json
```

Explicit `--json` keys win over file flags. You can only edit loops bound to this machine.

## Diagnose a rejected terminal report

Use `<pievo-cli> show <loop-id>` and `<pievo-cli> log <loop-id>` first. If the incident names the daemon or compatibility fault domain, upgrade Pievo and restart the daemon: `npm install -g @kky42/pievo@latest`, then `pievo daemon restart`. Edit loop configuration only when diagnostics point to a config problem.
