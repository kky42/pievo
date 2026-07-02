import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { createPiToolBridge } from "../src/pi_tools/tool-bridge-server.js";

async function callTool(env, tool, params = {}) {
  const response = await fetch(env.PIEVO_TOOL_BRIDGE_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.PIEVO_TOOL_BRIDGE_TOKEN}`
    },
    body: JSON.stringify({ tool, params })
  });
  return {
    status: response.status,
    body: await response.json()
  };
}

function createFakeSession({ workdir = process.cwd() } = {}) {
  return {
    workdir,
    schedules: [],
    sentTexts: [],
    sentAttachments: [],
    removedQueuedScheduleNames: [],
    async sendText(text, options = {}) {
      this.sentTexts.push({ text, options });
    },
    async replaceSchedules(schedules) {
      this.schedules = schedules;
    },
    removeQueuedScheduledTurns(name) {
      this.removedQueuedScheduleNames.push(name);
      return 0;
    },
    output: {
      async sendNativeAttachment(entry, options = {}) {
        this.sentAttachments.push({ entry, options });
      },
      sentAttachments: []
    }
  };
}

test("Pi tool bridge sends visible group replies and rejects private send_reply", async () => {
  const session = createFakeSession();
  const replyTarget = { messageThreadId: 42 };
  const bridge = await createPiToolBridge({
    session,
    isGroupTurn: true,
    replyTarget
  });

  try {
    const result = await callTool(bridge.env, "send_reply", { text: "hello group" });
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.terminate, true);
    assert.deepEqual(session.sentTexts, [
      {
        text: "hello group",
        options: { replyTarget }
      }
    ]);
  } finally {
    bridge.dispose();
  }

  const privateBridge = await createPiToolBridge({
    session,
    isGroupTurn: false
  });
  try {
    const result = await callTool(privateBridge.env, "send_reply", { text: "nope" });
    assert.equal(result.status, 500);
    assert.equal(result.body.ok, false);
    assert.match(result.body.error, /group chats/);
  } finally {
    privateBridge.dispose();
  }
});

test("Pi tool bridge sends attachments through the chat renderer and ignores stale fileName", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pievo-tool-attachment-"));
  const filePath = path.join(tempDir, "report.txt");
  await fs.writeFile(filePath, "report", "utf8");
  const session = createFakeSession({ workdir: tempDir });
  session.output.sentAttachments = [];
  session.output.sendNativeAttachment = async function sendNativeAttachment(entry, options = {}) {
    this.sentAttachments.push({ entry, options });
  };

  const bridge = await createPiToolBridge({
    session,
    isGroupTurn: false,
    replyTarget: { rootId: "thread-root" }
  });

  try {
    const result = await callTool(bridge.env, "send_attachment", {
      path: "report.txt",
      kind: "document",
      fileName: "ignored.txt",
      caption: "Here it is"
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.terminate, true);
    assert.deepEqual(session.output.sentAttachments, [
      {
        entry: {
          path: "report.txt",
          kind: "document",
          caption: "Here it is"
        },
        options: {
          workdir: tempDir,
          replyTarget: { rootId: "thread-root" }
        }
      }
    ]);
  } finally {
    bridge.dispose();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("Pi tool bridge can disable schedule tools for scheduled runs", async () => {
  const session = createFakeSession();
  const bridge = await createPiToolBridge({
    session,
    isGroupTurn: false,
    disableScheduleTools: true
  });

  try {
    assert.equal(bridge.env.PIEVO_DISABLE_SCHEDULE_TOOLS, "1");
    const result = await callTool(bridge.env, "add_schedule", {
      mode: "background",
      name: "loop",
      cron: "*/3 * * * *",
      prompt: "repeat"
    });
    assert.equal(result.status, 500);
    assert.equal(result.body.ok, false);
    assert.match(result.body.error, /disabled for scheduled runs/);
    assert.deepEqual(session.schedules, []);
  } finally {
    bridge.dispose();
  }
});

test("Pi tool bridge manages schedules and resyncs timers", async () => {
  const session = createFakeSession();
  let syncCount = 0;
  const bridge = await createPiToolBridge({
    session,
    isGroupTurn: false,
    onSchedulesChanged: () => {
      syncCount += 1;
    }
  });

  try {
    assert.match(bridge.env.PIEVO_LOCAL_TIMEZONE, /.+/);
    assert.match(bridge.env.PIEVO_LOCAL_UTC_OFFSET, /^[+-]\d{2}:\d{2}$/);

    const added = await callTool(bridge.env, "add_schedule", {
      mode: "heartbeat",
      name: "pulse",
      cron: "*/5 * * * *",
      task: "check the queue"
    });
    assert.equal(added.status, 200);
    assert.match(added.body.text, /Added schedule "pulse"/);
    assert.deepEqual(session.schedules, [
      {
        mode: "heartbeat",
        name: "pulse",
        trigger: "cron",
        cron: "*/5 * * * *",
        prompt: "check the queue",
        enabled: true
      }
    ]);
    assert.equal(syncCount, 1);

    const listed = await callTool(bridge.env, "list_schedule");
    assert.equal(listed.status, 200);
    assert.match(listed.body.text, /heartbeat  pulse/);

    const removed = await callTool(bridge.env, "remove_schedule", { name: "pulse" });
    assert.equal(removed.status, 200);
    assert.match(removed.body.text, /Removed schedule "pulse"/);
    assert.deepEqual(session.schedules, []);
    assert.deepEqual(session.removedQueuedScheduleNames, ["pulse"]);
    assert.equal(syncCount, 2);
  } finally {
    bridge.dispose();
  }
});

test("Pi tool bridge can create schedules that allow overlap", async () => {
  const session = createFakeSession();
  const bridge = await createPiToolBridge({
    session,
    isGroupTurn: false
  });

  try {
    const added = await callTool(bridge.env, "add_schedule", {
      mode: "background",
      name: "overlap",
      cron: "*/5 * * * *",
      task: "poll partitions concurrently",
      skip_if_active: false
    });
    assert.equal(added.status, 200);
    assert.match(added.body.text, /skip_if_active: false/);
    assert.deepEqual(session.schedules, [
      {
        mode: "background",
        name: "overlap",
        trigger: "cron",
        cron: "*/5 * * * *",
        prompt: "poll partitions concurrently",
        enabled: true,
        skipIfActive: false
      }
    ]);
  } finally {
    bridge.dispose();
  }
});

test("Pi tool bridge rejects duplicate schedule names across modes", async () => {
  const session = createFakeSession();
  const bridge = await createPiToolBridge({
    session,
    isGroupTurn: false
  });

  try {
    const heartbeat = await callTool(bridge.env, "add_schedule", {
      mode: "heartbeat",
      name: "pulse",
      cron: "*/5 * * * *",
      task: "check the queue"
    });
    assert.equal(heartbeat.status, 200);

    const background = await callTool(bridge.env, "add_schedule", {
      mode: "background",
      name: "pulse",
      cron: "*/10 * * * *",
      task: "summarize"
    });
    assert.equal(background.status, 500);
    assert.match(background.body.error, /Schedule "pulse" already exists/);
    assert.deepEqual(session.schedules.map((schedule) => schedule.mode), ["heartbeat"]);
  } finally {
    bridge.dispose();
  }
});

test("Pi tool bridge adds one-time schedules with run_at", async () => {
  const session = createFakeSession();
  let syncCount = 0;
  const bridge = await createPiToolBridge({
    session,
    isGroupTurn: false,
    onSchedulesChanged: () => {
      syncCount += 1;
    }
  });

  try {
    const added = await callTool(bridge.env, "add_schedule", {
      mode: "background",
      name: "once_report",
      trigger: "once",
      run_at: "2999-06-22T09:00:00+08:00",
      task: "send the report"
    });
    assert.equal(added.status, 200);
    assert.match(added.body.text, /once: 2999-06-22T09:00:00\+08:00/);
    assert.deepEqual(session.schedules, [
      {
        mode: "background",
        name: "once_report",
        trigger: "once",
        runAt: "2999-06-22T09:00:00+08:00",
        prompt: "send the report",
        enabled: true
      }
    ]);
    assert.equal(syncCount, 1);

    const invalid = await callTool(bridge.env, "add_schedule", {
      mode: "background",
      name: "bad_once",
      trigger: "once",
      run_at: "2026-06-22 09:00:00",
      task: "bad"
    });
    assert.equal(invalid.status, 500);
    assert.match(invalid.body.error, /ISO 8601/);
  } finally {
    bridge.dispose();
  }
});
