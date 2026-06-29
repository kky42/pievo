---
name: loop
description: Design and operate feedback-driven improvement or maintenance loops with Pievo schedules. Use when a user has an ongoing goal with feedback signals or metrics that should drive repeated observe-act-verify-review cycles, such as improving content performance, iterating Kaggle experiments, or maintaining repo health.
---

# LOOP

Use LOOP to turn a feedback-driven ongoing goal into an inspectable cycle:

```text
goal + feedback signal + project-local state + one-or-more schedules + run protocol + review
```

LOOP is not the basic schedule pattern for reminders, polling, or self-wakeup. Use LOOP only when repeated runs should use feedback to move toward or maintain a goal.

Typical LOOP examples:

- improve content growth using views, likes, comments, or conversion data
- iterate Kaggle hypotheses using local validation and leaderboard feedback
- maintain repo health using issues, CI, bug reports, and review outcomes

Skip LOOP for ordinary reminders, simple polling, one-off delayed follow-up, or recurring checks that do not maintain feedback state.

## Loop state

Default state path in the current workdir:

```text
.loop/<loop-id>/state.md
```

A loop may have one schedule or many schedules. All schedules for the same loop share the same state file.

Use schedule names that include the loop id:

```text
loop-<loop-id>-<purpose>
```

Examples:

```text
loop-content-growth-ideas
loop-content-growth-draft
loop-content-growth-publish
loop-content-growth-feedback
```

Use only these lifecycle states in v1:

```text
active | paused | complete
```

See `refs/state-template.md` when you need the full template.

## Creating a loop

Before creating schedules, create or update `.loop/<loop-id>/state.md` with:

- Loop ID, status, created date, target, objective, feedback signal, current focus
- Schedules: name, mode, cadence, purpose
- Rules: allowed actions and when human review is needed
- Working state: backlog, in progress, done/learned
- Recent runs and next useful action

If a loop needs multiple schedules, keep each schedule task narrow: ideate, draft, publish, collect feedback, triage, review, etc.

## Choosing schedule mode

Use `heartbeat` when the scheduled step should wake the front agent directly:

- lightweight chat-contextual work
- visible follow-up or reminders
- schedule maintenance
- work that needs current conversation context or Pievo chat/schedule tools

Use `background` when the scheduled step should do isolated work first:

- heavier repo scan, research, data collection, trigger detection, or independent operation
- work that can read durable state and report what the front agent should do next

Do not overfit to current runtime details. Use the tools available in the current run. If chat or schedule tools are unavailable, report the needed follow-up in the final response so the front agent can continue.

## Scheduled task text

Scheduled tasks must be self-contained because future runs may not load this skill. Include:

- loop id and state path
- this schedule's purpose
- allowed actions and human-review boundary
- the run protocol: read state, observe, decide, act/report, verify, update state
- expected final response or follow-up recommendation

Do not put schedule creation instructions inside the scheduled task. Put only the future work.

## Run protocol

For every loop run:

1. Read `.loop/<loop-id>/state.md`.
2. If status is `paused` or `complete`, do no substantive work; report or stay silent as appropriate.
3. Observe current facts and feedback signals for this schedule's purpose.
4. Decide the smallest useful next step toward the objective.
5. Act only within the loop rules. If human review is needed, ask or report instead of acting.
6. Verify what changed, what feedback was learned, or why no action was taken.
7. Re-read state before updating when practical, then update the state file.
8. Add one short Recent Runs entry and update Next.

Keep updates narrow. Avoid broad rewrites that could erase another schedule's changes.

## State size discipline

- Keep `state.md` readable.
- Keep Recent Runs to roughly the last 20 entries.
- Compact older details into Done / learned or an optional `archive.md`.
- Do not paste raw logs, full pages, or large experiment output into state.
- Use CSV or SQLite only when the loop truly needs structured records, metrics, time series, deduplication, or querying. Markdown remains the control plane.

## Human review

Default to report-only unless the user clearly authorized actions.

Ask for human review before risky, irreversible, externally visible, or scope-expanding actions. If blocked, record the blocker in state and avoid repeated nagging.

## References

- `refs/state-template.md` — compact state template
- `refs/run-protocol.md` — more detailed run/update guidance
- `refs/schedule-patterns.md` — simple multi-schedule patterns
