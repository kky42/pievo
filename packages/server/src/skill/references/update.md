# Edit an existing loop

A loop lives in two places, and you change each where it lives. Use the same **pievo-cli** prefix as for create (default `pievo`); it reuses this machine's persisted device token.

- **Schedule / delivery envelope + goal** — cadence, name, timezone, notify, model, reasoning effort, pause, goal, etc. Change it with `pievo edit --json '<patch>'`.
- **What the loop does** — the task file (`pievo/<slug>/README.md`) on this machine. Edit it directly, preserving `## Spec`, `## Current understanding`, and `## Timeline`. To point at a different task file, patch `taskFile`.
- **Dashboard / metric schema** — usually left to evolution. If the user explicitly asks, push them with `--ui-file` / `--schema-file`; schema changes are additive.

Find the loop id:

```bash
<pievo-cli> loops
```

Before reshaping behavior, read recent runs with `<pievo-cli> log <loop-id>` so the edit is grounded in evidence.

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
