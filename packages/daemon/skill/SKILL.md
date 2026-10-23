---
name: pievo
description: Guided workflow for connecting a machine and creating, inspecting, editing, or operating Pievo scheduled coding-agent loops.
disable-model-invocation: true
---

# Pievo owner workflow

A Pievo loop runs one stored prompt on a schedule, with one coding agent in one
working directory on one machine. Runs of a loop never overlap.

Use the CLI prefix the user gives; otherwise `pievo`. Written below as `<pievo-cli>`.

## What Pievo adds to every run

Pievo wraps the stored prompt in its own header and contract. Never restate any of
it in a prompt:

- The header gives the run number, the current time, and the previous run's time,
  outcome, and summary. A run's summary (at most five lines) is what the next run
  sees first.
- `MEMORY.md` (8000 characters, in `$PIEVO_LOOP_DIR`, not the workdir): lessons
  runs learned the hard way. No task instructions, state, results, or history.
- Task state the next run needs (items seen, baselines, best scores) lives in files
  in the workdir, or in the run summary.
- Inside a run, `pievo log`, `pievo show`, and `pievo memory` read the loop's own
  history (read-only), so a prompt can say "compare with runs since the last
  attention" without saying how.
- A run ends with `STATUS: ok` (finished, loop continues) or `STATUS: block` (cannot
  continue safely without the owner; pauses the loop). Failed runs are recorded as
  errors, and repeated errors pause the loop.
- A run adds `ATTENTION: <reason>` only when the owner will want to see it: a metric
  improved, or something new or changed in what it watches. Routine work (a digest
  or crawl that ran as usual) is never attention. Attention shows green on the
  dashboard and never pauses the loop. Findings use attention; a stop condition
  (missing access, a broken environment) is a block, not attention — the owner
  already sees the pause.

## Flow

1. **Inspect** the project, connection, existing loops, and real paths. Do not guess.
2. **Propose** the prompt and every open choice in one short table, each with a
   recommended default.
3. **Wait** for the owner's confirmation before any create, edit, memory set, or
   lifecycle change.
4. **Check the contract** with `<pievo-cli> <command> --help`, then `--dry-run` and
   fix every rejection.
5. **Apply**, then read the result back (`show --json`) and report it.

Be brief: tables or short lists, only the decisions that matter, no echoed help or
JSON. Leave out anything that is fine and anything the owner didn't ask about.

## References

Read only the one you need:

- Connect this machine: `references/connect.md`
- Create a loop: `references/create.md`
- Investigate, edit, repair, or operate a loop: `references/update.md`
