import { loadConfig, findAgentProfile } from "../config.js";
import { ConversationStateStore } from "../chat_adapter/common/conversation-state-store.js";
import { toErrorMessage } from "../utils.js";
import { ConversationResetter } from "./conversation-resetter.js";
import { RuntimeReconciler } from "./runtime-reconciler.js";
import { runtimeBindingKey } from "./runtime-registry.js";
import {
  formatAgentProfileResetSummary,
  resultTextForConversation
} from "./reset-summary.js";

function createAgentProfileResetResult(agentId, failures = []) {
  return {
    ok: true,
    agentId,
    bindings: {
      added: 0,
      removed: 0,
      restarted: 0,
      updated: 0,
      unchanged: 0,
      failed: 0
    },
    conversations: {
      live: 0,
      durable: 0
    },
    schedules: {
      timers: 0
    },
    runs: {
      aborted: 0,
      queuesCleared: 0
    },
    failures
  };
}

function addConversationResetCounts(result, counts) {
  result.conversations.live += counts.live;
  result.runs.aborted += counts.aborted;
  result.runs.queuesCleared += counts.queuesCleared;
}

export class ResetService {
  constructor({
    configPath,
    runtimeRegistry,
    operationLocks,
    createRuntime,
    stateStore = new ConversationStateStore()
  }) {
    this.configPath = configPath;
    this.runtimeRegistry = runtimeRegistry;
    this.operationLocks = operationLocks;
    this.createRuntime = createRuntime;
    this.stateStore = stateStore;
    this.runtimeReconciler = new RuntimeReconciler({
      runtimeRegistry,
      createRuntime
    });
    this.conversationResetter = new ConversationResetter({ stateStore });
  }

  async loadAgentProfile(agentId) {
    const config = await loadConfig(this.configPath);
    const agent = findAgentProfile(config, { agentId });
    if (!agent) {
      throw new Error(`Agent profile "${agentId}" not found in ${config.configPath}`);
    }
    return { config, agent };
  }

  async resetConversation({ agentId, platform, bindingId, conversationId }) {
    return this.operationLocks.runExclusive(agentId, async () => {
      const { agent } = await this.loadAgentProfile(agentId);
      const runtime = this.runtimeRegistry.find({ platform, bindingId });
      if (!runtime || runtime.botConfig.agent.id !== agentId) {
        throw new Error(`Chat binding "${platform}:${bindingId}" for agent "${agentId}" is not running.`);
      }
      const session = await this.conversationResetter.resetConversationSession({
        runtime,
        agentProfile: agent,
        platform,
        bindingId,
        conversationId
      });
      return {
        ok: true,
        text: resultTextForConversation(session)
      };
    });
  }

  async resetAgentProfile(agentId) {
    const pendingStops = [];
    const result = await this.operationLocks.runExclusive(agentId, async () => {
      const { config, agent } = await this.loadAgentProfile(agentId);
      const desiredBindings = config.chatBindings.filter((binding) => binding.agent.id === agentId);
      const failures = [];
      const result = createAgentProfileResetResult(agentId, failures);
      const seenLiveScopes = new Set();

      const reconciliation = await this.runtimeReconciler.reconcileAgentRuntimes({
        agentId,
        desiredBindings,
        failures,
        beforeRetireRuntime: async (runtime) => {
          const resetCounts = await this.conversationResetter.resetLiveRuntimeSessions(
            runtime,
            agent,
            failures,
            seenLiveScopes
          );
          addConversationResetCounts(result, resetCounts);
        }
      });
      pendingStops.push(...reconciliation.pendingStops);
      Object.assign(result.bindings, reconciliation.counts);

      for (const runtime of this.runtimeRegistry.forAgent(agentId)) {
        const resetCounts = await this.conversationResetter.resetLiveRuntimeSessions(
          runtime,
          agent,
          failures,
          seenLiveScopes
        );
        addConversationResetCounts(result, resetCounts);
      }

      result.conversations.durable = await this.conversationResetter.resetDurableAgentRecords(
        agentId,
        failures,
        seenLiveScopes
      );

      for (const runtime of this.runtimeRegistry.forAgent(agentId)) {
        try {
          await runtime.restoreScheduledConversations?.();
        } catch (error) {
          failures.push({
            target: runtimeBindingKey(runtime),
            message: toErrorMessage(error)
          });
        }
        result.schedules.timers +=
          typeof runtime.getScheduleTimerCount === "function"
            ? runtime.getScheduleTimerCount()
            : runtime.scheduleTimers?.size ?? 0;
      }

      return result;
    });

    await this.runtimeReconciler.stopPendingRuntimes(pendingStops, result.failures);

    result.bindings.failed = result.failures.length;
    result.ok = result.failures.length === 0;
    return {
      ...result,
      text: formatAgentProfileResetSummary(result)
    };
  }
}
