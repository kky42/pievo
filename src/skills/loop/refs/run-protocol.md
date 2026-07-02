# LOOP Run Protocol

Each scheduled run should be small and inspectable. The schedule is only the clock; LOOP continuity lives in `.loop/<loop-id>/` files. Do not rely on a prior chat session or subagent `session_key` for long-term state.

## Before acting

0. When the harness scripts are available, start a run ledger entry with `loop-run.mjs start <loop-id> --lane <manager|worker|reviewer|auditor|submitter> ...`. For long work, write heartbeat entries.
1. Read `.loop/<loop-id>/state.md`.
2. Check `Status`:
   - `active`: continue.
   - `paused`: do not act; only report if the user needs to know.
   - `complete`: do not act; preserve state for review.
3. Confirm this schedule's purpose in `## Schedules`.
4. Observe the current facts and feedback signals relevant to that purpose.

## Decide and act

Choose the smallest useful next step toward the loop objective.

- If action is allowed by `## Rules`, perform it.
- If action needs human review, ask/report instead of acting.
- If no useful signal exists, record a short no-op and avoid noisy user notification.

For background runs, assume chat/schedule tools may be unavailable. Put needed follow-up in the final response so the front agent can continue.

If this is a workflow-backed run, run only an existing saved workflow referenced by the scheduled task. Do not create, edit, or inline workflow scripts during routine scheduled execution. If the workflow tool or saved workflow is unavailable, record a blocker instead of replacing the workflow with an ad-hoc single-agent attempt.

## Verify

Record evidence, not vibes:

- what changed
- what was checked
- what feedback signal was observed
- why no action was taken
- what failed or is uncertain

## Update state

Before writing, re-read state when practical to avoid overwriting another schedule's update.

Update only the relevant sections:

- `Current focus`
- `Working State`
- `Human Queue` when human input or workflow setup is needed
- one `Recent Runs` bullet
- `Next`

For workflow-backed runs, synthesize workflow output first and update state once from the parent run. Workflow subagents are fresh contexts and should not write `.loop/<loop-id>/state.md` directly.

Avoid broad rewrites. Keep the state human-readable.

## Completion

Before exiting, record durable outcomes:

- `loop-run.mjs finish` for successful/no-op runs, or `loop-run.mjs fail` for failures.
- `loop-task.mjs done|block|fail` for any task touched.
- `loop-metric.mjs add` when a true or proxy metric was observed.
- `loop-audit.mjs` or `loop-next-action.mjs` when deciding repair/dispatch/escalation.

Mark `Status: complete` only when the loop objective is done or the user explicitly retires it.

Mark `Status: paused` when the loop is blocked, waiting for review, or no longer should run automatically.
