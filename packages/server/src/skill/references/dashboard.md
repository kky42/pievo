# Dashboard UI

Dashboard `ui` is small English-only HTML. Set it in `pievo new --json`, `pievo edit <id> --ui-file <file>`, or during an evolve/steer run with `pievo set-ui --file <file>`. Preview create/edit with `--dry-run`; rejected UI changes nothing.

Declare numeric metrics in `metricSchema`. Exec reports must supply every key; charts read the latest 100 successful **exec** runs, selected before the limit. Null, missing, error, or non-numeric points are omitted. Lines connect the remaining valid points. `{{latest.key}}` renders the newest reported scalar or `—`.

## Charts

The old chart-only `series="…"` form is unsupported.

Trend, one or more metrics:

```html
<loop-chart type="line" x="runIndex" series="score:Score:%,cost:Cost:$" y-domain="auto"></loop-chart>
```

Use `x="time|runIndex"`. `series` entries are `key:label:unit`. Put metrics with very different units/scales in separate charts. A single-series line may add `color-by="status"`: every persisted `kept` point is green, every other valid point gray; Pievo applies no keep threshold.

Single-series area:

```html
<loop-chart type="area" x="time" series="score:Score:%"></loop-chart>
```

Metric correlation:

```html
<loop-chart type="scatter" x="metric.batch" y="metric.score" color-by="status" x-label="Batch" y-label="Score"></loop-chart>
```

Both X and Y must be finite. Optional labels/units are `x-label`, `y-label`, `x-unit`, and `y-unit`.

Optimization progress:

```html
<loop-chart type="progress" x="runIndex" y="metric.score" direction="min"></loop-chart>
```

Use `direction="min|max"`. All persisted `kept` points are green; others gray. Running best uses kept points only and has no renderer-side threshold.

Y-axis options:

- omitted or `y-domain="auto"`: padded data extent; best for small changes.
- `y-domain="zero"`: include zero.
- `y-domain="0.94:0.96"`: fixed numeric bounds.

Pievo owns colors, height, axes, tooltip, responsive layout, and sanitization. Do not add JavaScript, formulas, arbitrary Recharts options, or unsupported attributes.

## Artifacts

Paths are relative to the loop content home.

```html
<loop-embed file="latest.md"></loop-embed>
<loop-embed match="reports/*.md"></loop-embed>
<loop-calendar match="reports/*.md"></loop-calendar>
<loop-kanban columns="open,merged" match="cards/*.md"></loop-kanban>
```

`loop-embed match` shows the newest match. Calendar dates products. Kanban groups Markdown by flat front-matter `type`; unmatched types enter Other. Product Markdown should use stable types and dates:

```markdown
---
type: report
title: Daily result
date: 2026-07-23
---
```

Keep UI small: headings and prose plus the few charts/artifact views that answer the loop's standing question. Preserve metric keys, product types, and paths already bound by the dashboard.
