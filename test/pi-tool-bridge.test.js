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

test("Pi tool bridge sends attachments through the chat renderer", async () => {
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
      fileName: "visible.txt",
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
          fileName: "visible.txt",
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
    const added = await callTool(bridge.env, "add_schedule", {
      mode: "heartbeat",
      name: "pulse",
      cron: "*/5 * * * *",
      prompt: "check the queue"
    });
    assert.equal(added.status, 200);
    assert.match(added.body.text, /Added schedule "pulse"/);
    assert.deepEqual(session.schedules, [
      {
        mode: "heartbeat",
        name: "pulse",
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
