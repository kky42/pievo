# Pievo

[![CI](https://github.com/kky42/pievo/actions/workflows/ci.yml/badge.svg)](https://github.com/kky42/pievo/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@kky42/pievo.svg)](https://www.npmjs.com/package/@kky42/pievo)

Pievo（Pi Evolution）是一个面向 durable agents 的附加 harness layer，目标是在 Pi 之上构建 agent 编排、记忆与持续演化能力。

当前实现首先提供一个 Pi-native 聊天中继，用于构建长期运行的 Telegram / Mattermost Agents Assistant。该仓库从 `anyagent` fork 而来，并简化为仅支持 Pi。Codex/Claude adapter 与旧的文本输出契约不再作为运行时路径使用。

## How to use

### 安装

通过 npm 安装 Pievo：

```bash
npm install -g @kky42/pievo
```

Pievo 在 agent 运行时会调用 `pi` CLI，因此请先安装并配置 Pi，再启动 relay。

可选：如果复杂 LOOP 需要独立 reviewer、并行处理，或者固定的小型工作流，可以在运行 Pievo 的同一个用户环境中安装 pi-flow：

```bash
pi install npm:@kky42/pi-flow
```

Pievo schedule 仍然只是普通的 `heartbeat` 或 `background` schedule；pi-flow 提供可选的 saved `workflow` tool，安装后 scheduled background run 可以在可用时使用它。

### 创建并连接第一个 Telegram agent

先用 [BotFather](https://t.me/BotFather) 创建 Telegram bot，并保存 bot token 和 bot username。

创建本地 Pievo agent 配置：

```bash
pievo add my-agent
```

编辑 `~/.pievo/agents/my-agent/config.json`：

- 将 `profile.workdir` 设置为 agent 的工作目录。
- 将 `bindings.telegram.allowedUsernames` 和 `bindings.telegram.managerUsernames` 替换为你的 Telegram username，不要带 `@`。
- 在 `bindings.telegram.bots` 下添加 bot：

```json
{
  "username": "your_bot_username",
  "token": "123456:telegram-bot-token",
  "allowedUsernames": ["your-telegram-username"],
  "managerUsernames": ["your-telegram-username"]
}
```

启动 relay：

```bash
pievo
```

打开 Telegram，进入和 bot 的私聊并发送消息。若要在群里使用，将 bot 加入群聊后在消息或命令里 mention 它，例如 `/status @your_bot_username`。

运行状态默认保存在 `~/.pievo`。
