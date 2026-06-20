# Pievo

Pievo (Pi Evolution) is an additional harness layer for durable agents: orchestration, memory, and continuous evolution on top of Pi.

The current implementation starts with a Pi-native chat relay for long-running assistants in Telegram and Mattermost. This repo was forked from `anyagent` and simplified to target Pi only. Codex/Claude adapters and text output contracts have been removed from the active runtime.

## Prompt files

Model-facing prompts and templates are centralized under `src/prompts/`:

- `additional-system/` — private/group appended system prompt blocks
- `tools/chat-tools.json` — tool labels, descriptions, snippets, guidelines, and parameter descriptions
- `templates/` — generated message templates for attachments, group transcripts, references, and scheduled turns

## Native Pi tools

Pievo's current chat relay injects a Pi extension into front-agent runs. The extension registers chat-native tools:

- `send_reply` — send visible group-chat replies. Group chats only.
- `send_attachment` — send a local file to the current chat.
- `add_schedule` — add a heartbeat/background schedule for the current chat.
- `list_schedule` — list schedules for the current chat.
- `remove_schedule` — remove a schedule from the current chat.

Group-chat visibility is tool-driven: final assistant text is suppressed in groups, and only `send_reply` posts visible text.

Background schedules are different: they run as fresh plain Pi invocations with the same profile settings, but without Pievo chat/schedule tools. Pievo posts the final result back to the chat as a runtime notification.

## Run

```bash
npm start
```

Create an agent config:

```bash
node ./bin/pievo.js add my-agent
```

Runtime state lives under `~/.pievo` by default.

Default Pi runtime settings are `deepseek/deepseek-v4-flash` with `high` reasoning effort. Use `/model` and `/reasoning_effort` in chat to override a conversation.

## Test

```bash
npm test
```

Opt-in real-Pi scenario E2E tests live in `e2e/scenarios/`:

```bash
npm run test:e2e:scenario -- e2e/scenarios/group-basic.yaml

# Override model if needed:
PIEVO_E2E_MODEL=your-provider/your-model PIEVO_E2E_REASONING=high npm run test:e2e:scenario
```

Edit the YAML scenario files to change replayed group messages and checkpoint expectations.
