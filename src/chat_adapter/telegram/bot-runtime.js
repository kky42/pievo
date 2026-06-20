import path from "node:path";

import {
  DEFAULT_CACHE_PATH,
  normalizeTelegramUsername,
  toErrorMessage
} from "../../utils.js";
import { ALBUM_QUIET_PERIOD_MS } from "./attachments.js";
import { ChatSession } from "./chat-session.js";
import { MediaGroupBuffer } from "./media-group-buffer.js";
import { createTelegramMessageRouter } from "./message-router.js";
import { createTelegramPollingLoop } from "./polling-loop.js";
import { createTelegramSchedulePresenter } from "./schedule-presenter.js";
import { ConversationStateStore } from "../common/conversation-state-store.js";
import { NOOP_CONFIG_STORE } from "../common/config-store.js";
import { ScheduleController } from "../common/schedule-controller.js";
import { TelegramBotApi } from "./telegram-api.js";
import { CHAT_COMMANDS } from "../common/render.js";
import { resetSession } from "../common/session-reset.js";

export const TELEGRAM_COMMANDS = CHAT_COMMANDS;

export class BotRuntime {
  constructor({
    botConfig,
    configStore = NOOP_CONFIG_STORE,
    fetchImpl = globalThis.fetch,
    botApi = null,
    createAgentRun = null,
    cacheRootDir = DEFAULT_CACHE_PATH,
    stateRootDir = null,
    albumQuietPeriodMs = ALBUM_QUIET_PERIOD_MS,
    operationLocks = null
  }) {
    this.botConfig = botConfig;
    this.configStore = configStore;
    this.botApi = botApi ?? new TelegramBotApi(botConfig.token, fetchImpl);
    this.createAgentRun = createAgentRun;
    this.cacheRootDir = cacheRootDir;
    this.stateStore = new ConversationStateStore({
      rootDir: stateRootDir || path.join(path.dirname(cacheRootDir), "state")
    });
    this.albumQuietPeriodMs = albumQuietPeriodMs;
    this.botUsername = null;
    this.offset = undefined;
    this.polling = false;
    this.retiring = false;
    this.pollPromise = null;
    this.pollAbortController = null;
    this.sessions = new Map();
    this.mediaGroupBuffer = new MediaGroupBuffer({ quietPeriodMs: albumQuietPeriodMs });
    this.botDisplayName = "Pievo";
    this.operationLocks = operationLocks;
    this.messageRouter = createTelegramMessageRouter(this);
    this.pollingLoop = createTelegramPollingLoop(this);
    this.scheduleController = new ScheduleController({
      stateStore: this.stateStore,
      bindingScope: () => ({
        agentId: this.botConfig.agent.id,
        platform: "telegram",
        bindingId: this.botConfig.username
      }),
      log: (message) => this.log(message),
      isRunning: () => this.isActive(),
      waitForAgentOperation: () => this.waitForAgentOperation(),
      getSession: (conversationId) => this.sessions.get(String(conversationId)),
      restoreSession: ({ scope, record }) => {
        const chatId = record.deliveryAnchor?.chatId;
        if (chatId === null || chatId === undefined) {
          this.log(`skipping scheduled restore for ${scope.conversationId}: missing delivery anchor`);
          return null;
        }
        return this.sessionFor(chatId, {
          conversationId: scope.conversationId,
          deliveryAnchor: record.deliveryAnchor
        });
      },
      deliveryAnchorForSession: (session) =>
        session.deliveryAnchor ?? { chatId: session.chatId, replyTarget: null },
      isDirectConversation: ({ deliveryAnchor }) => !(Number(deliveryAnchor?.chatId) < 0),
      groupIdentity: () => this.groupIdentity(),
      schedulePresenter: createTelegramSchedulePresenter("/schedule")
    });
  }

  log(message) {
    process.stderr.write(`[telegram:@${this.botConfig.username}] ${message}\n`);
  }

  sessionFor(chatId, options = {}) {
    const conversationId = options.conversationId ?? chatId;
    const key = String(conversationId);
    let session = this.sessions.get(key);
    if (!session) {
      session = new ChatSession({
        botConfig: this.botConfig,
        botApi: this.botApi,
        configStore: this.configStore,
        logger: (message) => this.log(`${key}: ${message}`),
        chatId,
        conversationId,
        cacheRootDir: this.cacheRootDir,
        stateStore: this.stateStore,
        deliveryAnchor: options.deliveryAnchor ?? null,
        createAgentRun: this.createAgentRun,
        onSchedulesChanged: (changedSession) => this.syncConversationSchedules(changedSession)
      });
      this.sessions.set(key, session);
    } else if (options.deliveryAnchor) {
      void session.updateDeliveryAnchor(options.deliveryAnchor).catch((error) => {
        this.log(`${key}: failed to persist delivery anchor: ${toErrorMessage(error)}`);
      });
    }
    return session;
  }

  scheduleKey(conversationId, scheduleName) {
    return this.scheduleController.scheduleKey(conversationId, scheduleName);
  }

  clearConversationScheduleTimers(conversationId) {
    return this.scheduleController.clearConversationScheduleTimers(conversationId);
  }

  syncScheduleTimer(session, schedule) {
    return this.scheduleController.syncScheduleTimer(session, schedule);
  }

  syncConversationSchedules(session) {
    return this.scheduleController.syncConversationSchedules(session);
  }

  getScheduleTimerCount() {
    return this.scheduleController.getScheduleTimerCount();
  }

  async restoreScheduledConversations() {
    return this.scheduleController.restoreScheduledConversations();
  }

  async buildPrivateReferenceText(session, message) {
    return this.messageRouter.buildPrivateReferenceText(session, message);
  }

  async buildGroupReferenceText(session, message) {
    return this.messageRouter.buildGroupReferenceText(session, message);
  }

  async runHeartbeatSchedule(session, schedule, now = new Date()) {
    return this.scheduleController.runHeartbeatSchedule(session, schedule, now);
  }

  async runBackgroundSchedule(session, schedule, now = new Date()) {
    return this.scheduleController.runBackgroundSchedule(session, schedule, now);
  }

  async handleScheduledOccurrence(conversationId, scheduleName, expectedTimer = null) {
    return this.scheduleController.handleScheduledOccurrence(conversationId, scheduleName, expectedTimer);
  }

  async handleScheduleCommand(session, args, options = {}) {
    return this.scheduleController.handleScheduleCommand(session, args, options);
  }

  hasPendingBotWork() {
    if (this.mediaGroupBuffer.hasPending()) {
      return true;
    }

    if (this.scheduleController.hasActiveBackgroundRuns()) {
      return true;
    }

    for (const session of this.sessions.values()) {
      if (session.isRunning || session.queue.length > 0) {
        return true;
      }
    }

    return false;
  }

  isAuthorized(user) {
    const username = normalizeTelegramUsername(user?.username);
    const managerUsernames = Array.isArray(this.botConfig.managerUsernames)
      ? this.botConfig.managerUsernames
      : [];
    return Boolean(
      username &&
      (this.botConfig.allowedUsernames.includes(username) || managerUsernames.includes(username))
    );
  }

  isManager(user) {
    const username = normalizeTelegramUsername(user?.username);
    const managerUsernames = Array.isArray(this.botConfig.managerUsernames)
      ? this.botConfig.managerUsernames
      : this.botConfig.allowedUsernames;
    return Boolean(username && managerUsernames.includes(username));
  }

  async initialize({ restoreScheduledConversations = true } = {}) {
    const me = await this.botApi.getMe();
    this.botUsername = normalizeTelegramUsername(me.username);
    this.botDisplayName = String(me.first_name ?? me.username ?? "Pievo").trim() || "Pievo";
    if (this.botUsername !== this.botConfig.username) {
      throw new Error(
        `Configured Telegram bot username @${this.botConfig.username} does not match token owner @${this.botUsername || "unknown"}.`
      );
    }
    await this.discardPendingUpdates();
    await this.botApi.setMyCommands(TELEGRAM_COMMANDS);
    if (restoreScheduledConversations) {
      await this.restoreScheduledConversations();
    }
    this.log(
      `ready as @${this.botUsername} for agent ${this.botConfig.agent.id} with workdir ${this.botConfig.agent.workdir}`
    );
  }

  groupIdentity() {
    const botUsername = this.botUsername || this.botConfig.username;
    return {
      botName: this.botDisplayName,
      botHandle: botUsername ? `@${botUsername}` : "@unknown"
    };
  }

  async waitForAgentOperation() {
    await this.operationLocks?.wait(this.botConfig.agent.id);
  }

  isActive() {
    return !this.retiring;
  }

  requestStop() {
    this.retiring = true;
    if (this.polling) {
      this.polling = false;
      this.pollAbortController?.abort();
    }
    this.mediaGroupBuffer.clear();
    this.scheduleController.clearAllTimers();
  }

  async stopBackgroundRuns(options = {}) {
    return this.scheduleController.stopBackgroundRuns(options);
  }

  async abortBackgroundRuns(options = {}) {
    return this.stopBackgroundRuns(options);
  }

  async resetSessions() {
    this.mediaGroupBuffer.clear();
    await Promise.all([...this.sessions.values()].map((session) =>
      resetSession(session, { clearSessionState: true })
    ));
  }

  async handleConversationReset(session, options = {}) {
    const reset = async () => {
      const result = await session.handleReset(options);
      if (result?.ok) {
        this.syncConversationSchedules(session);
      }
      return result;
    };
    if (this.operationLocks) {
      return this.operationLocks.runExclusive(this.botConfig.agent.id, reset);
    }
    return reset();
  }

  async discardPendingUpdates() {
    return this.pollingLoop.discardPendingUpdates();
  }

  async sendDirectMessage(chatId, text) {
    const session = this.sessionFor(chatId, {
      deliveryAnchor: {
        chatId,
        replyTarget: null
      }
    });
    await session.sendText(text);
  }

  async handleClearCache(sessionOrChatId, options = {}) {
    const session =
      sessionOrChatId instanceof ChatSession
        ? sessionOrChatId
        : this.sessionFor(sessionOrChatId);
    if (this.hasPendingBotWork()) {
      await session.sendText(
        "Cannot clear cache while runs, queued turns, or media albums are pending.",
        options
      );
      return;
    }

    try {
      await session.clearCache();
    } catch (error) {
      await session.sendText(`Failed to clear cache: ${toErrorMessage(error)}`, options);
      return;
    }

    await session.sendText("Cleared cache for this chat.", options);
  }

  async handleMessage(message) {
    return this.messageRouter.handleMessage(message);
  }

  async handlePrivateMessage(message) {
    return this.messageRouter.handlePrivateMessage(message);
  }

  async handleGroupMessage(message, options = {}) {
    return this.messageRouter.handleGroupMessage(message, options);
  }

  async handleGroupTriggerMessages(options) {
    return this.messageRouter.handleGroupTriggerMessages(options);
  }

  async handleUpdate(update) {
    return this.messageRouter.handleUpdate(update);
  }

  async start(options = {}) {
    return this.pollingLoop.start(options);
  }

  async stop() {
    return this.pollingLoop.stop();
  }
}
