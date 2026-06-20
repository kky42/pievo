# AGENTS

## Project

This repo is `pievo` (Pi Evolution): a Pi-only chat relay for long-running Telegram/Mattermost assistants.

It was forked from `anyagent`, but the active runtime should stay Pi-native:

- Do not reintroduce Codex or Claude adapters.
- Do not reintroduce legacy text output contracts (`REPLY`, `NO_REPLY`, `ATTACH`) as the primary delivery path.
- Group-chat visible output must go through the Pi-native `send_reply` tool.
- File delivery must go through the Pi-native `send_attachment` tool.
- Schedule management should use `add_schedule`, `list_schedule`, and `remove_schedule`.

## Shell Environment

- `node`, `npm`, and `npx` are available directly in this repo.
- If a future shell cannot resolve them, use:

```bash
source ~/.zshrc >/dev/null 2>&1 && <command>
```

## Prompt Files

Keep model-facing prompt content centralized under `src/prompts/`:

- `additional-system/` for appended system prompt blocks.
- `tools/chat-tools.json` for Pi tool labels, descriptions, snippets, guidelines, and parameter descriptions.
- `templates/` for generated message prompts such as attachments, group transcripts, references, and scheduled turns.

Do not scatter new model-facing prompt strings through runtime code unless they are errors or user-facing UI copy.

## Tests

Run the active Pi-only unit suite:

```bash
npm test
```

The copied legacy tests are not all part of the active test script unless they are updated for Pi-native tools.

## Secrets

- Never commit Telegram bot tokens, Mattermost tokens, real usernames, or local runtime config.
- Runtime state belongs under `~/.pievo/` and must remain local.
