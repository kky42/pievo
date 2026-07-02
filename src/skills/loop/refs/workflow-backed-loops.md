# Workflow-backed LOOPs

Use a workflow-backed LOOP when a scheduled run needs fixed internal phases, parallel work, or independent quality control for important unattended output.

Good reasons to use a pi-flow workflow:

- parallel speedup: several independent checks, creators, researchers, planners, or implementation lanes can run at once
- fixed mini-process: the loop needs an explicit sequence rather than free-form agent improvisation
- independent quality control: important output should be checked by a separate reviewer, editor, critic, QA, or risk lane
- synthesis discipline: the workflow should make verification, decision boundaries, and final synthesis hard to skip

Do not default every ordinary task to reviewer-heavy workflow. The cost is real. Use review/QA/follow-up lanes when unattended output is risky, externally visible, durable, expensive to undo, or quality-sensitive. Implementation/reviewer/fixer is one workflow shape, not the default shape.

## Ownership model

The front agent owns workflow design:

- create or modify saved workflow files during LOOP setup or explicit review
- keep workflow files inspectable, preferably project-local under `.pi/workflows/`
- create schedules whose task text references existing workflows by name or path
- review or approve risky workflow changes

The background agent owns scheduled execution:

- read `.loop/<loop-id>/state.md`
- run the existing saved workflow when the task references one and the `workflow` tool is available
- synthesize workflow results at the workflow boundary
- update the LOOP state once after synthesis
- record blockers or proposed workflow changes for the front agent only when the workflow cannot safely resolve them internally

Workflow subagents are fresh contexts. They do not inherit LOOP skill guidance, the background agent's conversation context, or the loop state unless the workflow prompt/args provide it. Treat them as scoped domain lanes — such as collector, researcher, creator, editor, analyst, reviewer, QA, operator, fixer, or synthesizer — that return results to the workflow/parent run. If pi-flow supports resuming a subagent inside the same workflow/session, use that only as an internal token-saving continuation; do not store it as durable LOOP identity because `/new` or a different outer session can invalidate it.

## Hard boundaries

Do not put workflow JavaScript in schedule prompts.

Do not ask routine background scheduled runs to create or edit workflow scripts. Background runs may recommend workflow changes, but the front agent should make the durable workflow-file change.

Do not perform the scheduled implementation work during loop setup unless the user explicitly asks for an immediate fix. Setup creates the loop state, saved workflow, and schedule; scheduled background runs execute the workflow later.

Do not let workflow subagents update `.loop/<loop-id>/state.md` directly. The parent background run should update loop state once after it has synthesized the workflow output.

If `workflow` is unavailable, missing, or fails before useful work starts, do not improvise a large single-agent replacement. Record a blocker in `Human Queue` or the final report, including the workflow name/path and the needed install/setup step.

## Saved workflow location

Prefer project-local workflow files when the project is trusted:

```text
.pi/workflows/loop-<loop-id>-<purpose>.js
```

The file must be an executable pi-flow workflow script, not a prose plan. It should start with:

```js
export const meta = { name: 'loop-<loop-id>-<purpose>', description: '...' };
```

Then call `agent()` for the actual worker/reviewer/fixer lanes and return a JSON-serializable synthesis. Do not create placeholder files that only describe a future workflow.

Use global workflows only for generic reusable processes:

```text
~/.pi/agent/workflows/<name>.js
```

Workflow names should include the loop id when they are loop-specific.

## Workflow shapes

Pick lanes that match the loop's domain.

Examples:

```text
important implementation: check -> implement -> independent reviewer -> fixer/synthesis
parallel review: implement -> parallel reviewers (correctness, tests, risk) -> fixer/synthesis
creative: brief researcher -> concept creator -> editor/brand reviewer -> next-draft synthesis
content: idea explorer -> creator -> editor/reviewer -> publish/report synthesis
event planning: requirements scout -> logistics planner -> budget/risk reviewer -> action-list synthesis
research: source collector -> hypothesis analyst -> skeptical reviewer -> next-experiment synthesis
experiment: prepare run -> execute/measure -> result analyst -> leaderboard/report synthesis
```

For important implementation/fix workflows, a single independent review pass is usually enough. Prefer structured review or QA output so routing is explicit, for example `approved`, `needs_followup`, or `blocked` with concrete findings. If the quality-control lane returns `needs_followup`, the workflow should route that feedback to an appropriate follow-up lane and resolve it inside the workflow when safe. Do not require repeated review cycles by default; use them only when the workflow author intentionally pays that cost. Return a blocker to the parent background run only when the workflow cannot safely resolve the issue internally, such as ambiguity, missing credentials, risky scope expansion, publish approval, or verification failure.

For externally visible actions such as publishing, vendor contact, or public announcements, keep the final action behind the loop's human-review rules unless the user clearly authorized autonomous execution.

## Schedule task pattern

A workflow-backed schedule is still a normal `background` schedule. The prompt should reference an existing workflow and explain the state-update contract:

```text
Loop: <loop-id>
State: .loop/<loop-id>/state.md
Purpose: run the existing saved workflow <workflow-name-or-path> for <narrow purpose>.

Protocol:
1. Read the loop state.
2. If the loop is paused or complete, do no substantive work.
3. Run the existing saved workflow <workflow-name-or-path> with args: <compact args>.
4. Synthesize the workflow result. Treat workflow subagents as workers/fixers/reviewers, not LOOP state owners. The workflow should resolve reviewer feedback internally when safe.
5. Update .loop/<loop-id>/state.md once: Working State as needed, one Recent Runs entry, Next, and Human Queue blockers.
6. Final response: concise outcome, verification, blockers, and whether front-agent follow-up is needed.

Do not create, edit, or inline workflow scripts in this scheduled run. If the workflow tool or saved workflow is unavailable, record a blocker instead.
```

## State discipline

For workflow-backed runs, workflow branches should usually gather facts, implement scoped changes, or review work. The parent run should perform the final verification and state update.

Avoid concurrent broad rewrites of `state.md`. Append one concise Recent Runs entry and update only the relevant sections.
