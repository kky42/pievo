# Inspect, edit, repair, or operate a loop

Start from server state:

```bash
<pievo-cli> loops
<pievo-cli> show <loop> --json
<pievo-cli> log <loop>            # recent runs; see log --help for run detail
```

## Edit config

Patch only the fields the owner asked to change. `schedule` is always replaced as a
whole. Propose the change, wait for confirmation, then:

```bash
<pievo-cli> edit --help
<pievo-cli> edit <loop> --json - --dry-run <<'JSON'
{"prompt": "..."}
JSON
```

Run the same command without `--dry-run`. Report what changed as a short before/after
list taken from `show <loop> --json`.

## Repair a loop file

```bash
<pievo-cli> file get <loop> <name>
<pievo-cli> file set <loop> <name> --from <path>
```

Write the corrected version to a temporary file. Confirm it with the owner, then set
it. An owner edit wins over a run that is in progress.

When repairing `MEMORY.md`, keep only lessons learned the hard way, one line each:

- move state, results, baselines, and trends to an artifact (bounded history);
- fold standing rules into the prompt;
- drop run logs, stale facts, and anything that restates the prompt.

If the prompt tells runs to store those things in memory, fix the prompt in the same
change, or the next run will put them back.

## Review whenever you touch a loop

Check only these, and propose a fix for each one you find:

- the prompt writes out `ATTENTION:` or `STATUS:` lines, or their format, or
  loop-file rules (it should state conditions only);
- the prompt makes an alert stop the loop when the loop could just keep running
  and flag it. Stop conditions the owner chose ("stop if the file is missing") are
  correct; keep them;
- `MEMORY.md` holds anything except lessons learned the hard way;
- artifacts asked to keep run logs or unbounded history.

## Lifecycle

These are separate commands, not config edits. Check `--help` for each one first.

| Command | Effect |
|---|---|
| `pause <loop>` | no future runs; the current run continues |
| `start <loop>` | re-enables the schedule, including after a block or failure pause; queued work may start at once |
| `stop <loop>` | pause, cancel queued work, and request termination of the current run; it is canceled only once the daemon confirms |
| `run stop <run>` | stop one run without pausing the loop |
| `delete <loop>` | delete server history, memory, and artifacts, never project files; confirm intent first |

There is no CLI for **Run once**. It is a button on the dashboard's loop page.
