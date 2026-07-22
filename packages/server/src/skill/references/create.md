# Create a loop

This machine is already connected — `pievo daemon start` on first capture (see `bootstrap.md`) or the daemon that's been running since. Decide what to build, author it, create it. Use the **pievo-cli** prefix the user pasted (default `pievo`) and, on the first-capture path, the **connect-key** from the capture snippet.

## 1 · Decide what to build

A loop only makes sense with a real task behind it. Read the session you're in and pick the starting point:

- **The user already did a clear task this session**: turn that task into the loop, grounded in the real URLs, paths, commands, and thresholds from the session.
- **The capture snippet carries a task description**: that description is the intent. Build exactly that loop, grounded in this project's real paths and commands, and confirm anything it leaves open.
- **There's no task yet**: don't invent a loop. Inspect what this project is, propose a few concrete loops that would be useful FOR IT, and let the user pick.

Only continue once there's a real intent.

## 2 · Settle cadence, output, and the finish line

Never silently guess how often the loop runs or what each run produces: propose → confirm → build. Propose sensible defaults for this specific task, in one short message, and get a yes or adjustment before creating.

- **Cadence.** Choose **cron** for wall-clock work (for example, every day at 9am your time, every hour, or Monday morning) or **continuous** when the next exec should become ready a fixed number of minutes after the previous exec ends. Continuous delay is at least 1 minute.
- **Per-run output.** Propose the concrete artifact or message format, e.g. a short markdown summary in `report.md`, a dated markdown product, or a one-line status.
- **Cheap checks**: if the loop needs a cheap deterministic check, put it in the task file SOP. The exec agent runs the check first; if nothing changed, it reports `no-change` and stops.
- **Markdown products**: if runs write markdown products, choose a small fixed `type:` vocabulary up front and use flat front matter (`type:`, `title:`, `date:`) so dashboard primitives can index them.
- **Finish line — only for goal-shaped tasks**: only goal-shaped tasks get a one-line checkable `goal`. Monitor/digest loops omit `goal` and run until paused.

## 3 · Create the loop's folder and task file

Every loop gets its own folder under the project: `<project>/pievo/<slug>/`. Its task file lives there, and lightweight products land there too.

This folder is a synced content home, not a scratch workspace. Heavy work products — repo checkouts, git worktrees, `node_modules`, build output, caches — must live outside the loop folder. Write only finished reports/artifacts back into the loop folder.

Write `<project>/pievo/<slug>/README.md`:

```markdown
# <Loop name>

## Spec
What this loop checks or does and why, plus the concrete steps / commands / endpoints / files involved. State when to message the user vs. stay silent. If there is a cheap deterministic check, put it here as the first SOP step and say to report `no-change` when it finds no actionable change. If the loop writes markdown products, state the fixed front-matter vocabulary.

## Current understanding
The baseline / known state / open issues seeded from this session; each run updates it.

## Timeline
<!-- one dated entry per run, appended below by the loop -->
```

Keep the absolute path to `README.md`; it goes in the config as `taskFile`.

## 4 · Author the loop config

A loop uses `scheduleMode: "cron" | "continuous"`. Cron fires at wall-clock occurrences. Continuous enqueues its next exec only after an exec ends (`done` or `error`) plus `continuousDelayMinutes`; canceled runs, paused/completed loops, and edit/evolve runs do not continue it.

Author the config inline and pass it to `pievo new --json`:

```json
{
  "name": "short human name",
  "cron": "m h dom mon dow",
  "scheduleMode": "cron",
  "continuousDelayMinutes": 1,
  "goal": "<one-line checkable finish line — omit for a monitor loop>",
  "workdir": "<absolute project dir>",
  "taskFile": "<absolute path to the task file above>",
  "model": "<optional coding-agent model id>",
  "reasoningEffort": "<optional provider effort value>",
  "stateSchema": [{ "key": "x", "label": "X", "unit": "" }],
  "ui": "<small dashboard HTML — optional>",
  "notify": "auto"
}
```

Rules:

- Include `taskFile`. There is no `task` field; the agent's standing brief is the task file.
- Set `workdir` to the absolute project directory when the loop should run in that project.
- `scheduleMode` defaults to `cron`. For continuous work set `scheduleMode: "continuous"` and choose `continuousDelayMinutes` (integer >= 1). Keep a valid `cron`; continuous ignores it but Pievo retains it so switching back restores the prior cadence.
- `goal` makes the loop closed: each exec run judges it and calls `pievo finish` when met. Omit `goal` for a monitor/digest loop.
- `model` and `reasoningEffort` are optional arbitrary strings. Include them only when the owner explicitly requests it.
- `stateSchema` is optional; declare numeric per-run metrics to get a chart. The exec agent records values with `pievo report --state`.
- `ui` is optional; include a day-one dashboard only when the product/metric shape is already settled.

### Dashboard at create

When the product shape is already known, author the initial `ui` now so the loop has a day-one dashboard. Use the primitives from `evolve.md` §3 and bind only declared metrics / documented product types.
- `notify`: `auto` (only when there's something to say) | `always` | `never`.
- Don't add `timezone`, `claim`, or auth fields — `pievo new` injects the timezone, connect-key claim, and device token.

## 5 · Validate, then create

Preview first:

```bash
<pievo-cli> new --json '<config>' --dry-run
```

Check the classification matches your intent and the fire times look right. If you authored a `ui` and the preview warns that it was not applied, fix the HTML before creating.

Then create for real:

```bash
<pievo-cli> new \
  --json '<config>' \
  --connect-key <connect-key> \
  --agent claude-code
```

`pievo new` detects timezone, injects the claim, records the coding agent, authenticates, validates, and POSTs it. On success, tell the user the loop name + cadence and that the first run will come automatically shortly.
