import { toErrorMessage } from "../../utils.js";
import { BackgroundScheduleRunner } from "./background-schedule-runner.js";
import { ScheduleCommandHandler, createPlainSchedulePresenter } from "./schedule-command-handler.js";
import {
  buildHeartbeatGroupTranscriptMessage,
  buildHeartbeatPrivatePrompt,
  describeNextSchedule
} from "./schedules.js";

export { createPlainSchedulePresenter } from "./schedule-command-handler.js";

function noop() {}

export class ScheduleController {
  constructor({
    stateStore,
    bindingScope,
    log = noop,
    isRunning = () => true,
    waitForAgentOperation = async () => {},
    getSession,
    restoreSession,
    deliveryAnchorForSession = (session) => session.deliveryAnchor ?? null,
    isDirectConversation = () => true,
    groupIdentity = () => ({}),
    schedulePresenter = null,
    scheduleCommandName = "schedule"
  }) {
    if (!stateStore) {
      throw new Error("ScheduleController requires a stateStore.");
    }
    if (typeof bindingScope !== "function") {
      throw new Error("ScheduleController requires bindingScope().");
    }
    if (typeof getSession !== "function") {
      throw new Error("ScheduleController requires getSession().");
    }
    if (typeof restoreSession !== "function") {
      throw new Error("ScheduleController requires restoreSession().");
    }

    this.stateStore = stateStore;
    this.bindingScope = bindingScope;
    this.log = log;
    this.isRunning = isRunning;
    this.waitForAgentOperation = waitForAgentOperation;
    this.getSession = getSession;
    this.restoreSession = restoreSession;
    this.deliveryAnchorForSession = deliveryAnchorForSession;
    this.isDirectConversation = isDirectConversation;
    this.groupIdentity = groupIdentity;
    this.scheduleTimers = new Map();
    this.backgroundRunner = new BackgroundScheduleRunner({
      log,
      deliveryAnchorForSession
    });
    this.commandHandler = new ScheduleCommandHandler({
      presenter: schedulePresenter,
      commandName: scheduleCommandName,
      syncConversationSchedules: (session) => this.syncConversationSchedules(session)
    });
  }

  scheduleKey(conversationId, scheduleName) {
    return `${conversationId}::${scheduleName}`;
  }

  getScheduleTimerCount() {
    return this.scheduleTimers.size;
  }

  getActiveBackgroundRunCount() {
    return this.backgroundRunner.getActiveRunCount();
  }

  hasActiveBackgroundRuns() {
    return this.backgroundRunner.hasActiveRuns();
  }

  clearAllTimers() {
    for (const timer of this.scheduleTimers.values()) {
      clearTimeout(timer);
    }
    this.scheduleTimers.clear();
  }

  clearConversationScheduleTimers(conversationId) {
    const prefix = `${conversationId}::`;
    for (const [key, timer] of this.scheduleTimers.entries()) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      clearTimeout(timer);
      this.scheduleTimers.delete(key);
    }
  }

  syncScheduleTimer(session, schedule) {
    const key = this.scheduleKey(session.conversationId, schedule.name);
    const existingTimer = this.scheduleTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.scheduleTimers.delete(key);
    }

    if (schedule.enabled === false) {
      return;
    }

    try {
      const next = describeNextSchedule(schedule);
      const delayMs = Math.max(0, next.getTime() - Date.now());
      const timer = setTimeout(() => {
        void this.handleScheduledOccurrence(session.conversationId, schedule.name, timer);
      }, delayMs);
      timer.unref?.();
      this.scheduleTimers.set(key, timer);
    } catch (error) {
      this.log(
        `invalid scheduled cron for ${session.conversationId}/${schedule.name}: ${toErrorMessage(error)}`
      );
    }
  }

  syncConversationSchedules(session) {
    this.clearConversationScheduleTimers(session.conversationId);

    for (const schedule of session.schedules) {
      this.syncScheduleTimer(session, schedule);
    }
  }

  async restoreScheduledConversations() {
    const records = await this.stateStore.loadBindingRecords(
      this.bindingScope(),
      {
        onError: (error, details) => {
          this.log(`failed to load conversation state from ${details.stateJsonPath}: ${toErrorMessage(error)}`);
        }
      }
    );

    for (const { scope, record } of records) {
      if (!Array.isArray(record.schedules) || record.schedules.length === 0) {
        continue;
      }

      const session = await this.restoreSession({ scope, record });
      if (!session) {
        continue;
      }
      this.syncConversationSchedules(session);
    }
  }

  async runHeartbeatSchedule(session, schedule, now = new Date()) {
    const deliveryAnchor = await this.deliveryAnchorForSession(session);

    if (await this.isDirectConversation({ session, deliveryAnchor })) {
      await session.enqueueTurn({
        promptText: buildHeartbeatPrivatePrompt(schedule.name, schedule.prompt),
        replyTarget: deliveryAnchor?.replyTarget ?? null,
        scheduleName: schedule.name,
        suppressQueueNotice: true
      });
      return;
    }

    await session.enqueueTurn({
      mode: "group",
      groupInput: {
        messages: [buildHeartbeatGroupTranscriptMessage(schedule.name, schedule.prompt, now)]
      },
      groupIdentity: this.groupIdentity(),
      replyTarget: deliveryAnchor?.replyTarget ?? null,
      scheduleName: schedule.name,
      suppressQueueNotice: true
    });
  }

  async runBackgroundSchedule(session, schedule, now = new Date()) {
    return this.backgroundRunner.run(session, schedule, now);
  }

  async handleScheduledOccurrence(conversationId, scheduleName, expectedTimer = null) {
    await this.waitForAgentOperation();
    const scheduleTimerKey = this.scheduleKey(conversationId, scheduleName);
    if (expectedTimer && this.scheduleTimers.get(scheduleTimerKey) !== expectedTimer) {
      this.log(`schedule skipped (timer superseded): ${scheduleName} in ${conversationId}`);
      return;
    }
    this.scheduleTimers.delete(scheduleTimerKey);
    if (!this.isRunning()) {
      this.log(`schedule skipped (runtime stopped): ${scheduleName} in ${conversationId}`);
      return;
    }
    this.log(`schedule triggered: ${scheduleName} in ${conversationId}`);

    const session = this.getSession(conversationId);
    if (!session) {
      this.log(`schedule skipped (no session): ${scheduleName} in ${conversationId}`);
      return;
    }

    const schedule = session.schedules.find((candidate) => candidate.name === scheduleName);
    if (!schedule) {
      this.log(`schedule skipped (not found): ${scheduleName} in ${conversationId}`);
      return;
    }
    if (schedule.enabled === false) {
      this.log(`schedule skipped (disabled): ${scheduleName} in ${conversationId}`);
      return;
    }

    try {
      if (schedule.mode === "background") {
        await this.runBackgroundSchedule(session, schedule);
      } else {
        await this.runHeartbeatSchedule(session, schedule);
      }
    } catch (error) {
      this.log(`scheduled run "${scheduleName}" failed in ${conversationId}: ${toErrorMessage(error)}`);
    } finally {
      const nextSchedule = session.schedules.find((candidate) => candidate.name === scheduleName);
      if (nextSchedule && this.isRunning()) {
        this.syncScheduleTimer(session, nextSchedule);
      }
    }
  }

  async handleScheduleCommand(session, args, options = {}) {
    return this.commandHandler.handle(session, args, options);
  }

  async stopBackgroundRuns(options = {}) {
    return this.backgroundRunner.stop(options);
  }

  async abortBackgroundRuns(options = {}) {
    return this.stopBackgroundRuns(options);
  }
}
