# Create a loop

Connect the machine first if needed (`connect.md`).

## Prompt

Write a standalone task prompt grounded in the real project, with paths, commands,
thresholds, and the expected result. The run starts fresh and cannot see this
conversation. Keep it short (steps and thresholds, no explanations), because every
line is paid for on every run.

The prompt must say:

- what counts as attention, as a condition the run can check. Match the loop's kind:
  - optimization: a metric beat the best so far ("p95 latency below the best
    recorded");
  - monitoring: something new or changed ("a new release", "a port that was
    closed is open");
  - digest or crawl: usually nothing. Doing the job is not attention, so say so
    only if one specific finding should stand out.
- what would make the loop unable to continue safely, if that's specific to the task
  (for example, "credentials expired"). Say that the run stops; Pievo pauses the
  loop. This is a block, never attention.
- where the run keeps state it compares against, when it needs any: a small file in
  the workdir (for example, `.loop/best.json`), bounded and rewritten each run. Short
  state (one number, the latest item id) can ride in the summary instead.
- where output goes, if the task produces any: files in the workdir.

State attention and block as conditions only ("usage above 80%", "if the file is
missing, the loop cannot continue"). Never ask for attention when the loop should
stop; the pause already tells the owner. Never write `ATTENTION:` or `STATUS:` lines,
their format, memory rules, or how to read history into the prompt. Pievo adds all
of that.

## Choices to propose

| Choice | Options |
|---|---|
| Schedule | `cron` (wall clock: cron, IANA timezone, overlap `skip` or `queue-one`) or `continuous` (`delayMinutes` after the previous run ends) |
| Execution | absolute workdir on this machine; agent `claude-code`, `codex`, or `pi`; optional model and reasoningEffort; enabled |
| Tags | up to 4, optional, for dashboard filtering |

Every loop already has `MEMORY.md`; it is not configured. The `new --help` output
and the dry-run are the authority for fields and limits.

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
  "prompt": "Run `pnpm test` and `pnpm lint`. Attention: a check that passed in the previous run now fails.",
  "enabled": true
}
JSON
```

Keep the quoted `'JSON'` heredoc so the shell doesn't expand anything in the prompt.
Fix every rejection, then run the same command without `--dry-run`. Report the result
from `show <loop> --json` as one short table: name, schedule, workdir, agent,
enabled, and tags. Tell the owner that **Run once** on the dashboard
starts a first run now.
