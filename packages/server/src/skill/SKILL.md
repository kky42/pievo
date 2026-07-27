---
name: pievo
description: Connect a machine to Pievo and create or edit scheduled prompt loops. Use when the user wants a coding-agent prompt to run on a cron or continuous schedule, or wants to change an existing loop's prompt, schedule, status definitions, artifacts, agent, or provider settings.
---

# Pievo — connect, create, and edit scheduled prompts

Pievo runs a server-stored prompt with a selected coding agent in a configured working
directory. It records each run's status and message and can copy explicitly configured
files for viewing in Pievo.

Read only the reference needed for the request:

- **Connect this machine to a Pievo server:** `references/connect.md`
- **Create a loop:** `references/create.md`
- **Edit an existing loop:** `references/update.md`

Keep the flow short. Ground prompts and paths in the user's real project, propose any
missing schedule or outcome definitions, and confirm those choices before creating or
editing. Pievo appends the complete runtime report contract to every delivered prompt;
do not make the installed skill a runtime dependency.
