# Pievo Issue Draft Template

```md
## Summary
<!-- One or two sentences. What Pievo behavior is wrong, confusing, or missing? -->

## Type
<!-- bug / improvement / docs / question -->

## Area
<!-- schedule / background task / LOOP / Telegram / Mattermost / tools / prompts / docs / install / config / other -->

## Context
<!-- How was this discovered? group chat / private chat / scheduled run / CLI / logs / docs / other -->

## Why this appears to be Pievo
<!-- One sentence distinguishing Pievo behavior from the user's project or model output. -->

## Environment
- Pievo version or install source:
- OS:
- Node:
- npm:
- Model/provider, if relevant:

## What happened
<!-- Actual behavior. Keep it concrete. -->

## Expected behavior
<!-- What should Pievo have done instead? -->

## Steps to reproduce
1.
2.
3.

## Evidence
<!-- Sanitized logs, errors, screenshots, trace excerpts, or minimal repro files. Screenshots/traces/transcripts must be redacted. Do not include secrets/private data. -->

## Impact
<!-- Who is affected and how often? Is there a workaround? -->

## Possible fix or direction
<!-- Optional. Include if known. -->
```

Before submitting:

- [ ] Title and body are sanitized.
- [ ] No tokens, credentials, cookies, API keys, or private config.
- [ ] No private usernames, chat IDs, channel names, emails, or phone numbers unless approved and redacted.
- [ ] No raw `~/.pievo/` state/session/log dump or `~/.pievo/agents/*/config.json`.
- [ ] No sensitive project file contents, local paths, business data, or customer data.
- [ ] Repro steps are minimal and actionable.
