# Inspect, edit, or operate a loop

Use the same Pievo command prefix used to connect the machine. Start from server state:

```bash
<pievo-cli> loops
<pievo-cli> show <loop> --json
```

For a config change, including replacing a loop's tags, patch only the fields requested
by the user. Propose and confirm any changed product choices, then consult the installed
contract and preview first:

```bash
<pievo-cli> edit --help
<pievo-cli> edit <loop> --json '<patch>' --dry-run
<pievo-cli> edit <loop> --json '<patch>'
<pievo-cli> show <loop> --json
```

Use the final `show` output to report what actually changed. Pievo appends the runtime
report contract, so never duplicate it in a stored prompt.

Lifecycle operations are not config edits. Consult the relevant command help and keep
these distinctions in mind:

- **Pause:** prevents future runs; the current run continues.
- **Start:** re-enables the schedule; preserved queued work may become eligible immediately.
- **Stop:** pauses, cancels queued work, and requests current-run termination; wait for
  daemon proof before treating a running run as canceled.
- **Run stop:** stops one run without pausing its loop.
- **Delete:** removes Pievo server history and synced artifact metadata, never local
  project files. Confirm destructive intent; force delete has stronger caveats in help.

Run once is a Web action on the loop detail page; there is no owner CLI run-once
command. Use `log --help` for history and run-detail queries.
