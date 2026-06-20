import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../src/config.js";
import { ConversationStateStore } from "../src/chat_adapter/common/conversation-state-store.js";
import { ConversationResetter } from "../src/control/conversation-resetter.js";
import { AgentOperationLocks } from "../src/control/operation-locks.js";
import { RuntimeReconciler } from "../src/control/runtime-reconciler.js";
import { RuntimeRegistry } from "../src/control/runtime-registry.js";
import { ResetService } from "../src/control/reset-service.js";
import {
  formatAgentProfileResetSummary,
  resultTextForConversation
} from "../src/control/reset-summary.js";

function makeStateRecord(scope, { deliveryAnchor, sessionId = "session-1" } = {}) {
  return {
    version: 1,
    conversation: {
      agentId: scope.agentId,
      platform: scope.platform,
      bindingId: scope.bindingId,
      conversationId: scope.conversationId
    },
    deliveryAnchor,
    session: {
      id: sessionId,
      contextLength: 123,
      basis: {
        workdir: "/tmp/old-workdir",
        additionalSystemPromptSnapshot: "frozen prompt"
      }
    },
    overrides: {
      model: "old-model"
    },
    schedules: [
      {
        name: "daily",
        mode: "heartbeat",
        cron: "0 9 * * *",
        prompt: "check status",
        enabled: true
      }
    ]
  };
}

function makeBinding(bindingId, overrides = {}) {
  return {
    platform: "telegram",
    bindingId,
    username: bindingId,
    token: `token-${bindingId}`,
    agent: {
      id: "agent",
      workdir: "/tmp/project",
      auto: "medium",
      model: "default",
      reasoningEffort: "default"
    },
    allowedUsernames: ["alloweduser"],
    ...overrides
  };
}

function makeRuntime(botConfig) {
  return {
    botConfig: structuredClone(botConfig),
    started: false,
    startOptions: [],
    stopRequested: false,
    stopped: false,
    async start(options) {
      this.started = true;
      this.startOptions.push(options);
    },
    requestStop() {
      this.stopRequested = true;
    },
    async stop() {
      this.stopped = true;
    }
  };
}

async function writeAgentConfig(tempDir, botSpecs) {
  const workdir = path.join(tempDir, "workdir");
  const agentDir = path.join(tempDir, "agent");
  await fs.mkdir(workdir, { recursive: true });
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(
    path.join(agentDir, "config.json"),
    `${JSON.stringify(
      {
        profile: {
          workdir,
          auto: "medium",
          model: "test-model",
          reasoningEffort: "high"
        },
        bindings: {
          telegram: {
            bots: botSpecs
          }
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return { configPath: agentDir, workdir };
}

function bindingById(config, bindingId) {
  return config.chatBindings.find((binding) => binding.bindingId === bindingId);
}

function makeResetServiceSession(conversationId, events, options = {}) {
  return {
    conversationId,
    isRunning: options.isRunning === true,
    queue: [...(options.queue ?? [])],
    async resetToAgentProfileDefaults({ agentProfile }) {
      events.push(`session-reset:${conversationId}:${agentProfile.id}`);
      this.isRunning = false;
      this.queue = [];
      return { ok: true, text: "reset" };
    }
  };
}

function makeResetServiceRuntime(botConfig, options = {}) {
  const {
    events = [],
    label = botConfig.bindingId,
    sessions = [],
    stateStore = null,
    stopError = null
  } = options;
  return {
    label,
    botConfig: structuredClone(botConfig),
    sessions: new Map(sessions.map((session) => [session.conversationId, session])),
    startOptions: [],
    stopRequested: false,
    stopped: false,
    scheduleTimerCount: 0,
    syncedConversations: [],
    async start(startOptions = {}) {
      this.startOptions.push(startOptions);
      events.push(`start:${label}:${startOptions.restoreScheduledConversations}`);
      if (startOptions.restoreScheduledConversations !== false) {
        await this.restoreScheduledConversations();
      }
    },
    requestStop() {
      this.stopRequested = true;
      events.push(`request-stop:${label}`);
    },
    async stop() {
      events.push(`stop:${label}`);
      if (stopError) {
        throw new Error(stopError);
      }
      this.stopped = true;
    },
    async abortBackgroundRuns(options) {
      assert.deepEqual(options, { suppressNotification: true });
      return 0;
    },
    syncConversationSchedules(session) {
      this.syncedConversations.push(session.conversationId);
      events.push(`sync:${label}:${session.conversationId}`);
    },
    async restoreScheduledConversations() {
      events.push(`restore:${label}`);
      const records = stateStore
        ? await stateStore.loadBindingRecords({
            agentId: this.botConfig.agent.id,
            platform: this.botConfig.platform,
            bindingId: this.botConfig.bindingId
          })
        : [];
      const staleRecord = records.find(({ record }) => record.session !== null);
      if (staleRecord) {
        throw new Error(`restore saw stale session for ${staleRecord.scope.scopeKey}`);
      }
      this.scheduleTimerCount = records.reduce(
        (total, { record }) => total + record.schedules.filter((schedule) => schedule.enabled).length,
        0
      );
    },
    getScheduleTimerCount() {
      return this.scheduleTimerCount;
    }
  };
}

test("reset summary keeps operator-facing text stable", () => {
  assert.equal(
    resultTextForConversation({
      workdir: "/tmp/project",
      auto: "medium",
      model: "gpt-5-mini",
      reasoningEffort: "high"
    }),
    "Reset this conversation to current agent profile defaults. Started a new Pi session with workdir /tmp/project, auto medium, model gpt-5-mini, reasoning effort high."
  );

  assert.equal(
    formatAgentProfileResetSummary({
      ok: false,
      agentId: "agent",
      bindings: {
        added: 1,
        removed: 2,
        restarted: 3,
        updated: 4,
        unchanged: 5,
        failed: 1
      },
      conversations: {
        live: 6,
        durable: 7
      },
      schedules: {
        timers: 8
      },
      runs: {
        aborted: 9,
        queuesCleared: 10
      },
      failures: [
        {
          target: "telegram:relaybot",
          message: "boom"
        }
      ]
    }),
    [
      "Reset agent profile with errors agent.",
      "Bindings: 1 added, 2 removed, 3 restarted, 4 updated, 5 unchanged, 1 failed.",
      "Conversations: 6 live reset, 7 durable reset.",
      "Schedules: 8 active timers resynced.",
      "Runs: 9 aborted, 10 queues cleared.",
      "Failed:",
      "telegram:relaybot: boom"
    ].join("\n")
  );
});

test("conversation resetter resets live sessions and collects per-session failures", async () => {
  const resetCalls = [];
  const synced = [];
  const runtime = {
    botConfig: {
      platform: "telegram",
      bindingId: "relaybot",
      agent: {
        id: "agent"
      }
    },
    sessions: new Map(),
    async abortBackgroundRuns(options) {
      assert.deepEqual(options, { suppressNotification: true });
      return 2;
    },
    syncConversationSchedules(session) {
      synced.push(session.conversationId);
    }
  };
  runtime.sessions.set("ok", {
    conversationId: "ok",
    isRunning: true,
    queue: ["queued"],
    async resetToAgentProfileDefaults({ agentProfile }) {
      resetCalls.push({ conversationId: "ok", agentProfile });
      return { ok: true, text: "reset" };
    }
  });
  runtime.sessions.set("bad", {
    conversationId: "bad",
    isRunning: false,
    queue: [],
    async resetToAgentProfileDefaults({ agentProfile }) {
      resetCalls.push({ conversationId: "bad", agentProfile });
      return { ok: false, text: "session failed" };
    }
  });

  const failures = [];
  const seenLiveScopes = new Set();
  const resetter = new ConversationResetter({ stateStore: {} });
  const counts = await resetter.resetLiveRuntimeSessions(
    runtime,
    { id: "agent", model: "default" },
    failures,
    seenLiveScopes
  );

  assert.deepEqual(counts, { live: 1, aborted: 3, queuesCleared: 1 });
  assert.deepEqual(synced, ["ok"]);
  assert.deepEqual(resetCalls.map((call) => call.conversationId), ["ok", "bad"]);
  assert.deepEqual([...seenLiveScopes].sort(), [
    "agent:telegram:relaybot:bad",
    "agent:telegram:relaybot:ok"
  ]);
  assert.deepEqual(failures, [
    {
      target: "agent:telegram:relaybot:bad",
      message: "session failed"
    }
  ]);
});

test("conversation resetter resets durable binding records without touching live scopes", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pievo-resetter-"));
  const stateStore = new ConversationStateStore({
    rootDir: path.join(tempDir, "state")
  });
  const resetter = new ConversationResetter({ stateStore });

  const liveScope = stateStore.scopeFor({
    agentId: "agent",
    platform: "telegram",
    bindingId: "relaybot",
    conversationId: "live"
  });
  const durableScope = stateStore.scopeFor({
    agentId: "agent",
    platform: "telegram",
    bindingId: "relaybot",
    conversationId: "durable"
  });
  const otherBindingScope = stateStore.scopeFor({
    agentId: "agent",
    platform: "mattermost",
    bindingId: "local:relay",
    conversationId: "channel-1"
  });

  await stateStore.saveRecord(
    liveScope,
    makeStateRecord(liveScope, {
      deliveryAnchor: { chatId: 1001, replyTarget: null },
      sessionId: "live-session"
    })
  );
  await stateStore.saveRecord(
    durableScope,
    makeStateRecord(durableScope, {
      deliveryAnchor: { chatId: 1002, replyTarget: null },
      sessionId: "durable-session"
    })
  );
  await stateStore.saveRecord(
    otherBindingScope,
    makeStateRecord(otherBindingScope, {
      deliveryAnchor: { channelId: "channel-1", replyTarget: null },
      sessionId: "mattermost-session"
    })
  );

  const failures = [];
  const durable = await resetter.resetDurableBindingRecords(
    { agentId: "agent", platform: "telegram", bindingId: "relaybot" },
    failures,
    new Set([liveScope.scopeKey])
  );

  assert.equal(durable, 1);
  assert.deepEqual(failures, []);
  assert.equal((await stateStore.loadRecord(liveScope)).session.id, "live-session");

  const resetRecord = await stateStore.loadRecord(durableScope);
  assert.equal(resetRecord.session, null);
  assert.deepEqual(resetRecord.overrides, {});
  assert.deepEqual(resetRecord.deliveryAnchor, { chatId: 1002, replyTarget: null });
  assert.deepEqual(resetRecord.schedules, [
    {
      name: "daily",
      mode: "heartbeat",
      cron: "0 9 * * *",
      prompt: "check status",
      enabled: true
    }
  ]);

  assert.equal((await stateStore.loadRecord(otherBindingScope)).session.id, "mattermost-session");
});

test("runtime reconciler starts, stops, restarts, and updates registry bindings", async () => {
  const updateRuntime = makeRuntime(makeBinding("update", { allowedUsernames: ["olduser"] }));
  const restartRuntime = makeRuntime(makeBinding("restart", { token: "old-token" }));
  const removedRuntime = makeRuntime(makeBinding("removed"));
  const unchangedBinding = makeBinding("unchanged");
  const unchangedRuntime = makeRuntime(unchangedBinding);
  const registry = new RuntimeRegistry([
    updateRuntime,
    restartRuntime,
    removedRuntime,
    unchangedRuntime
  ]);
  const startedRuntimes = [];
  const reconciler = new RuntimeReconciler({
    runtimeRegistry: registry,
    createRuntime: (botConfig) => {
      const runtime = makeRuntime(botConfig);
      startedRuntimes.push(runtime);
      return runtime;
    }
  });
  const failures = [];
  const retired = [];

  const reconciliation = await reconciler.reconcileAgentRuntimes({
    agentId: "agent",
    desiredBindings: [
      makeBinding("update", { allowedUsernames: ["newuser"] }),
      makeBinding("restart", { token: "new-token" }),
      structuredClone(unchangedBinding),
      makeBinding("added")
    ],
    failures,
    beforeRetireRuntime: async (runtime) => {
      retired.push(runtime.botConfig.bindingId);
    }
  });

  assert.deepEqual(reconciliation.counts, {
    added: 1,
    removed: 1,
    restarted: 1,
    updated: 1,
    unchanged: 1
  });
  assert.deepEqual(failures, []);
  assert.deepEqual(retired.sort(), ["removed", "restart"]);
  assert.deepEqual(updateRuntime.botConfig.allowedUsernames, ["newuser"]);
  assert.equal(registry.find({ platform: "telegram", bindingId: "removed" }), null);
  assert.equal(removedRuntime.stopRequested, true);
  assert.equal(restartRuntime.stopRequested, true);

  const replacement = registry.find({ platform: "telegram", bindingId: "restart" });
  assert.notEqual(replacement, restartRuntime);
  assert.equal(replacement.botConfig.token, "new-token");
  assert.ok(registry.find({ platform: "telegram", bindingId: "added" }));
  assert.deepEqual(
    startedRuntimes.map((runtime) => runtime.botConfig.bindingId).sort(),
    ["added", "restart"]
  );
  assert.ok(startedRuntimes.every((runtime) => runtime.startOptions[0].restoreScheduledConversations === false));
  assert.deepEqual(new Set(reconciliation.pendingStops), new Set([restartRuntime, removedRuntime]));

  await reconciler.stopPendingRuntimes(reconciliation.pendingStops, failures);
  assert.equal(restartRuntime.stopped, true);
  assert.equal(removedRuntime.stopped, true);
});

test("reset service composes binding reconciliation, session reset, and deferred schedule restore", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pievo-reset-service-"));
  const { configPath } = await writeAgentConfig(tempDir, [
    { username: "updatebot", token: "token-update", allowedUsernames: ["newuser"] },
    { username: "restartbot", token: "token-restart-new", allowedUsernames: ["restartuser"] },
    { username: "unchangedbot", token: "token-unchanged", allowedUsernames: ["unchangeduser"] },
    { username: "addedbot", token: "token-added", allowedUsernames: ["addeduser"] }
  ]);
  const normalizedConfig = await loadConfig(configPath);
  const desiredUpdate = bindingById(normalizedConfig, "updatebot");
  const desiredRestart = bindingById(normalizedConfig, "restartbot");
  const desiredUnchanged = bindingById(normalizedConfig, "unchangedbot");
  const desiredAdded = bindingById(normalizedConfig, "addedbot");

  const oldUpdate = structuredClone(desiredUpdate);
  oldUpdate.allowedUsernames = ["olduser"];
  oldUpdate.managerUsernames = ["olduser"];
  const oldRestart = structuredClone(desiredRestart);
  oldRestart.token = "token-restart-old";
  const oldRemoved = structuredClone(desiredUnchanged);
  oldRemoved.bindingId = "removedbot";
  oldRemoved.username = "removedbot";
  oldRemoved.token = "token-removed";
  oldRemoved.allowedUsernames = ["removeduser"];
  oldRemoved.managerUsernames = ["removeduser"];

  const stateStore = new ConversationStateStore({
    rootDir: path.join(tempDir, "state")
  });
  const addedScope = stateStore.scopeFor({
    agentId: "agent",
    platform: "telegram",
    bindingId: "addedbot",
    conversationId: "durable-added"
  });
  await stateStore.saveRecord(
    addedScope,
    makeStateRecord(addedScope, {
      deliveryAnchor: { chatId: 4242, replyTarget: null },
      sessionId: "old-added-session"
    })
  );

  const events = [];
  const updateRuntime = makeResetServiceRuntime(oldUpdate, {
    events,
    label: "old-update",
    stateStore,
    sessions: [makeResetServiceSession("update-live", events, { queue: ["queued"] })]
  });
  const restartRuntime = makeResetServiceRuntime(oldRestart, {
    events,
    label: "old-restart",
    stateStore,
    sessions: [makeResetServiceSession("restart-live", events, { isRunning: true })]
  });
  const removedRuntime = makeResetServiceRuntime(oldRemoved, {
    events,
    label: "old-removed",
    stateStore,
    sessions: [makeResetServiceSession("removed-live", events)]
  });
  const unchangedRuntime = makeResetServiceRuntime(desiredUnchanged, {
    events,
    label: "unchanged",
    stateStore,
    sessions: [makeResetServiceSession("unchanged-live", events)]
  });
  const runtimeRegistry = new RuntimeRegistry([
    updateRuntime,
    restartRuntime,
    removedRuntime,
    unchangedRuntime
  ]);
  const createdRuntimes = [];
  const resetService = new ResetService({
    configPath,
    runtimeRegistry,
    operationLocks: new AgentOperationLocks(),
    stateStore,
    createRuntime: (botConfig) => {
      const runtime = makeResetServiceRuntime(botConfig, {
        events,
        label: `created-${botConfig.bindingId}`,
        stateStore
      });
      createdRuntimes.push(runtime);
      return runtime;
    }
  });

  const result = await resetService.resetAgentProfile("agent");

  assert.equal(result.ok, true);
  assert.deepEqual(result.bindings, {
    added: 1,
    removed: 1,
    restarted: 1,
    updated: 1,
    unchanged: 1,
    failed: 0
  });
  assert.deepEqual(result.conversations, { live: 4, durable: 1 });
  assert.deepEqual(result.runs, { aborted: 1, queuesCleared: 1 });
  assert.deepEqual(result.schedules, { timers: 1 });
  assert.deepEqual(result.failures, []);

  assert.deepEqual(
    createdRuntimes.map((runtime) => runtime.botConfig.bindingId).sort(),
    ["addedbot", "restartbot"]
  );
  assert.ok(
    createdRuntimes.every(
      (runtime) => runtime.startOptions[0]?.restoreScheduledConversations === false
    )
  );
  assert.deepEqual(updateRuntime.botConfig.allowedUsernames, desiredUpdate.allowedUsernames);
  assert.equal(runtimeRegistry.find({ platform: "telegram", bindingId: "removedbot" }), null);
  assert.equal(removedRuntime.stopRequested, true);
  assert.equal(removedRuntime.stopped, true);
  assert.equal(restartRuntime.stopRequested, true);
  assert.equal(restartRuntime.stopped, true);
  assert.notEqual(
    runtimeRegistry.find({ platform: "telegram", bindingId: "restartbot" }),
    restartRuntime
  );
  assert.equal(
    runtimeRegistry.find({ platform: "telegram", bindingId: "addedbot" })?.botConfig.token,
    desiredAdded.token
  );

  const firstRestoreIndex = events.findIndex((event) => event.startsWith("restore:"));
  assert.notEqual(firstRestoreIndex, -1);
  for (const event of events.filter((entry) => entry.startsWith("session-reset:"))) {
    assert.ok(events.indexOf(event) < firstRestoreIndex, `${event} should run before schedule restore`);
  }
  assert.deepEqual(
    events.filter((event) => event.startsWith("restore:")),
    ["restore:old-update", "restore:created-restartbot", "restore:unchanged", "restore:created-addedbot"]
  );
  assert.equal(events.includes("restore:old-restart"), false);
  assert.equal(events.includes("restore:old-removed"), false);

  const addedRecord = await stateStore.loadRecord(addedScope);
  assert.equal(addedRecord.session, null);
  assert.deepEqual(addedRecord.deliveryAnchor, { chatId: 4242, replyTarget: null });
  assert.equal(addedRecord.schedules.length, 1);
});

test("reset service reports deferred stop failures after registry reconciliation", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pievo-reset-stop-failure-"));
  const { configPath } = await writeAgentConfig(tempDir, []);
  const normalizedConfig = await loadConfig(configPath);
  const removedBinding = {
    platform: "telegram",
    bindingId: "failstopbot",
    username: "failstopbot",
    token: "token-failstop",
    allowedUsernames: ["operator"],
    managerUsernames: ["operator"],
    agent: structuredClone(normalizedConfig.agents[0]),
    configPath: path.join(configPath, "config.json")
  };
  const events = [];
  let inLock = false;
  const runtime = makeResetServiceRuntime(removedBinding, {
    events,
    label: "fail-stop",
    stopError: "stop exploded"
  });
  const runtimeRegistry = new RuntimeRegistry([runtime]);
  const resetService = new ResetService({
    configPath,
    runtimeRegistry,
    operationLocks: {
      async runExclusive(agentId, fn) {
        assert.equal(agentId, "agent");
        inLock = true;
        try {
          return await fn();
        } finally {
          inLock = false;
        }
      }
    },
    createRuntime() {
      throw new Error("no runtime should be created");
    },
    stateStore: new ConversationStateStore({ rootDir: path.join(tempDir, "state") })
  });
  const originalStop = runtime.stop;
  runtime.stop = async function stopAfterLock() {
    assert.equal(inLock, false);
    return originalStop.call(this);
  };

  const result = await resetService.resetAgentProfile("agent");

  assert.equal(result.ok, false);
  assert.deepEqual(result.bindings, {
    added: 0,
    removed: 1,
    restarted: 0,
    updated: 0,
    unchanged: 0,
    failed: 1
  });
  assert.deepEqual(result.failures, [
    {
      target: "telegram:failstopbot",
      message: "stop exploded"
    }
  ]);
  assert.equal(runtime.stopRequested, true);
  assert.equal(runtime.stopped, false);
  assert.equal(runtimeRegistry.find({ platform: "telegram", bindingId: "failstopbot" }), null);
  assert.match(result.text, /Reset agent profile with errors agent\./);
  assert.match(result.text, /telegram:failstopbot: stop exploded/);
  assert.deepEqual(events, ["request-stop:fail-stop", "stop:fail-stop"]);
});
