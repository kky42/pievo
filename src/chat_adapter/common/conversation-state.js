import { AUTO_DEFAULT } from "../../auto-mode.js";
import {
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT
} from "../../runtime-settings.js";
import {
  cloneStateValue,
  normalizeContextLength,
  normalizeDeliveryAnchor,
  normalizePromptSnapshot,
  normalizeSchedules,
  normalizeStateRecord,
  normalizeString
} from "./conversation-state-schema.js";
import { ConversationStateStore } from "./conversation-state-store.js";

export { CONVERSATION_STATE_VERSION } from "./conversation-state-schema.js";
export { ConversationStateStore } from "./conversation-state-store.js";

function runtimeStateFromAgent(agent) {
  return {
    workdir: agent?.workdir,
    auto: agent?.auto ?? AUTO_DEFAULT,
    model: agent?.model ?? DEFAULT_MODEL,
    reasoningEffort: agent?.reasoningEffort ?? DEFAULT_REASONING_EFFORT
  };
}

export class ConversationState {
  static loadSync({
    bindingConfig,
    platform,
    bindingId,
    conversationId,
    deliveryAnchor = null,
    stateStore = new ConversationStateStore(),
    logger = () => {}
  }) {
    const scope = stateStore.scopeFor({
      agentId: bindingConfig.agent.id,
      platform,
      bindingId,
      conversationId
    });
    const record = stateStore.loadRecordSync(scope);
    const state = new ConversationState({
      bindingConfig,
      scope,
      record,
      stateStore,
      logger
    });
    if (deliveryAnchor) {
      state.record.deliveryAnchor = normalizeDeliveryAnchor(deliveryAnchor) ?? state.record.deliveryAnchor;
      try {
        state.persistSync();
      } catch (error) {
        logger(`failed to persist delivery anchor: ${error.message}`);
      }
    }
    if (state.record.session?.id) {
      const basis = state.record.session.basis;
      if (
        !basis ||
        basis.additionalSystemPromptSnapshot === null ||
        basis.workdir !== state.workdir
      ) {
        state.record.session = null;
        try {
          state.persistSync();
        } catch (error) {
          logger(`failed to invalidate stale session state: ${error.message}`);
        }
      }
    }
    return state;
  }

  static async load({
    bindingConfig,
    platform,
    bindingId,
    conversationId,
    deliveryAnchor = null,
    stateStore = new ConversationStateStore(),
    logger = () => {}
  }) {
    const scope = stateStore.scopeFor({
      agentId: bindingConfig.agent.id,
      platform,
      bindingId,
      conversationId
    });
    const record = await stateStore.loadRecord(scope);
    const state = new ConversationState({
      bindingConfig,
      scope,
      record,
      stateStore,
      logger
    });
    if (deliveryAnchor) {
      state.record.deliveryAnchor = normalizeDeliveryAnchor(deliveryAnchor) ?? state.record.deliveryAnchor;
      await state.persist();
    }
    await state.invalidateSessionIfBasisChanged();
    return state;
  }

  constructor({ bindingConfig, scope, record, stateStore, logger = () => {} }) {
    this.bindingConfig = bindingConfig;
    this.scope = scope;
    this.record = normalizeStateRecord(record, scope);
    this.stateStore = stateStore;
    this.logger = logger;
  }

  get defaults() {
    return runtimeStateFromAgent(this.bindingConfig.agent);
  }

  get effectiveSettings() {
    return {
      workdir: this.record.overrides.workdir ?? this.defaults.workdir,
      auto: this.record.overrides.auto ?? this.defaults.auto,
      model: this.record.overrides.model ?? this.defaults.model,
      reasoningEffort: this.record.overrides.reasoningEffort ?? this.defaults.reasoningEffort
    };
  }

  get workdir() {
    return this.effectiveSettings.workdir;
  }

  get auto() {
    return this.effectiveSettings.auto;
  }

  get model() {
    return this.effectiveSettings.model;
  }

  get reasoningEffort() {
    return this.effectiveSettings.reasoningEffort;
  }

  get sessionId() {
    return this.record.session?.id ?? null;
  }

  get contextLength() {
    return this.record.session?.contextLength ?? null;
  }

  get additionalSystemPromptSnapshot() {
    return this.record.session?.basis?.additionalSystemPromptSnapshot ?? null;
  }

  get schedules() {
    return cloneStateValue(this.record.schedules) ?? [];
  }

  get deliveryAnchor() {
    return cloneStateValue(this.record.deliveryAnchor);
  }

  async persist() {
    await this.stateStore.saveRecord(this.scope, this.record);
  }

  persistSync() {
    this.stateStore.saveRecordSync(this.scope, this.record);
  }

  async invalidateSessionIfBasisChanged() {
    const session = this.record.session;
    if (!session?.id) {
      return;
    }
    if (
      session.basis &&
      session.basis.additionalSystemPromptSnapshot !== null &&
      session.basis.workdir === this.workdir
    ) {
      return;
    }
    this.record.session = null;
    await this.persist();
  }

  async updateDeliveryAnchor(deliveryAnchor) {
    const normalized = normalizeDeliveryAnchor(deliveryAnchor);
    if (!normalized) {
      return;
    }
    if (JSON.stringify(this.record.deliveryAnchor) === JSON.stringify(normalized)) {
      return;
    }
    this.record.deliveryAnchor = normalized;
    await this.persist();
  }

  async updateSessionId(sessionId, options = {}) {
    const normalized = normalizeString(sessionId);
    if (!normalized) {
      this.record.session = null;
      await this.persist();
      return;
    }

    const hasPromptSnapshot = Object.prototype.hasOwnProperty.call(
      options,
      "additionalSystemPromptSnapshot"
    );
    const currentContextLength = this.record.session?.contextLength ?? null;
    this.record.session = {
      id: normalized,
      contextLength: currentContextLength,
      basis: {
        workdir: this.workdir,
        additionalSystemPromptSnapshot: hasPromptSnapshot
          ? normalizePromptSnapshot(options.additionalSystemPromptSnapshot)
          : null
      }
    };
    await this.persist();
  }

  async updateContextLength(contextLength) {
    const normalized = normalizeContextLength(contextLength);
    if (!this.record.session) {
      if (normalized === null) {
        return;
      }
      this.record.session = {
        id: null,
        contextLength: normalized,
        basis: {
          workdir: this.workdir,
          additionalSystemPromptSnapshot: null
        }
      };
    } else {
      this.record.session.contextLength = normalized;
    }
    await this.persist();
  }

  async clearSessionState() {
    this.record.session = null;
    await this.persist();
  }

  async resetChatToBindingDefaults() {
    this.record.session = null;
    this.record.overrides = {};
    await this.persist();
  }

  async resetChatToAgentProfileDefaults({ reloadDurableState = false } = {}) {
    if (reloadDurableState) {
      this.record = await this.stateStore.loadRecord(this.scope);
    }
    this.record.session = null;
    this.record.overrides = {};
    await this.persist();
  }

  async resetChatToBotDefaults() {
    await this.resetChatToBindingDefaults();
  }

  async applyRuntimeSettings(patch) {
    const nextOverrides = { ...this.record.overrides };
    const defaults = this.defaults;

    for (const [key, value] of Object.entries(patch ?? {})) {
      if (!["workdir", "auto", "model", "reasoningEffort"].includes(key)) {
        continue;
      }
      if (value === undefined) {
        delete nextOverrides[key];
        continue;
      }

      if (String(value) === String(defaults[key])) {
        delete nextOverrides[key];
      } else {
        nextOverrides[key] = String(value);
      }
    }

    const previousWorkdir = this.workdir;
    this.record.overrides = nextOverrides;

    if (this.record.session && previousWorkdir !== this.workdir) {
      this.record.session = null;
    }

    await this.persist();
  }

  async replaceSchedules(schedules) {
    this.record.schedules = normalizeSchedules(schedules);
    await this.persist();
  }
}
