import { toErrorMessage } from "../utils.js";
import { runtimeBindingKey } from "./runtime-registry.js";

function resetRecord(record) {
  return {
    ...record,
    session: null,
    overrides: {}
  };
}

function runtimeScope(runtime) {
  const platform =
    runtime?.botConfig?.platform ?? (runtime?.botConfig?.serverUrl ? "mattermost" : "telegram");
  const bindingId = runtime?.botConfig?.bindingId ?? runtime?.botConfig?.username;
  return {
    agentId: runtime?.botConfig?.agent?.id,
    platform,
    bindingId
  };
}

function durableLoadErrorTarget(details) {
  return details.stateJsonPath;
}

export class ConversationResetter {
  constructor({ stateStore }) {
    this.stateStore = stateStore;
  }

  async sessionForConversation({ runtime, platform, bindingId, conversationId }) {
    const key = String(conversationId ?? "").trim();
    if (!key) {
      throw new Error("conversation id must be a non-empty string");
    }

    const liveSession = runtime.sessions.get(key);
    if (liveSession) {
      return liveSession;
    }

    const scope = runtime.stateStore.scopeFor({
      agentId: runtime.botConfig.agent.id,
      platform,
      bindingId,
      conversationId
    });
    const record = await runtime.stateStore.loadRecord(scope);
    const deliveryAnchor = record.deliveryAnchor;
    if (platform === "telegram") {
      const chatId = deliveryAnchor?.chatId;
      if (chatId === null || chatId === undefined) {
        throw new Error("Conversation is not live and has no Telegram delivery anchor.");
      }
      return runtime.sessionFor(chatId, { conversationId, deliveryAnchor });
    }
    if (platform === "mattermost") {
      const channelId = String(deliveryAnchor?.channelId ?? "").trim();
      if (!channelId) {
        throw new Error("Conversation is not live and has no Mattermost delivery anchor.");
      }
      return runtime.sessionFor(channelId, { conversationId, deliveryAnchor });
    }
    throw new Error(`Unsupported chat binding platform: ${platform}`);
  }

  async resetConversationSession({ runtime, agentProfile, platform, bindingId, conversationId }) {
    const session = await this.sessionForConversation({
      runtime,
      platform,
      bindingId,
      conversationId
    });
    const result = await session.resetToAgentProfileDefaults({ agentProfile });
    if (!result.ok) {
      throw new Error(result.text);
    }
    runtime.syncConversationSchedules?.(session);
    return session;
  }

  async abortRuntimeBackgroundRuns(runtime, failures) {
    try {
      if (typeof runtime.abortBackgroundRuns === "function") {
        return await runtime.abortBackgroundRuns({ suppressNotification: true });
      }

      const backgroundRuns = [...(runtime.activeBackgroundRuns ?? [])];
      for (const run of backgroundRuns) {
        run.suppressBackgroundNotification = true;
        run.abort?.();
      }
      await Promise.allSettled(
        backgroundRuns.map((run) => (run.backgroundDone ?? run.done ?? Promise.resolve()).catch(() => null))
      );
      return backgroundRuns.length;
    } catch (error) {
      failures.push({
        target: runtimeBindingKey(runtime),
        message: toErrorMessage(error)
      });
      return 0;
    }
  }

  async resetLiveRuntimeSessions(runtime, agentProfile, failures, seenLiveScopes = new Set()) {
    let live = 0;
    let aborted = await this.abortRuntimeBackgroundRuns(runtime, failures);
    let queuesCleared = 0;
    const runtimeScopeParts = runtimeScope(runtime);
    for (const session of runtime.sessions.values()) {
      const scopeKey = `${runtimeScopeParts.agentId}:${runtimeScopeParts.platform}:${runtimeScopeParts.bindingId}:${session.conversationId}`;
      seenLiveScopes.add(scopeKey);
      if (session.isRunning) {
        aborted += 1;
      }
      if (session.queue.length > 0) {
        queuesCleared += 1;
      }
      try {
        const result = await session.resetToAgentProfileDefaults({ agentProfile });
        if (!result.ok) {
          throw new Error(result.text);
        }
        runtime.syncConversationSchedules?.(session);
        live += 1;
      } catch (error) {
        failures.push({
          target: scopeKey,
          message: toErrorMessage(error)
        });
      }
    }
    return { live, aborted, queuesCleared };
  }

  async resetDurableAgentRecords(agentId, failures, seenLiveScopes = new Set()) {
    const records = await this.stateStore.loadAgentRecords(
      { agentId },
      {
        onError: (error, details) => {
          failures.push({
            target: durableLoadErrorTarget(details),
            message: toErrorMessage(error)
          });
        }
      }
    );
    return this.resetDurableRecords(records, failures, seenLiveScopes);
  }

  async resetDurableBindingRecords({ agentId, platform, bindingId }, failures, seenLiveScopes = new Set()) {
    const records = await this.stateStore.loadBindingRecords(
      { agentId, platform, bindingId },
      {
        onError: (error, details) => {
          failures.push({
            target: durableLoadErrorTarget(details),
            message: toErrorMessage(error)
          });
        }
      }
    );
    return this.resetDurableRecords(records, failures, seenLiveScopes);
  }

  async resetDurableRecords(records, failures, seenLiveScopes = new Set()) {
    let durable = 0;
    for (const { scope, record } of records) {
      if (seenLiveScopes.has(scope.scopeKey)) {
        continue;
      }
      try {
        await this.stateStore.saveRecord(scope, resetRecord(record));
        durable += 1;
      } catch (error) {
        failures.push({
          target: scope.scopeKey,
          message: toErrorMessage(error)
        });
      }
    }
    return durable;
  }
}
