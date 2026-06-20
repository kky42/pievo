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

test("background schedules create a Pi tool bridge and pass its env to the run", async () => {
  const session = createBackgroundSession();
  const bridgeCalls = [];
  let disposed = false;
  const { controller } = createController({
    getSession: () => session,
    isDirectConversation: () => false,
    groupIdentity: () => ({ botName: "Relay", botHandle: "@relaybot" }),
    createToolBridge: async (params) => {
      bridgeCalls.push(params);
      return {
        env: {
          PIEVO_TOOL_BRIDGE_URL: "http://127.0.0.1:1234/tool",
          PIEVO_TOOL_BRIDGE_TOKEN: "token",
          PIEVO_CHAT_MODE: params.isGroupTurn ? "group" : "private"
        },
        dispose() {
          disposed = true;
        }
      };
    }
  });

  await controller.runBackgroundSchedule(session, {
    mode: "background",
    name: "daily",
    cron: "* * * * *",
    prompt: "summarize"
  });

  assert.equal(bridgeCalls.length, 1);
  assert.equal(bridgeCalls[0].isGroupTurn, true);
  assert.equal(bridgeCalls[0].disableScheduleTools, true);
  assert.equal(session.capturedRunParams.extraEnv.PIEVO_TOOL_BRIDGE_TOKEN, "token");
  assert.match(session.capturedRunParams.message, /Run this existing scheduled task once/);
  assert.match(session.capturedRelayInstructions, /send_reply/);
  assert.equal(disposed, true);
});

test("group background final text is suppressed instead of delivered with sendText", async () => {
  const session = createBackgroundSession();
  const { controller } = createController({
    getSession: () => session,
    isDirectConversation: () => false,
    createToolBridge: async () => ({ env: {}, dispose() {} })
  });

  await controller.runBackgroundSchedule(session, {
    mode: "background",
    name: "daily",
    cron: "* * * * *",
    prompt: "summarize"
  });

  assert.deepEqual(session.sentTexts, []);
  assert.match(session.sessionLogs.join("\n"), /background final group text suppressed/);
});

test("private background final text is delivered as a notification", async () => {
  const session = createBackgroundSession();
  const { controller } = createController({
    getSession: () => session,
    isDirectConversation: () => true,
    createToolBridge: async () => ({ env: { PIEVO_CHAT_MODE: "private" }, dispose() {} })
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
