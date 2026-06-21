# Pievo

[![CI](https://github.com/kky42/pievo/actions/workflows/ci.yml/badge.svg)](https://github.com/kky42/pievo/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@kky42/pievo.svg)](https://www.npmjs.com/package/@kky42/pievo)

Pievo (Pi Evolution) is an additional harness layer for durable agents: orchestration, memory, and continuous evolution on top of Pi.

The current implementation starts with a Pi-native chat relay for long-running assistants in Telegram and Mattermost. This repo was forked from `anyagent` and simplified to target Pi only. Codex/Claude adapters and text output contracts have been removed from the active runtime.

## How to use

### Install

Install Pievo from npm:

```bash
npm install -g @kky42/pievo
```

Pievo shells out to the `pi` CLI when an agent runs, so install and configure Pi before starting the relay.

### Create your first Telegram agent

Create a Telegram bot with [BotFather](https://t.me/BotFather), then keep the bot token and bot username.

Create a local Pievo agent config:

```bash
pievo add my-agent
```

Edit `~/.pievo/agents/my-agent/config.json`:

- Set `profile.workdir` to the directory where the agent should work.
- Replace `bindings.telegram.allowedUsernames` and `bindings.telegram.managerUsernames` with your Telegram username, without `@`.
- Add your bot under `bindings.telegram.bots`:

```json
{
  "username": "your_bot_username",
  "token": "123456:telegram-bot-token",
  "allowedUsernames": ["your-telegram-username"],
  "managerUsernames": ["your-telegram-username"]
}
```

Start the relay:

```bash
pievo
```

Open Telegram, start a private chat with your bot, and send a message. To use the bot in a group, add it to the group and mention it in messages or commands, for example `/status @your_bot_username`.

Runtime state lives under `~/.pievo` by default.
