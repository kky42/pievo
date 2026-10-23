# Investigate, edit, repair, or operate a loop

Start from server state. The in-run agent reads the same history with the same
commands, so what you see is what the loop sees:

```bash
<pievo-cli> loops
<pievo-cli> show <loop> --full             # config, schedule, run counts, prompt, memory
<pievo-cli> log <loop>                     # recent runs: time, status, attention, summary, tokens
<pievo-cli> log <loop> --since <ISO>       # runs in a time window (also --until)
<pievo-cli> log <loop> --attention         # only runs that flagged the owner
<pievo-cli> log <loop> --run <index>       # one run: full response, error, memory notices
```

When asked why a loop misbehaves or how to make it cheaper, look at: runs whose
tokens or duration jump, errors and blocks, attention on routine runs (noise) or
missing on real changes, and memory changes that hold state instead of lessons.

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

## Repair memory

```bash
<pievo-cli> memory <loop>
<pievo-cli> memory set <loop> --from <path>
```

Write the corrected version to a temporary file. Confirm it with the owner, then set
it. An owner edit wins over a run that is in progress.

Keep only lessons learned the hard way, one line each:

- move state, results, baselines, and trends to a small file in the workdir that
  the prompt names, or drop them if the run summary already carries them;
- fold standing rules into the prompt;
- drop run logs, stale facts, and anything that restates the prompt.

If the prompt tells runs to store those things in memory, fix the prompt in the same
change, or the next run will put them back.

## Review whenever you touch a loop

Check only these, and propose a fix for each one you find:

- the prompt writes out `ATTENTION:` or `STATUS:` lines, or their format, or
  memory rules (it should state conditions only);
- the prompt makes an alert stop the loop when the loop could just keep running
  and flag it. Stop conditions the owner chose ("stop if the file is missing") are
  correct; keep them;
- the prompt treats routine work as attention (a digest that ran as usual), asks
  for attention when it means a stop, or never says what is attention for a monitor
  or optimizer;
- `MEMORY.md` holds anything except lessons learned the hard way;
- a workdir state file the prompt keeps grows without bound.

## Lifecycle

These are separate commands, not config edits. Check `--help` for each one first.

| Command | Effect |
|---|---|
| `pause <loop>` | no future runs; the current run continues |
| `start <loop>` | re-enables the schedule, including after a block or failure pause; queued work may start at once |
| `stop <loop>` | pause, cancel queued work, and request termination of the current run; it is canceled only once the daemon confirms |
| `run stop <run>` | stop one run without pausing the loop |
| `delete <loop>` | delete server history and memory, never project files; confirm intent first |

There is no CLI for **Run once**. It is a button on the dashboard's loop page.
