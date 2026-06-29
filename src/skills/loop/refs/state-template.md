# LOOP State Template

Create one state file per loop:

```text
.loop/<loop-id>/state.md
```

Template:

```md
# LOOP: <loop-id>

Loop ID: <loop-id>
Status: active | paused | complete
Created: YYYY-MM-DD
Target: <repo/project/account/process>
Objective: <ongoing improvement or maintenance goal>
Feedback signal: <metric, observation, user response, CI/issues, leaderboard, analytics, or other signal that drives the loop>
Current focus: <what the next runs should pay attention to>

## Schedules
- loop-<loop-id>-<purpose>: <heartbeat|background>, <cadence>, <purpose>

## Workflows
- <workflow-name-or-path>: <purpose, owner, and when schedules may run it>

## Rules
Allowed actions:
- <what the agent may do without asking>

Human review needed when:
- <risky, irreversible, externally visible, or scope-expanding actions>

## Working State
Backlog:
- <candidate work/items/signals>

In progress:
- <current item and owner/status>

Done / learned:
- <stable conclusions, useful decisions, compacted history>

## Human Queue
- [ ] HQ-001: <decision, approval, credential/access, risky action, or workflow/setup blocker>
  - status: open
  - first_seen: YYYY-MM-DD
  - last_asked: YYYY-MM-DD or never
  - context: <short context and next human action>

## Recent Runs
- YYYY-MM-DD HH:mm — <schedule-name>: <short outcome, evidence, next implication>

## Next
Next useful action: <one concrete next step>
Review: <what to check before changing, pausing, or completing this loop>
```

Guidelines:

- If there is no feedback signal, this is probably a normal schedule, not a LOOP.
- Keep `Recent Runs` to roughly 20 entries.
- Compact old details into `Done / learned` or optional `archive.md`.
- Keep raw data elsewhere; link or summarize it here.
- Use `Human Queue` instead of asking the same question in every scheduled run.
- Workflow-backed runs should let the parent run update this state once after synthesis; workflow subagents should not edit this file directly.
- If using CSV/SQLite for high-volume data, keep this file as the human-readable control plane.
