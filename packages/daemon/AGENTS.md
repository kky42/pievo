# Daemon agent notes

## Provider telemetry

Fixture/unit tests are necessary for collector edge cases but are insufficient for provider JSONL schema validation. Any change that claims to validate Claude Code or Codex telemetry schemas must run the spend-bearing real-CLI test against both providers:

```bash
PIEVO_REAL_LLM_TESTS=1 pnpm --filter @kky42/pievo test src/telemetry.real.test.ts
```

The test is opt-in because it uses real credentials and credits. It must continue to validate both configured models, terminal session ID, exact final text, and positive normalized input/output usage. Pievo captures session IDs for telemetry only and must never resume provider sessions.
