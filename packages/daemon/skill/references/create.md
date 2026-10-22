# Create a loop

Use the Pievo command prefix supplied by the user; otherwise use `pievo`. Connect the
machine first when needed.

## Author the loop

Turn the user's task into a standalone prompt grounded in the real project: include
relevant paths, commands, constraints, and expected result. The scheduled agent starts
fresh, so do not rely on this conversation. Store only the task prompt; Pievo appends
the status definitions, loop-file rules, attention line, conciseness rule, and the
final `STATUS:` line contract. Never restate them.

Keep the prompt short: steps and thresholds, not explanations. Every extra line is
read and paid for on every run.

Propose and confirm missing choices:

- **Schedule:** cron for wall-clock work; continuous for a delay after the prior run
  ends. For cron, confirm timezone and whether a busy occurrence should skip or
  coalesce one follow-up.
- **Statuses:** define task-specific, mutually exclusive `keep`, `no-change`, and
  `block` outcomes, one short line each. `block` means the loop cannot continue
  safely without the owner (missing access, broken environment, unsafe action), and
  a completed block run pauses the loop. Findings the owner should see are not a
  block: runs flag them with an `ATTENTION:` line and the loop keeps running. For
  monitoring tasks, say in the prompt what counts as attention-worthy.
- **Tags:** optionally choose up to four custom tags for dashboard filtering. Each
  tag is at most 64 characters; the server normalizes NFKC lowercase, collapses
  whitespace, sorts them, and rejects duplicates, invisible/control characters,
  and all loops/active/paused/blocked.
- **Artifacts:** optionally name up to four text/code files (256 KB each) that runs
  maintain for the dashboard, e.g. `report.md`, `deploy.sh`, or `data.json`. Refer
  to them as `$PIEVO_LOOP_DIR/<name>`. Every loop already has `MEMORY.md`; do not
  list it. In the prompt, give each artifact a fixed, scannable layout:
  - lead with the current verdict, then what changed or needs action;
  - prefer tables, status lists, and short bullets over prose; no run logs (Pievo
    already keeps run history);
  - if the task compares runs (baselines, trends), keep a bounded history section
    in the report (e.g. the last 8 rows of a table) and rewrite it each run.
  Any state that later runs need belongs in an artifact. Never ask runs to keep
  task state, baselines, or trends in `MEMORY.md`.
- **Execution:** confirm the machine workdir, coding agent, optional provider settings,
  and initial enabled state.

## Canonical operation

Consult the current schema before constructing the config. Prefer stdin for a large
prompt:

```bash
<pievo-cli> new --help
<pievo-cli> new --json - --dry-run <<'JSON'
{
  "name": "Daily project check",
  "tags": ["daily", "project"],
  "schedule": {"mode":"cron","cron":"0 9 * * *","timezone":"UTC","overlap":"skip"},
  "workdir": "/absolute/path/to/project",
  "agent": "claude-code",
  "prompt": "Run the project-specific check and record the verified result.",
  "statusDefinitions": {
    "keep": "A verified useful result was produced.",
    "noChange": "The check completed with nothing actionable.",
    "block": "Owner input is required to continue safely."
  },
  "artifacts": [],
  "enabled": true
}
JSON
```

Inspect the normalized preview and fix every rejection. Then run the same command
without `--dry-run`, preserving any supplied server/connect options. Finally use the
created loop identifier with `show --json` and report the actual tags, schedule,
workdir, agent, enabled state, and artifacts as one short table.
