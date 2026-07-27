# Create a loop

A Pievo loop runs one server-stored prompt with one selected coding agent in a fixed
working directory. Use the **pievo-cli** prefix supplied by the user (default `pievo`).
If this machine is not connected, follow `connect.md` first.

## 1 · Identify the prompt

Start from concrete evidence in the current session:

- If the user just completed or described a recurring task, turn that task into a
  standalone prompt grounded in its real paths, commands, URLs, constraints, and
  expected result.
- If there is no task yet, inspect the project, propose a few useful scheduled prompts,
  and let the user choose. Do not invent and create one silently.

The stored `prompt` is sent unchanged. Make it self-contained for a fresh coding-agent
process, but do not add Pievo runtime instructions: the server appends the complete
status definitions and required `pievo report` command.

## 2 · Confirm schedule and outcomes

Before creating, propose any missing choices in one short message and get confirmation:

- **Schedule:** use cron for wall-clock work or continuous for a fixed delay after the
  prior run finishes. For cron, confirm the timezone and whether an occurrence while a
  run is still open should `skip` or `queue-one` coalesced follow-up. Continuous never
  overlaps.
- **Statuses:** define what `keep`, `no-change`, and `block` mean for this task. All
  three definitions are required and must be non-empty. `block` means owner attention
  is required and pauses the loop.
- **Artifacts:** if the user wants files visible in Pievo, list exact paths relative to
  `workdir`. Use stable filenames. Globs, absolute paths, traversal, and directories
  are not supported. Missing or unreadable files do not fail a run.

## 3 · Author the canonical config

Cron example:

```json
{
  "name": "Daily dependency check",
  "schedule": {
    "mode": "cron",
    "cron": "0 9 * * *",
    "timezone": "America/Los_Angeles",
    "overlap": "skip"
  },
  "workdir": "/absolute/path/to/project",
  "agent": "claude-code",
  "model": null,
  "reasoningEffort": null,
  "prompt": "Inspect the repository's open dependency updates. Verify each update against its exact diff and current checks, then write any safe action or reason to defer it to dependency-check.md.",
  "statusDefinitions": {
    "keep": "A verified action or useful finding was produced.",
    "noChange": "The check completed and found no actionable change.",
    "block": "Owner input or unavailable access prevents a safe decision."
  },
  "artifacts": ["dependency-check.md"],
  "enabled": true
}
```

Continuous schedule shape:

```json
{
  "mode": "continuous",
  "delayMinutes": 30
}
```

Rules:

- Required: `name`, `schedule`, absolute `workdir`, `agent`, non-empty `prompt`, and
  all three `statusDefinitions`.
- `agent` is `claude-code` or `codex`.
- `model` and `reasoningEffort` are optional strings. Omit them or use `null` to let
  the selected coding-agent CLI use its default.
- `artifacts` is optional and contains only exact workdir-relative file paths.
- `enabled` is optional and defaults to `true`.
- Cron and continuous are exclusive shapes. Do not mix their fields.

## 4 · Validate, then create

Preview the exact config first:

```bash
<pievo-cli> new --json '<config>' --dry-run
```

Fix every rejection. Then create it:

```bash
<pievo-cli> new --json '<config>'
```

When the dashboard connection command is present in this session, reuse the same
executable prefix it used for `daemon start` (`pievo` or the custom command) as
**pievo-cli**, and include its connect key so the loop lands in the selected team:

```bash
<pievo-cli> new --json '<config>' --connect-key <connect-key>
```

On success, tell the user the loop name, schedule, working directory, selected agent,
and whether any artifact files were configured.
