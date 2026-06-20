# Scenario E2E Tests

These are opt-in real-Pi behavior tests for prompt/tool regressions. They replay editable chat scenarios through the same `ChatSession` and Pi tool bridge used by Pievo.

## Run

```bash
npm run test:e2e:scenario -- e2e/scenarios/group-basic.yaml
```

Run all scenario files:

```bash
npm run test:e2e:scenario
```

Useful options:

```bash
npm run test:e2e:scenario -- --model your-provider/your-model --reasoning high --timeout-ms 240000 --verbose
npm run test:e2e:scenario -- --out-dir /tmp/pievo-e2e e2e/scenarios/group-basic.yaml
```

The runner writes `report.json` under the printed temp run directory. The report includes step events, tool calls, visible replies, attachments, schedules, logs, workdir, and Pi session dir.

## Scenario format

Scenarios are YAML using a small supported subset: objects, lists, strings, booleans, numbers, and `|` block strings.

Each step is a checkpoint:

```yaml
steps:
  - id: addressed-question
    messages:
      - from: Alice
        handle: "@alice"
        text: |
          @relaybot summarize notes.txt
    expect:
      toolCalls:
        send_reply: 1
      replies:
        - contains: "summary"
          maxLength: 300
```

Supported expectations:

```yaml
expect:
  noReply: true

  replies:
    - contains: "text"
    - matches: "regex"
    - notContains: "bad"
    - maxLength: 300

  toolCalls:
    send_reply: 1
    add_schedule:
      min: 1
      max: 1

  attachments:
    count: 1
    pathContains: "report"
    kind: document

  schedules:
    count: 0
    contains:
      name: daily-standup
      mode: heartbeat

  errors:
    count: 0

  budgets:
    maxSeconds: 120
```

## Notes

- These tests call a real model and can be non-deterministic.
- They are not part of `npm test`.
- The runner isolates Pi session directories and disables ambient Pi resources, while explicitly loading Pievo's tool extension.
- Provider auth comes from your normal Pi config or provider API-key environment variables.
