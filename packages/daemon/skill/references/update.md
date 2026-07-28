# Edit an existing loop

Use the same **pievo-cli** prefix used to connect the machine (default `pievo`). The
machine's persisted device credential authorizes edits to loops bound to it.

Find the loop and inspect its current editable envelope:

```bash
<pievo-cli> loops
<pievo-cli> show <loop-id> --json
```

Patch only the requested fields with one JSON object. Preview before applying:

```bash
<pievo-cli> edit <loop-id> --json '<patch>' --dry-run
<pievo-cli> edit <loop-id> --json '<patch>'
```

Accepted fields are:

| field | value |
|---|---|
| `name` | non-empty string |
| `schedule` | complete cron or continuous schedule object |
| `workdir` | absolute working-directory path |
| `agent` | `claude-code` or `codex` |
| `model` | string or `null` for provider default |
| `reasoningEffort` | string or `null` for provider default |
| `prompt` | non-empty string, preserved as written |
| `statusDefinitions` | complete `{keep,noChange,block}` object with non-empty strings |
| `artifacts` | array of exact paths relative to `workdir` |
| `enabled` | boolean |

Schedule examples:

```bash
<pievo-cli> edit <loop-id> --json '{"schedule":{"mode":"cron","cron":"0 9 * * 1-5","timezone":"Europe/London","overlap":"queue-one"}}'
<pievo-cli> edit <loop-id> --json '{"schedule":{"mode":"continuous","delayMinutes":15}}'
```

Other examples:

```bash
<pievo-cli> edit <loop-id> --json '{"prompt":"Run the verified release check and summarize only actionable findings."}'
<pievo-cli> edit <loop-id> --json '{"statusDefinitions":{"keep":"A verified action was completed.","noChange":"The check completed with nothing actionable.","block":"Owner input is required."}}'
<pievo-cli> edit <loop-id> --json '{"artifacts":["release-check.md"]}'
<pievo-cli> edit <loop-id> --json '{"model":null,"reasoningEffort":null}'
```

Important constraints:

- Replacing `schedule` requires one complete exclusive shape. Cron requires `cron`,
  `timezone`, and `overlap`; continuous requires only `delayMinutes`.
- Replacing `statusDefinitions` requires all three definitions.
- Artifact entries are exact stable file paths, not globs. They must be relative to
  `workdir` and cannot traverse outside it.
- The server validates every field and rejects unknown keys without mutating the loop.
- Pievo appends the runtime report contract to `prompt`; do not duplicate it in the
  stored prompt.

Run once is intentionally a Web action: use **Run once** on the loop detail page.
For Pause, Start, Stop, Delete, and history, use `<pievo-cli> --help` and the
relevant command's `--help` instead of treating lifecycle operations as
prompt-authoring fields.
