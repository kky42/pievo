# Pievo

Pievo（Pi Evolution）是一个面向 durable agents 的附加 harness layer，目标是在 Pi 之上构建 agent 编排、记忆与持续演化能力。

当前实现首先提供一个 Pi-native 聊天中继，用于构建长期运行的 Telegram / Mattermost Agents Assistant。该仓库从 `anyagent` fork 而来，并简化为仅支持 Pi。Codex/Claude adapter 与旧的文本输出契约不再作为运行时路径使用。

## Pi 原生工具

当前聊天中继会在前台 agent run 中注入一个 Pi extension，并注册这些工具：

- `send_reply`：在群聊中发送可见回复，仅群聊使用。
- `send_attachment`：把本地文件发送到当前聊天。
- `add_schedule`：为当前聊天添加 heartbeat/background schedule。
- `list_schedule`：列出当前聊天的 schedules。
- `remove_schedule`：删除当前聊天的 schedule。

群聊输出由工具驱动：最终 assistant 文本不会自动发到群里，只有 `send_reply` 会产生可见群聊消息。

Background schedule 不同：它会用相同 profile settings 启动一个新的普通 Pi invocation，但不注入 Pievo chat/schedule tools；最终结果由 Pievo runtime 作为通知发回聊天。

## 运行

```bash
npm start
```

创建 agent 配置：

```bash
node ./bin/pievo.js add my-agent
```

默认运行状态目录：`~/.pievo`。

默认 Pi 模型是 `deepseek/deepseek-v4-flash`，reasoning effort 为 `high`。可以在聊天中用 `/model` 和 `/reasoning_effort` 覆盖当前会话。

## 测试

```bash
npm test
```

真实 Pi 场景 E2E 测试：

```bash
npm run test:e2e:scenario
```
