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

Pievo appends its own run contract to the stored prompt. Never restate any of it in
a prompt:

- A run ends with `STATUS: ok` (finished, loop continues) or `STATUS: block` (cannot
  continue safely without the owner; pauses the loop). Failed runs are recorded as
  errors, and repeated errors pause the loop.
- A run adds `ATTENTION: <reason>` when the owner should look at something. It flags
  the run and never pauses the loop. Findings use attention, not block.
- Loop files live in `$PIEVO_LOOP_DIR`, not in the workdir:
  - `MEMORY.md` (8000 characters): lessons runs learned the hard way. No task
    instructions, state, results, or history.
  - Up to 4 artifacts (256 KB each): the files the dashboard shows. Task state,
    results, baselines, and bounded history go here.

## Flow

1. **Inspect** the project, connection, existing loops, and real paths. Do not guess.
2. **Propose** the prompt and every open choice in one short table, each with a
   recommended default.
3. **Wait** for the owner's confirmation before any create, edit, file set, or
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
- Inspect, edit, repair, or operate a loop: `references/update.md`
