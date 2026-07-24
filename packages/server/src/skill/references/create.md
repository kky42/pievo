# Create a loop

This machine is already connected — `pievo daemon start` on first capture (see `bootstrap.md`) or the daemon that's been running since. Decide what to build, author it, create it. Use the **pievo-cli** prefix the user pasted (default `pievo`) and, on the first-capture path, the **connect-key** from the capture snippet.

## 1 · Decide what to build

A loop only makes sense with a real task behind it. Read the session you're in and pick the starting point:

- **The user already did a clear task this session**: turn that task into the loop, grounded in the real URLs, paths, commands, and thresholds from the session.
- **The capture snippet carries a task description**: that description is the intent. Build exactly that loop, grounded in this project's real paths and commands, and confirm anything it leaves open.
- **There's no task yet**: don't invent a loop. Inspect what this project is, propose a few concrete loops that would be useful FOR IT, and let the user pick.

Only continue once there's a real intent.

## 2 · Settle cadence, output, and the objective

Never silently guess how often the loop runs or what each run produces: propose → confirm → build. Propose sensible defaults for this specific task, in one short message, and get a yes or adjustment before creating.

- **Cadence.** Choose **cron** for wall-clock work (for example, every day at 9am your time, every hour, or Monday morning) or **continuous** when the next exec should become ready a fixed number of minutes after the previous exec ends. Continuous delay is at least 1 minute.
- **Per-run output.** Propose the concrete artifact or message format, e.g. a short markdown summary in `report.md`, a dated markdown product, or a one-line status.
- **Cheap checks**: if the loop needs a cheap deterministic check, put it in the task file SOP. The exec agent runs the check first; if nothing changed, it reports `no-change` and stops.
- **Markdown products**: if runs write markdown products, choose a small fixed `type:` vocabulary up front and use flat front matter (`type:`, `title:`, `date:`) so dashboard primitives can index them.
- **Standing objective — when useful**: optimization tasks may get a one-line `goal` that guides every run. It never stops the loop; all loops run until the owner pauses or deletes them.

## 3 · Create README.md and COOKBOOK.md

Every loop gets its own folder under the project: `<project>/pievo/<slug>/`. It contains the authoritative standing instructions, bounded learned context, and lightweight products.

This folder is a synced content home, not a scratch workspace. Heavy work products — repo checkouts, git worktrees, `node_modules`, build output, caches — must live outside the loop folder. Write only finished reports/artifacts back into the loop folder.

Write `<project>/pievo/<slug>/README.md` with standing instructions only. It has one required section:

```markdown
# <Loop name>

## Spec
<What this loop checks or does and why; its concrete SOP, commands, endpoints, files, output and notification rules, cheap early checks, and product conventions. State mode: maintenance|optimization|mixed when that distinction helps interpret no-change evidence.>
```

Write its sibling `<project>/pievo/<slug>/COOKBOOK.md` exactly as the initial bounded learned-context shell:

```markdown
# Cookbook
Consolidated through: #0

## Knowledge

## Timeline
```

Knowledge will hold durable facts plus reusable positive and negative lessons. Timeline is reserved for evolve/steer decision boundaries, never one entry per exec. Keep the absolute path to `README.md`; it goes in config as `taskFile`. The Cookbook path is inferred beside it and is not a config field.

## 4 · Author the loop config

A loop uses `scheduleMode: "cron" | "continuous"`. Cron fires at wall-clock occurrences. Continuous enqueues its next exec only after an exec ends (`done` or `error`) plus `continuousDelayMinutes`; canceled runs, paused loops, and steer/evolve runs do not continue it.

Author the config inline and pass it to `pievo new --json`:

```json
{
  "name": "short human name",
  "cron": "m h dom mon dow",
  "scheduleMode": "cron",
  "continuousDelayMinutes": 1,
  "goal": "<optional one-line standing objective>",
  "workdir": "<absolute project dir>",
  "taskFile": "<absolute path to the task file above>",
  "model": "<optional coding-agent model id>",
  "reasoningEffort": "<optional provider effort value>",
  "metricSchema": [{ "key": "x", "label": "X", "unit": "" }],
  "ui": "<small dashboard HTML — optional>",
  "notify": "auto"
}
```

Rules:

- Include `taskFile`. There is no `task` field; the agent's standing brief is the task file. Its parent directory becomes the synced **loop content home** for Cookbook, reports, dashboard UI, and small artifacts.
- Set `workdir` to the absolute project directory when the loop should run in that project. This is the provider's **execution workspace (cwd)**, not the artifact root; it can differ from the loop content home.
- `scheduleMode` defaults to `cron`. For continuous work set `scheduleMode: "continuous"` and choose `continuousDelayMinutes` (integer >= 1). Keep a valid `cron`; continuous ignores it but Pievo retains it so switching back restores the prior cadence.
- `goal` is an optional standing objective. It never changes lifecycle state.
- `model` and `reasoningEffort` are optional arbitrary strings. Include them only when the owner explicitly requests it.
- `metricSchema` is optional; declare numeric per-run metrics to get a chart. Every exec report then supplies all values with `--metrics` (number or `null`).
- `ui` is optional; include a day-one dashboard only when the product/metric shape is already settled.

### Dashboard at create

When the product shape is known, author the initial `ui` now so the loop has a day-one dashboard. Read `dashboard.md`; bind only declared metrics and documented product types. Keep the UI small and verify it with `--dry-run`.
- `notify`: `auto` (only when there's something to say) | `always` | `never`.
- Don't add `timezone`, `claim`, or auth fields — `pievo new` injects the timezone, connect-key claim, and device token.

## 5 · Validate, then create

Preview first:

```bash
<pievo-cli> new --json '<config>' --dry-run
```

Check the normalized objective and fire times look right. If you authored a `ui` and the preview warns that it was not applied, fix the HTML before creating.

Then create for real:

```bash
<pievo-cli> new \
  --json '<config>' \
  --connect-key <connect-key> \
  --agent claude-code
```

`pievo new` detects timezone, injects the claim, records the coding agent, authenticates, validates, and POSTs it. On success, tell the user the loop name + cadence and that the first run will come automatically shortly.
