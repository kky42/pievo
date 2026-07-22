---
name: pievo
description: Create, update, and evolve scheduled Pievo agent loops from a coding session. Use when the user wants to turn a task they just did into a recurring/scheduled loop, edit an existing loop's schedule or instructions, or asks to build a Pievo loop. A loop can carry a standing optimization objective and runs until its owner pauses or deletes it.
---

# Pievo — build and maintain scheduled loops

Pievo turns a task into a **loop** that runs automatically on a schedule on this
machine. A loop may carry a standing **goal** that guides repeated optimization;
every loop runs until its owner pauses or deletes it. Work end to end; keep questions to quick check-ins, don't run a full
interview. Two check-ins are right: if the session has no real task to loop yet, ask
what to build rather than inventing one (`references/create.md` §1); and when the
user hasn't specified the loop's cadence or per-run output, propose a sensible
default and confirm it before creating (`references/create.md` §2).

Read the reference for the job (they live on disk next to this file, under
`references/`):

- **Creating a loop** (the common case — you just did a task and want it scheduled):
  **`references/create.md`**. It decides what to build, authors the loop's folder +
  task file and an inline config (with an optional goal), and runs `pievo new`.
- **Editing an existing loop** (reschedule, rename, pause, set/clear a goal, or
  change what it does): **`references/update.md`**.
- **How a loop stays coherent and improves over time** (the evolution pass that
  sharpens its **task** from its own run history, then fits its dashboard to the
  data): **`references/evolve.md`**.
- **How a loop behaves each time it runs** (the runtime protocol: the task file as
  memory, surfacing only what changed, the required report grammar, the
  schedule levers, and front-matter product conventions): **`references/run.md`**.

The machine is already connected — this skill was installed at user scope for each
coding agent pievo knows about (Claude Code `~/.claude/skills/pievo/`, Codex
`~/.agents/skills/pievo/`) when it connected via `pievo daemon start`. Just author the
loop and run the `pievo` CLI; the references cover the exact commands.
