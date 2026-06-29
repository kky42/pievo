# LOOP Schedule Patterns

A loop can own one or many schedules. Prefer multiple narrow schedules over one vague schedule when the work has different cadences or responsibilities.

## Single-schedule loop

Good for simple recurring checks.

```text
loop-repo-health-daily: background, daily, scan repo signals and report actionable issues
```

## Content loop

```text
loop-content-growth-ideas: background, daily, collect signals and propose content ideas
loop-content-growth-draft: background or heartbeat, daily, develop selected ideas into drafts
loop-content-growth-publish: heartbeat, weekly, ask/front-agent publish review or publish if authorized
loop-content-growth-feedback: background, weekly, collect metrics and update lessons
```

## Issue loop

```text
loop-project-issues-triage: background, daily, classify new issues and identify actionable bugs
loop-project-issues-fix: background or heartbeat, daily, work only on authorized bug fixes
loop-project-issues-review: heartbeat, weekly, summarize status and ask for decisions on features/roadmap
```

## Workflow-backed implementation loop

Use when a loop will autonomously modify code or durable runtime/agent behavior over time, or when it needs a fixed mini-workflow, independent reviewer, or parallel lanes.

```text
loop-project-fix-workflow: background, nightly, run existing workflow .pi/workflows/loop-project-fix-workflow.js for check -> implement -> review -> summarize
loop-project-fix-review: heartbeat, weekly, summarize Human Queue blockers and ask for approvals
```

The schedule remains ordinary `background`; the task text references an existing saved workflow and forbids inline workflow scripts.

## Experiment or competition loop

```text
loop-kaggle-hypotheses: background, daily, inspect papers/discussions/results and propose hypotheses
loop-kaggle-experiments: background, nightly, run authorized local experiments and update results
loop-kaggle-review: heartbeat, weekly, summarize progress and ask for submission/strategy decisions
```

## Mode hints

Use `heartbeat` when the step needs the front agent, chat context, visible user interaction, or schedule tools.

Use `background` when the step is mostly scanning, researching, collecting data, trigger detection, workflow-backed execution, or independent work before front-agent review.

Workflow-backed background schedules should point to an existing saved workflow by name or path. The front agent creates or modifies workflow files; scheduled background runs execute them and update loop state after synthesis.

Every schedule task should name its loop id and state path, then state its narrow purpose.
