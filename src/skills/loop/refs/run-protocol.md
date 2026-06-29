# LOOP Run Protocol

Each scheduled run should be small and inspectable.

## Before acting

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
- one `Recent Runs` bullet
- `Next`

Avoid broad rewrites. Keep the state human-readable.

## Completion

Mark `Status: complete` only when the loop objective is done or the user explicitly retires it.

Mark `Status: paused` when the loop is blocked, waiting for review, or no longer should run automatically.
