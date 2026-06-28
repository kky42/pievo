import test from "node:test";
import assert from "node:assert/strict";

import { ScheduleController } from "../src/chat_adapter/common/schedule-controller.js";
import { createSession } from "./support/builders.js";

function createController(options = {}) {
  const logs = [];
  const controller = new ScheduleController({
    stateStore: {},
    bindingScope: () => ({ agentId: "agent", platform: "telegram", bindingId: "relaybot" }),
    log: (message) => logs.push(message),
    getSession: () => null,
    restoreSession: () => null,
    ...options
  });
  return { controller, logs };
}

function createBackgroundSession(overrides = {}) {
  const sentTexts = [];
  const renderedFinalMessages = [];
  const sessionLogs = [];
  let capturedRunParams = null;
  let capturedRelayInstructions = null;

  const session = {
    conversationId: "conversation-1",
    workdir: "/tmp/project",
    auto: "medium",
    model: "default",
    reasoningEffort: "default",
    schedules: [],
    sentTexts,
    renderedFinalMessages,
    sessionLogs,
    logger(message) {
      sessionLogs.push(message);
    },
    buildFreshAdditionalSystemPrompt(relayInstructions) {
      capturedRelayInstructions = relayInstructions;
      return `profile\n${relayInstructions ?? ""}`;
    },
    createAgentRun(params) {
      capturedRunParams = params;
      return {
        done: (async () => {
          await params.onEvent({
            type: "message_end",
            message: {
              role: "assistant",
              content: "background result"
            }
          });
          return { aborted: false, sawTerminalEvent: true };
        })(),
        abort() {}
      };
    },
    async sendText(text, options = {}) {
      sentTexts.push({ text, options });
    },
    async renderFinalMessage(text, options = {}) {
      renderedFinalMessages.push({ text, options });
    },
    get capturedRunParams() {
      return capturedRunParams;
    },
    get capturedRelayInstructions() {
      return capturedRelayInstructions;
    },
    ...overrides
  };

  return session;
}

test("background schedules run as plain Pi invocations without Pievo tools", async () => {
  const session = createBackgroundSession();
  const { controller } = createController({
    getSession: () => session,
    isDirectConversation: () => false
  });

  await controller.runBackgroundSchedule(session, {
    mode: "background",
    name: "daily",
    cron: "* * * * *",
    prompt: "summarize"
  });

  assert.equal(session.capturedRunParams.message, "summarize");
  assert.equal(session.capturedRunParams.enablePievoTools, false);
  assert.equal(session.capturedRunParams.extraEnv, undefined);
  assert.equal(session.capturedRelayInstructions, null);
});

test("group background final text is delivered through final-message rendering", async () => {
  const session = createBackgroundSession();
  const { controller } = createController({
    getSession: () => session,
    isDirectConversation: () => false
  });

  await controller.runBackgroundSchedule(session, {
    mode: "background",
    name: "daily",
    cron: "* * * * *",
    prompt: "summarize"
  }, new Date("2026-06-20T12:34:56Z"));

  assert.equal(session.sentTexts.length, 0);
  assert.equal(session.renderedFinalMessages.length, 1);
  assert.match(session.renderedFinalMessages[0].text, /Background scheduled run: daily/);
  assert.match(session.renderedFinalMessages[0].text, /background result/);
  assert.equal(session.renderedFinalMessages[0].options.reuseProgressMessage, false);
});

test("private background final text is delivered through final-message rendering", async () => {
  const session = createBackgroundSession();
  const { controller } = createController({
    getSession: () => session,
    isDirectConversation: () => true
  });

  await controller.runBackgroundSchedule(session, {
    mode: "background",
    name: "daily",
    cron: "* * * * *",
    prompt: "summarize"
  }, new Date("2026-06-20T12:34:56Z"));

  assert.equal(session.sentTexts.length, 0);
  assert.equal(session.renderedFinalMessages.length, 1);
  assert.match(session.renderedFinalMessages[0].text, /Background scheduled run: daily/);
  assert.match(session.renderedFinalMessages[0].text, /background result/);
  assert.equal(session.renderedFinalMessages[0].options.reuseProgressMessage, false);
});

test("heartbeat schedules stay in the foreground FIFO with user messages", async () => {
  const { session, fakeBotApi } = await createSession();
  session.isRunning = true;
  const { controller } = createController({
    getSession: () => session,
    restoreSession: () => session,
    isDirectConversation: () => true
  });

  await session.enqueueMessage("user-1");
  await controller.runHeartbeatSchedule(session, {
    mode: "heartbeat",
    name: "hb1",
    cron: "* * * * *",
    prompt: "beat 1"
  });
  await controller.runHeartbeatSchedule(session, {
    mode: "heartbeat",
    name: "hb2",
    cron: "* * * * *",
    prompt: "beat 2"
  });
  await session.enqueueMessage("user-2");

  assert.equal(session.queue.length, 4);
  assert.equal(session.queue[0].promptText, "user-1");
  assert.equal(session.queue[0].scheduleName, null);
  assert.equal(session.queue[1].scheduleName, "hb1");
  assert.equal(session.queue[1].suppressQueueNotice, true);
  assert.equal(session.queue[2].scheduleName, "hb2");
  assert.equal(session.queue[2].suppressQueueNotice, true);
  assert.equal(session.queue[3].promptText, "user-2");
  assert.equal(session.queue[3].scheduleName, null);
  assert.deepEqual(fakeBotApi.messages.map((message) => message.text), [
    "Queued message 1.",
    "Queued message 4."
  ]);
});

test("background schedules start independently while foreground turns stay queued", async () => {
  const { session, fakeBotApi, runnerFactory } = await createSession();
  session.isRunning = true;
  const { controller } = createController({
    getSession: () => session,
    restoreSession: () => session,
    isDirectConversation: () => true
  });

  await session.enqueueMessage("user-1");

  const bg1Promise = controller.runBackgroundSchedule(
    session,
    {
      mode: "background",
      name: "bg1",
      cron: "* * * * *",
      prompt: "bg 1"
    },
    new Date("2026-06-20T12:34:56Z")
  );
  const bg2Promise = controller.runBackgroundSchedule(
    session,
    {
      mode: "background",
      name: "bg2",
      cron: "* * * * *",
      prompt: "bg 2"
    },
    new Date("2026-06-20T12:34:56Z")
  );
  await session.enqueueMessage("user-2");

  assert.equal(session.queue.length, 2);
  assert.equal(session.queue[0].promptText, "user-1");
  assert.equal(session.queue[1].promptText, "user-2");
  assert.deepEqual(fakeBotApi.messages.map((message) => message.text).slice(0, 2), [
    "Queued message 1.",
    "Queued message 2."
  ]);
  assert.equal(runnerFactory.runs.length, 2);
  assert.deepEqual(
    runnerFactory.runs.map((run) => ({
      message: run.params.message,
      enablePievoTools: run.params.enablePievoTools,
      sessionId: run.params.sessionId
    })),
    [
      { message: "bg 1", enablePievoTools: false, sessionId: null },
      { message: "bg 2", enablePievoTools: false, sessionId: null }
    ]
  );

  runnerFactory.runs[0].finish({ code: 0, signal: null, aborted: false, sawTerminalEvent: true });
  runnerFactory.runs[1].finish({ code: 0, signal: null, aborted: false, sawTerminalEvent: true });
  await Promise.all([bg1Promise, bg2Promise]);

  assert.match(String(fakeBotApi.messages[2].text ?? ""), /Background scheduled run: bg1/);
  assert.match(String(fakeBotApi.messages[3].text ?? ""), /Background scheduled run: bg2/);
});

test("fired timers are removed when no live or restored session exists", async () => {
  const { controller } = createController({
    getSession: () => null
  });
  const timer = { id: "expected" };
  const key = controller.scheduleKey("missing-conversation", "daily");
  controller.scheduleTimers.set(key, timer);

  await controller.handleScheduledOccurrence("missing-conversation", "daily", timer);

  assert.equal(controller.scheduleTimers.has(key), false);
});

test("one-time heartbeat schedules are removed when triggered without clearing queued turns", async () => {
  const { session } = await createSession();
  session.isRunning = true;
  let removeQueuedCalls = 0;
  const originalRemoveQueued = session.removeQueuedScheduledTurns.bind(session);
  session.removeQueuedScheduledTurns = (name) => {
    removeQueuedCalls += 1;
    return originalRemoveQueued(name);
  };
  await session.replaceSchedules([
    {
      mode: "heartbeat",
      name: "once-hb",
      trigger: "once",
      runAt: "2999-06-22T09:00:00+08:00",
      prompt: "beat once",
      enabled: true
    }
  ]);
  const { controller } = createController({
    getSession: () => session,
    restoreSession: () => session,
    isDirectConversation: () => true
  });
  const timer = { id: "expected" };
  const key = controller.scheduleKey(session.conversationId, "once-hb");
  controller.scheduleTimers.set(key, timer);

  await controller.handleScheduledOccurrence(session.conversationId, "once-hb", timer);

  assert.deepEqual(session.schedules, []);
  assert.equal(removeQueuedCalls, 0);
  assert.equal(session.queue.length, 1);
  assert.equal(session.queue[0].scheduleName, "once-hb");
  assert.equal(controller.scheduleTimers.has(key), false);
});

test("one-time background schedules are removed before the background run completes", async () => {
  const { session, runnerFactory } = await createSession();
  await session.replaceSchedules([
    {
      mode: "background",
      name: "once-bg",
      trigger: "once",
      runAt: "2999-06-22T09:00:00+08:00",
      prompt: "run once",
      enabled: true
    }
  ]);
  const { controller } = createController({
    getSession: () => session,
    restoreSession: () => session,
    isDirectConversation: () => true
  });
  const timer = { id: "expected" };
  const key = controller.scheduleKey(session.conversationId, "once-bg");
  controller.scheduleTimers.set(key, timer);

  const triggered = controller.handleScheduledOccurrence(session.conversationId, "once-bg", timer);
  for (let index = 0; index < 20 && runnerFactory.runs.length === 0; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(runnerFactory.runs.length, 1);
  assert.deepEqual(session.schedules, []);
  assert.equal(controller.scheduleTimers.has(key), false);

  runnerFactory.runs[0].finish({ code: 0, signal: null, aborted: false, sawTerminalEvent: true });
  await triggered;
});
