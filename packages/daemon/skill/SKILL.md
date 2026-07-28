---
name: pievo
description: Use when the user asks to connect a machine to Pievo, create a scheduled coding-agent loop, or inspect or change an existing loop's configuration or lifecycle.
---

# Pievo owner workflow

Pievo stores a prompt and schedule on the server, then asks the daemon on the user's
machine to run one selected coding agent in one fixed working directory. A loop is
serialized: cron occurrences may skip or coalesce one follow-up, while continuous
waits until the prior run ends.

Use this skill for owner-side setup and management. Pievo supplies scheduled runs
with their status and report instructions separately; keep those instructions out of
the stored prompt.

Artifacts are explicit uploads of exact workdir-relative files, not scans or globs.
Treat every configured path as a deliberate upload decision.

Use this flow:

1. **Understand** the task, desired outcome, and requested operation.
2. **Inspect** the project, connection, existing loop, and real paths; do not guess.
3. **Propose** the prompt and any missing schedule, status, provider, or artifact choices.
4. **Confirm** choices with product meaning or side effects.
5. **Consult help** with `<pievo-cli> <command> --help` for the installed command contract.
6. **Dry-run** create/edit operations and inspect the normalized preview.
7. **Mutate** only after confirmation and successful validation.
8. **Show result** by reading the resulting loop state rather than trusting only an exit code.

Read only the reference needed:

- Connect this machine: `references/connect.md`
- Create a loop: `references/create.md`
- Inspect, edit, or operate a loop: `references/update.md`
