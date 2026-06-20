import path from "node:path";

import {
  DEFAULT_CACHE_PATH,
  toErrorMessage
} from "../../utils.js";
import { ConversationStateStore } from "../common/conversation-state-store.js";
import { NOOP_CONFIG_STORE } from "../common/config-store.js";
import { ScheduleController } from "../common/schedule-controller.js";
import { resetSession } from "../common/session-reset.js";
import { ChatSession } from "./chat-session.js";
import {
  DEFAULT_RECONNECT_DELAY_MS,
  DEFAULT_STALE_WEBSOCKET_MS,
  DEFAULT_WATCHDOG_INTERVAL_MS,
  createMattermostConnectionLoop
} from "./connection-loop.js";
import { createMattermostEventRouter } from "./event-router.js";
import { mattermostUserDisplayName } from "./group-input.js";
import { MattermostApi } from "./mattermost-api.js";
import { CHAT_COMMANDS } from "../common/render.js";

export const MATTERMOST_COMMANDS = CHAT_COMMANDS;

export class BotRuntime {
  constructor({
    botConfig,
    configStore = NOOP_CONFIG_STORE,
    fetchImpl = globalThis.fetch,
    WebSocketImpl = undefined,
    botApi = null,
    createAgentRun = null,
    cacheRootDir = DEFAULT_CACHE_PATH,
    stateRootDir = null,
    watchdogIntervalMs = DEFAULT_WATCHDOG_INTERVAL_MS,
    staleWebSocketMs = DEFAULT_STALE_WEBSOCKET_MS,
    operationLocks = null
  }) {
    this.botConfig = botConfig;
    this.configStore = configStore;
    this.botApi = botApi ?? new MattermostApi({
      serverUrl: botConfig.serverUrl,
      token: botConfig.token,
      fetchImpl,
      WebSocketImpl,
      logger: (message) => this.log(message)
    });
    this.createAgentRun = createAgentRun;
    this.cacheRootDir = cacheRootDir;
    this.stateStore = new ConversationStateStore({
      rootDir: stateRootDir || path.join(path.dirname(cacheRootDir), "state")
    });
    this.botUsername = null;
    this.botUserId = null;
    this.botDisplayName = "Pievo";
    this.websocket = null;
    this.connected = false;
    this.running = false;
    this.sessions = new Map();
    this.channels = new Map();
    this.users = new Map();
    this.reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS;
    this.watchdogIntervalMs = watchdogIntervalMs;
    this.staleWebSocketMs = staleWebSocketMs;
    this.stopRequested = false;
    this.connectPromise = null;
    this.pendingWebSocket = null;
    this.operationLocks = operationLocks;
    this.eventRouter = createMattermostEventRouter(this);
    this.connectionLoop = createMattermostConnectionLoop(this);
    this.scheduleController = new ScheduleController({
      stateStore: this.stateStore,
      bindingScope: () => ({
        agentId: this.botConfig.agent.id,
        platform: "mattermost",
        bindingId: this.botConfig.bindingId
      }),
      log: (message) => this.log(message),
      isRunning: () => this.isActive(),
      waitForAgentOperation: () => this.waitForAgentOperation(),
      getSession: (conversationId) => this.sessions.get(String(conversationId)),
      restoreSession: ({ scope, record }) => {
        const channelId = String(record.deliveryAnchor?.channelId ?? "").trim();
        if (!channelId) {
          this.log(`skipping scheduled restore for ${scope.conversationId}: missing delivery anchor`);
          return null;
        }
        return this.sessionFor(channelId, {
          conversationId: scope.conversationId,
          deliveryAnchor: record.deliveryAnchor
        });
      },
      deliveryAnchorForSession: (session) =>
        session.deliveryAnchor ?? { channelId: session.channelId, replyTarget: null },
      isDirectConversation: async ({ session, deliveryAnchor }) => {
        const channel = await this.channelFor(deliveryAnchor?.channelId ?? session.channelId);
        return this.isDirectChannel(channel);
      },
      groupIdentity: () => this.groupIdentity(),
      scheduleCommandName: "!schedule"
    });
    this.lastWsOpenAt = null;
    this.lastWsActivityAt = null;
    this.lastWsMessageAt = null;
    this.lastWsErrorAt = null;
    this.lastWsCloseAt = null;
    this.reconnectCount = 0;
    this.wakeConnectionLoop = null;
  }

  log(message) {
    process.stderr.write(`[mattermost:${this.botConfig.bindingId}] ${message}\n`);
  }

  sessionFor(channelId, options = {}) {
    const conversationId = options.conversationId ?? channelId;
    const key = String(conversationId);
    let session = this.sessions.get(key);
    if (!session) {
      session = new ChatSession({
        botConfig: this.botConfig,
        botApi: this.botApi,
        configStore: this.configStore,
        logger: (message) => this.log(`${key}: ${message}`),
        channelId,
        conversationId,
        websocket: this.websocket,
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

  async loadReferencePost(post) {
    return this.eventRouter.loadReferencePost(post);
  }

  async buildPrivateReferenceText(session, post) {
    return this.eventRouter.buildPrivateReferenceText(session, post);
  }

  async buildGroupReferenceText(session, post) {
    return this.eventRouter.buildGroupReferenceText(session, post);
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

  async channelFor(channelId) {
    const key = String(channelId);
    if (this.channels.has(key)) {
      return this.channels.get(key);
    }
    try {
      const channel = await this.botApi.getChannel(channelId);
      this.channels.set(key, channel);
      return channel;
    } catch (error) {
      this.log(`failed to load Mattermost channel ${key}: ${toErrorMessage(error)}`);
      return null;
    }
  }

  async userFor(userId) {
    const key = String(userId ?? "");
    if (!key) {
      return null;
    }
    if (this.users.has(key)) {
      return this.users.get(key);
    }
    try {
      const user = await this.botApi.getUser(key);
      this.users.set(key, user);
      return user;
    } catch (error) {
      if (error?.status !== 404) {
        this.log(`failed to load Mattermost user ${key}: ${toErrorMessage(error)}`);
      }
      return null;
    }
  }

  async enrichPost(post) {
    if (!post || post.user) {
      return post;
    }
    const user = await this.userFor(post.user_id);
    return user ? { ...post, user } : post;
  }

  isDirectChannel(channel) {
    return channel?.type === "D";
  }

  hasPendingBotWork() {
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
    const username = String(user?.username ?? "").trim().replace(/^@+/, "").toLowerCase();
    const managerUsernames = Array.isArray(this.botConfig.managerUsernames)
      ? this.botConfig.managerUsernames
      : [];
    return Boolean(
      username &&
      (this.botConfig.allowedUsernames.includes(username) || managerUsernames.includes(username))
    );
  }

  isManager(user) {
    const username = String(user?.username ?? "").trim().replace(/^@+/, "").toLowerCase();
    const managerUsernames = Array.isArray(this.botConfig.managerUsernames)
      ? this.botConfig.managerUsernames
      : this.botConfig.allowedUsernames;
    return Boolean(username && managerUsernames.includes(username));
  }

  async initialize({ restoreScheduledConversations = true } = {}) {
    const me = await this.botApi.getMe();
    this.botUsername = String(me.username ?? "").trim().toLowerCase();
    this.botUserId = String(me.id ?? "").trim();
    this.botDisplayName = mattermostUserDisplayName(me, "Pievo");
    if (this.botConfig.username && this.botUsername !== this.botConfig.username) {
      throw new Error(
        `Configured Mattermost bot username @${this.botConfig.username} does not match token owner @${this.botUsername || "unknown"}.`
      );
    }
    this.log(`ready as @${this.botUsername} for agent ${this.botConfig.agent.id} with workdir ${this.botConfig.agent.workdir}`);
    if (restoreScheduledConversations) {
      await this.restoreScheduledConversations();
    }
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
    return !this.stopRequested;
  }

  requestStop() {
    this.stopRequested = true;
    this.running = false;
    this.wakeConnectionLoop?.();
    this.pendingWebSocket?.close?.();
    this.pendingWebSocket = null;
    this.websocket?.close?.();
    this.websocket = null;
    this.scheduleController.clearAllTimers();
  }

  async stopBackgroundRuns(options = {}) {
    return this.scheduleController.stopBackgroundRuns(options);
  }

  async abortBackgroundRuns(options = {}) {
    return this.stopBackgroundRuns(options);
  }

  async resetSessions() {
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

  async sendDirectMessage(channelId, text) {
    const session = this.sessionFor(channelId, {
      deliveryAnchor: {
        channelId,
        replyTarget: null
      }
    });
    await session.sendText(text);
  }

  async handleClearCache(sessionOrChannelId, options = {}) {
    const session =
      sessionOrChannelId instanceof ChatSession
        ? sessionOrChannelId
        : this.sessionFor(sessionOrChannelId);
    if (this.hasPendingBotWork()) {
      await session.sendText(
        "Cannot clear cache while runs or queued turns are pending.",
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

  async handleEvent(event) {
    return this.eventRouter.handleEvent(event);
  }

  async handleGroupTriggerPost(options) {
    return this.eventRouter.handleGroupTriggerPost(options);
  }

  async connect() {
    return this.connectionLoop.connect();
  }

  isWebSocketStale(now = Date.now()) {
    return this.connectionLoop.isWebSocketStale(now);
  }

  closeStaleWebSocket(now = Date.now()) {
    return this.connectionLoop.closeStaleWebSocket(now);
  }

  waitForConnectionLoopWake(ms) {
    return this.connectionLoop.waitForConnectionLoopWake(ms);
  }

  async start(options = {}) {
    return this.connectionLoop.start(options);
  }

  async stop() {
    return this.connectionLoop.stop();
  }
}
