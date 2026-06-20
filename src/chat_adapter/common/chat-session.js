import fs from "node:fs/promises";
import path from "node:path";

import { formatAuto } from "../../auto-mode.js";
import { readContextLengthForSession } from "../../pi_run/context-length.js";
import { startPiRun } from "../../pi_run/runner.js";
import {
  buildAdditionalSystemPrompt,
  readProfileInstructions
} from "./additional-system-prompt.js";
import { DEFAULT_CACHE_PATH, toErrorMessage } from "../../utils.js";
import { buildCacheScope } from "./cache-scope.js";
import { buildGroupInputMessage, mergeGroupTurns } from "./group-turn.js";
import { NOOP_CONFIG_STORE } from "./config-store.js";
import { ConversationState } from "./conversation-state.js";
import { ConversationStateStore } from "./conversation-state-store.js";
import {
  PI_RUN_DISPLAY_NAME,
  runFrontAgentTurn
} from "./front-agent-turn-runner.js";
import { installSessionSettingsMethods } from "./session-settings.js";
import { prepareForSessionReset, resetSession } from "./session-reset.js";

function ignorePersistenceFailure(promise, logger, label) {
  void promise.catch((error) => {
    logger(`failed to persist ${label}: ${toErrorMessage(error)}`);
  });
}

/**
 * @typedef {import("../../pi_run/input-message.js").Turn} Turn
 */

export class ChatSession {
  constructor({
    bindingConfig,
    botConfig = null,
    output,
    configStore = NOOP_CONFIG_STORE,
    logger = () => {},
    platform,
    bindingId,
    conversationId,
    cacheRootDir = DEFAULT_CACHE_PATH,
    stateStore = null,
    deliveryAnchor = null,
    createAgentRun = null,
    resolveContextLength = null,
    resolveHomeDir,
    onSchedulesChanged = null,
    onPiToolCall = null
  }) {
    this.bindingConfig = bindingConfig ?? botConfig;
    this.botConfig = this.bindingConfig;
    this.output = output;
    this.configStore = configStore;
    this.logger = logger;
    this.platform = platform ?? this.bindingConfig.platform;
    this.bindingId = bindingId ?? this.bindingConfig.bindingId ?? this.bindingConfig.username;
    this.conversationId = conversationId;
    this.cacheRootDir = cacheRootDir;
    this.queue = [];
    this.isRunning = false;
    this.activeRun = null;
    this.activeReplyTarget = null;
    this.createAgentRun = createAgentRun ?? startPiRun;
    this.resolveContextLength = resolveContextLength ?? readContextLengthForSession;
    this.resolveHomeDir = resolveHomeDir;
    this.onSchedulesChanged = onSchedulesChanged;
    this.onPiToolCall = onPiToolCall;
    this.conversationState = ConversationState.loadSync({
      bindingConfig: this.bindingConfig,
      platform: this.platform,
      bindingId: this.bindingId,
      conversationId: this.conversationId,
      deliveryAnchor,
      stateStore:
        stateStore ??
        new ConversationStateStore({
          rootDir: path.join(path.dirname(this.cacheRootDir), "state")
        }),
      logger: this.logger
    });
  }

  get sessionId() {
    return this.conversationState.sessionId;
  }

  set sessionId(sessionId) {
    ignorePersistenceFailure(
      this.conversationState.updateSessionId(sessionId),
      this.logger,
      "session id"
    );
  }

  get contextLength() {
    return this.conversationState.contextLength;
  }

  set contextLength(contextLength) {
    ignorePersistenceFailure(
      this.conversationState.updateContextLength(contextLength),
      this.logger,
      "context length"
    );
  }

  get additionalSystemPromptSnapshot() {
    return this.conversationState.additionalSystemPromptSnapshot;
  }

  get workdir() {
    return this.conversationState.workdir;
  }

  get auto() {
    return this.conversationState.auto;
  }

  get model() {
    return this.conversationState.model;
  }

  get reasoningEffort() {
    return this.conversationState.reasoningEffort;
  }

  get schedules() {
    return this.conversationState.schedules;
  }

  get deliveryAnchor() {
    return this.conversationState.deliveryAnchor;
  }

  resetTransientTurnState() {
    return this.output.resetTransientState?.();
  }

  sendMessageChunk(rawChunk, options = {}) {
    return this.output.sendMessageChunk(rawChunk, options);
  }

  editMessageChunk(messageId, rawChunk, options = {}) {
    return this.output.editMessageChunk(messageId, rawChunk, options);
  }

  sendSplitText(rawText, options = {}) {
    return this.output.sendSplitText(rawText, options);
  }

  renderProgressText(text, options = {}) {
    return this.output.renderProgressText(text, options);
  }

  clearProgressMessage() {
    return this.output.clearProgressMessage();
  }

  renderFinalMessage(text, options = {}) {
    return this.output.renderFinalMessage(text, {
      ...options,
      workdir: this.workdir
    });
  }

  renderGroupFinalMessage(text, options = {}) {
    return this.output.renderGroupFinalMessage(text, {
      ...options,
      workdir: this.workdir
    });
  }

  renderErrorText(text, options = {}) {
    return this.output.renderErrorText(text, options);
  }

  sendText(text, options = {}) {
    return this.output.sendText(text, options);
  }

  startTyping(replyTarget = this.activeReplyTarget) {
    return this.output.startTyping?.(replyTarget);
  }

  stopTyping() {
    return this.output.stopTyping?.();
  }

  cacheScope() {
    return buildCacheScope({
      cacheRootDir: this.cacheRootDir,
      agentId: this.bindingConfig.agent?.id,
      platform: this.platform,
      bindingId: this.bindingId,
      conversationId: this.conversationId
    });
  }

  cacheDir() {
    return this.cacheScope().scopeDir;
  }

  chatCacheDir() {
    return this.cacheDir();
  }

  normalizeTurn(turn) {
    if (typeof turn === "string") {
      const promptText = String(turn).trim();
      return promptText ? { mode: "private", promptText, attachments: [], replyTarget: null } : null;
    }

    const mode = turn?.mode === "group" ? "group" : "private";
    const groupInput = turn?.groupInput && typeof turn.groupInput === "object"
      ? {
          messages: Array.isArray(turn.groupInput.messages)
            ? turn.groupInput.messages.filter(Boolean)
            : []
        }
      : null;
    const promptText = String(
      turn?.promptText ?? (groupInput ? buildGroupInputMessage(groupInput) : "")
    ).trim();
    const attachments = Array.isArray(turn?.attachments) ? turn.attachments.filter(Boolean) : [];
    if (!promptText && attachments.length === 0) {
      return null;
    }

    return {
      mode,
      promptText,
      attachments,
      replyTarget: turn?.replyTarget ?? null,
      groupInput,
      mergeKey: turn?.mergeKey ?? null,
      groupIdentity: turn?.groupIdentity ?? null,
      developerInstructions: turn?.developerInstructions ?? null,
      suppressQueueNotice: Boolean(turn?.suppressQueueNotice),
      scheduleName: typeof turn?.scheduleName === "string" ? turn.scheduleName : null,
      resumeRetryCount:
        Number.isInteger(turn?.resumeRetryCount) && turn.resumeRetryCount > 0
          ? turn.resumeRetryCount
          : 0
    };
  }

  async clearCache() {
    await fs.rm(this.chatCacheDir(), { recursive: true, force: true });
  }

  updateSessionId(sessionId, options = {}) {
    return this.conversationState.updateSessionId(sessionId, options);
  }

  updateContextLength(contextLength) {
    return this.conversationState.updateContextLength(contextLength);
  }

  updateDeliveryAnchor(deliveryAnchor) {
    return this.conversationState.updateDeliveryAnchor(deliveryAnchor);
  }

  clearSessionState() {
    return this.conversationState.clearSessionState();
  }

  async resetChatToBindingDefaults() {
    await this.conversationState.resetChatToBindingDefaults();
  }

  async resetChatToAgentProfileDefaults(options = {}) {
    await this.conversationState.resetChatToAgentProfileDefaults(options);
  }

  resetChatToBotDefaults() {
    return this.resetChatToBindingDefaults();
  }

  async applyRuntimeSettings(patch) {
    await this.conversationState.applyRuntimeSettings(patch);
  }

  replaceSchedules(schedules) {
    return this.conversationState.replaceSchedules(schedules);
  }

  removeQueuedScheduledTurns(scheduleName) {
    const normalizedName = String(scheduleName ?? "").trim();
    if (!normalizedName) {
      return 0;
    }

    const previousLength = this.queue.length;
    this.queue = this.queue.filter((turn) => turn.scheduleName !== normalizedName);
    return previousLength - this.queue.length;
  }

  async abortCurrentRun() {
    const run = this.activeRun;
    if (!run) {
      return false;
    }
    run.abort();
    try {
      await run.done;
    } catch (error) {
      this.logger(`abort wait failed: ${toErrorMessage(error)}`);
    }
    return true;
  }

  async handleAbort(options = {}) {
    const wasRunning = this.isRunning;
    await resetSession(this);
    await this.sendText(
      wasRunning ? "Aborted current run and cleared the queue." : "No active run. Queue cleared.",
      options
    );
  }

  async handleNewSession(options = {}) {
    await resetSession(this, { clearSessionState: true });
    await this.sendText(
      `Started a new session. The next message will open a fresh ${PI_RUN_DISPLAY_NAME} session.`,
      options
    );
  }

  async reloadBindingConfig() {
    return this.configStore.loadChatBindingConfig({
      platform: this.platform,
      agentId: this.bindingConfig.agent.id,
      bindingId: this.bindingId
    });
  }

  async reloadAgentProfile() {
    return this.configStore.loadAgentProfile({
      agentId: this.bindingConfig.agent.id
    });
  }

  applyAgentProfileDefaults(agentProfile) {
    this.bindingConfig.agent = structuredClone(agentProfile);
    this.botConfig = this.bindingConfig;
  }

  buildFreshAdditionalSystemPrompt(relayInstructions = null) {
    return buildAdditionalSystemPrompt({
      profileInstructions: readProfileInstructions(this.bindingConfig.agent),
      relayInstructions
    });
  }

  resolveAdditionalSystemPrompt(relayInstructions = null) {
    if (this.sessionId) {
      return this.additionalSystemPromptSnapshot;
    }
    return this.buildFreshAdditionalSystemPrompt(relayInstructions);
  }

  async resetToAgentProfileDefaults({ agentProfile = null } = {}) {
    let reloadedAgentProfile = agentProfile;
    if (!reloadedAgentProfile) {
      try {
        reloadedAgentProfile = await this.reloadAgentProfile();
      } catch (error) {
        return {
          ok: false,
          text: `Failed to reload agent profile: ${toErrorMessage(error)}`
        };
      }
    }

    await prepareForSessionReset(this);
    this.applyAgentProfileDefaults(reloadedAgentProfile);
    await this.resetChatToAgentProfileDefaults({ reloadDurableState: true });

    return {
      ok: true,
      text: `Reset this conversation to current agent profile defaults. Started a new Pi session with workdir ${this.workdir}, auto ${formatAuto(this.auto)}, model ${this.model}, reasoning effort ${this.reasoningEffort}.`
    };
  }

  async handleReset(options = {}) {
    const result = await this.resetToAgentProfileDefaults();
    await this.sendText(result.text, options);
    return result;
  }

  async enqueueTurn(turn) {
    const normalizedTurn = this.normalizeTurn(turn);
    if (!normalizedTurn) {
      return;
    }

    if (normalizedTurn.mode === "group") {
      const lastQueuedTurn = this.queue.at(-1);
      if (
        lastQueuedTurn?.mode === "group" &&
        lastQueuedTurn.mergeKey &&
        lastQueuedTurn.mergeKey === normalizedTurn.mergeKey
      ) {
        mergeGroupTurns(lastQueuedTurn, normalizedTurn);
        if (!this.isRunning) {
          void this.drainQueue();
        }
        return;
      }
    }

    if (this.isRunning) {
      this.queue.push(normalizedTurn);
      if (normalizedTurn.mode === "group" || normalizedTurn.suppressQueueNotice) {
        return;
      }
      await this.sendText(`Queued message ${this.queue.length}.`, {
        replyTarget: normalizedTurn.replyTarget
      });
      return;
    }

    this.queue.push(normalizedTurn);
    void this.drainQueue();
  }

  async enqueueMessage(text, options = {}) {
    await this.enqueueTurn({
      promptText: text,
      attachments: [],
      replyTarget: options.replyTarget ?? null
    });
  }

  async drainQueue() {
    if (this.isRunning) {
      return;
    }

    const nextTurn = this.queue.shift();
    if (!nextTurn) {
      return;
    }

    this.isRunning = true;
    await runFrontAgentTurn({
      session: this,
      turn: nextTurn,
      createAgentRun: this.createAgentRun,
      resolveContextLength: this.resolveContextLength
    });

    if (this.queue.length > 0) {
      void this.drainQueue();
    }
  }
}

installSessionSettingsMethods(ChatSession);
