# Pievo Context

Pievo (Pi Evolution) is a Pi-only chat relay for Telegram and Mattermost.

Core ideas:

- One front agent session per conversation.
- Group chats provide transcript input, but visible group output must be sent with the native `send_reply` tool.
- Private chats deliver final assistant text normally.
- Files are delivered with the native `send_attachment` tool.
- Schedules are durable per conversation.
  - `heartbeat` schedules enqueue a turn into the current front-agent session.
  - `background` schedules start a fresh Pi run with the same profile settings and send the final result back to the chat.

The active code path should remain Pi-native and should not depend on Codex/Claude compatibility or legacy text output contracts.
