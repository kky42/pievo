import test from "node:test";
import assert from "node:assert/strict";

import { runFrontAgentTurn } from "../src/chat_adapter/common/front-agent-turn-runner.js";

function createFakeSession() {
  const sentTexts = [];
  const renderedErrors = [];

  return {
    sessionId: "stale-session",
    additionalSystemPromptSnapshot: "snapshot",
    workdir: "/tmp/project",
    auto: "medium",
    model: "default",
    reasoningEffort: "default",
    queue: [],
    isRunning: true,
    activeRun: null,
    activeReplyTarget: null,
    sentTexts,
    renderedErrors,
    logger() {},
    startTyping() {},
    stopTyping() {},
    resetTransientTurnState() {},
    buildFreshAdditionalSystemPrompt() {
      throw new Error("fresh prompt should not be built for resumed sessions");
    },
    async updateSessionId(sessionId) {
      this.sessionId = sessionId;
    },
    async updateContextLength() {},
    async clearProgressMessage() {},
    async clearSessionState() {
      this.sessionId = null;
    },
    async renderProgressText() {},
    async renderFinalMessage() {},
    async renderErrorText(text) {
      renderedErrors.push(text);
    },
    async sendText(text) {
      sentTexts.push(text);
    }
  };
}

test("heartbeat scheduled front-agent turns keep schedule tools available", async () => {
  const session = createFakeSession();
  let capturedBridgeOptions = null;
  const turn = {
    mode: "private",
    promptText: "Heartbeat scheduled turn: check-job",
    attachments: [],
    replyTarget: null,
    scheduleName: "check-job",
    resumeRetryCount: 0
  };

  await runFrontAgentTurn({
    session,
    turn,
    createToolBridge: async (options) => {
      capturedBridgeOptions = options;
      return { env: {}, dispose() {} };
    },
    createAgentRun: () => ({
      done: Promise.resolve({ code: 0, signal: null, aborted: false, sawTerminalEvent: true }),
      abort() {}
    }),
    resolveContextLength: async () => null
  });

  assert.equal(capturedBridgeOptions.disableScheduleTools, false);
});

test("runFrontAgentTurn retries stale resumed Pi sessions reported only on stderr", async () => {
  const session = createFakeSession();
  const turn = {
    mode: "private",
    promptText: "hello",
    attachments: [],
    replyTarget: null,
    resumeRetryCount: 0
  };

  await runFrontAgentTurn({
    session,
    turn,
    createToolBridge: async () => ({ env: {}, dispose() {} }),
    createAgentRun: (params) => {
      params.onStdErr("No session found matching stale-session\n");
      return {
        done: Promise.resolve().then(() => {
          throw new Error("pi exited with code 1");
        }),
        abort() {}
      };
    },
    resolveContextLength: async () => null
  });

  assert.equal(session.sessionId, null);
  assert.equal(session.queue.length, 1);
  assert.equal(session.queue[0].resumeRetryCount, 1);
  assert.equal(session.queue[0].promptText, "hello");
  assert.deepEqual(session.renderedErrors, []);
  assert.match(session.sentTexts[0], /Stored session could not be resumed/);
});
