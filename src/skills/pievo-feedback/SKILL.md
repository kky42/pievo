---
name: pievo-feedback
description: Help users and agents draft sanitized GitHub issues for observable Pievo runtime, relay, schedule, tool, prompt, docs, install, or config problems. Use when a problem appears to be in Pievo itself rather than only the user's project.
---

# Pievo Feedback

Use this skill to turn real-world Pievo friction into a useful upstream GitHub issue draft.

Repo:

```text
https://github.com/kky42/pievo
```

## When to use

Use when the user or agent encounters observable trouble in Pievo itself, such as:

- schedule, background task, LOOP, or tool behavior is wrong or confusing
- Telegram/Mattermost relay behavior is broken
- prompts/tool descriptions cause repeated bad agent behavior
- docs, install, config, or E2E guidance is missing or unclear
- a real usage pattern exposes a concrete Pievo improvement opportunity

Do not use for ordinary bugs in the user's own project unless Pievo caused or exposed the problem.

## Safety

Never include secrets or private data in an issue.

Before drafting, remove or summarize:

- bot tokens, Mattermost/Telegram tokens, API keys, cookies, credentials
- private usernames, chat IDs, channel names, emails, phone numbers
- private chat transcripts unless the user explicitly approves a redacted excerpt
- raw `~/.pievo/` state, local config files, session files, or logs
- `~/.pievo/agents/*/config.json`, `~/.pievo/state/*`, `~/.pievo/logs/*`
- sensitive project file contents, local paths, business data, or customer data
- issue titles that reveal private names, paths, or incidents

Prefer minimal repros, sanitized snippets, and short logs. Screenshots, traces, and transcripts must be redacted before use.

## Workflow

1. Decide whether this is likely a Pievo upstream issue.
2. Draft from available evidence first. Ask clarifying questions only when the missing answer changes actionability or privacy.
3. Collect minimal sanitized evidence:
   - Pievo version or install source if known
   - OS, Node version, npm version if relevant
   - command or chat action that triggered the issue
   - expected behavior vs actual behavior
   - short repro steps
   - relevant sanitized logs/errors
4. Read `refs/issue-template.md` and draft a GitHub issue in Markdown using that template.
5. Run through the template's pre-submission checklist.
6. Show the draft for human review, inline or as an attachment as appropriate.
7. Submit only after explicit user approval.

Use issue titles like `<area>: <concrete symptom>`, and sanitize the title too.

If `gh` is available and the user explicitly approves submission, write the draft to a temporary file outside the workdir, such as `/tmp/pievo-issue-draft.md`, then run:

```bash
gh issue create --repo kky42/pievo --title "<sanitized-title>" --body-file /tmp/pievo-issue-draft.md
```

Clean up the temporary draft when practical. Otherwise provide the Markdown draft for the user to copy.

## Issue quality bar

A good Pievo issue is:

- specific: names the affected Pievo area
- reproducible or at least evidence-backed
- sanitized
- small enough to act on
- clear about user impact

If the finding is only a vague idea, label it as an improvement idea and explain the observed use case.

After submission, tell the user the issue URL/number if available and that you can help answer maintainer follow-up questions.

## References

- `refs/issue-template.md` — lightweight issue draft template
