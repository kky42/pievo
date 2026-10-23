# Create a loop

Connect the machine first if needed (`connect.md`).

## Prompt

Write a standalone task prompt grounded in the real project, with paths, commands,
thresholds, and the expected result. The run starts fresh and cannot see this
conversation. Keep it short (steps and thresholds, no explanations), because every
line is paid for on every run.

The prompt must say:

- what counts as attention-worthy (for checks and monitors);
- what would make the loop unable to continue safely, if that's specific to the task
  (for example, "credentials expired");
- each artifact's layout: current verdict first, then what changed or needs action.
  Use tables and short lists, and no run logs. If runs compare against earlier
  runs, keep a bounded history section (for example, the last 8 rows) and rewrite
  it every run.

State attention and block as conditions only ("usage above 80%", "if the file is
missing, the loop cannot continue"). Never write `ATTENTION:` or `STATUS:` lines,
their format, or the loop-file rules into the prompt. Pievo appends all of that.

## Choices to propose

| Choice | Options |
|---|---|
| Schedule | `cron` (wall clock: cron, IANA timezone, overlap `skip` or `queue-one`) or `continuous` (`delayMinutes` after the previous run ends) |
| Execution | absolute workdir on this machine; agent `claude-code`, `codex`, or `pi`; optional model and reasoningEffort; enabled |
| Artifacts | up to 4 file names, or none (see below) |
| Tags | up to 4, optional, for dashboard filtering |

Artifacts must be text or code files. Each name uses letters, digits, `.`, `_`, and
`-`, up to 64 characters plus a known extension. The dashboard shows:

- `.md` as rendered Markdown;
- `.html` in a sandboxed frame, so keep it self-contained (inline CSS and JS);
- `.svg` as an image;
- anything else (`.json`, `.csv`, `.sh`, `.py`, `.txt`, …) as source.

Runs can't create other files in `$PIEVO_LOOP_DIR`. Do not list `MEMORY.md`, which
every loop already has. The `new --help` output and the dry-run are the authority for
names and limits.

## Create

```bash
<pievo-cli> new --help
<pievo-cli> new --json - --dry-run <<'JSON'
{
  "name": "Daily project check",
  "tags": ["daily"],
  "schedule": {"mode": "cron", "cron": "0 9 * * *", "timezone": "UTC", "overlap": "skip"},
  "workdir": "/absolute/path/to/project",
  "agent": "claude-code",
  "prompt": "Run the project check and update $PIEVO_LOOP_DIR/report.md.",
  "artifacts": ["report.md"],
  "enabled": true
}
JSON
```

Keep the quoted `'JSON'` heredoc so the shell doesn't expand `$PIEVO_LOOP_DIR`. Fix
every rejection, then run the same command without `--dry-run`. Report the result
from `show <loop> --json` as one short table: name, schedule, workdir, agent,
enabled, artifacts, and tags. Tell the owner that **Run once** on the dashboard
starts a first run now.
