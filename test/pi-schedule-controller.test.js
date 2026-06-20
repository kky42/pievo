import test from "node:test";
import assert from "node:assert/strict";

import { ScheduleController } from "../src/chat_adapter/common/schedule-controller.js";

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

test("group background final text is delivered as a runtime notification", async () => {
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

  assert.equal(session.sentTexts.length, 1);
  assert.match(session.sentTexts[0].text, /Background scheduled run: daily/);
  assert.match(session.sentTexts[0].text, /background result/);
});

test("private background final text is delivered as a notification", async () => {
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

  assert.equal(session.sentTexts.length, 1);
  assert.match(session.sentTexts[0].text, /Background scheduled run: daily/);
  assert.match(session.sentTexts[0].text, /background result/);
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
