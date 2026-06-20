import test from "node:test";
import assert from "node:assert/strict";

import { TelegramMessageRouter } from "../src/chat_adapter/telegram/message-router.js";
import { MattermostConnectionLoop } from "../src/chat_adapter/mattermost/connection-loop.js";
import { MattermostEventRouter } from "../src/chat_adapter/mattermost/event-router.js";

function createTelegramMessage(overrides = {}) {
  return {
    message_id: 1,
    date: 1_800_000_000,
    chat: { id: -1001, type: "supergroup" },
    from: { username: "manager", first_name: "Manager" },
    text: "",
    ...overrides
  };
}

test("TelegramMessageRouter rejects unauthorized private messages with the direct-topic delivery anchor", async () => {
  const sentTexts = [];
  const sessionCalls = [];
  const session = {
    async sendText(text, options = {}) {
      sentTexts.push({ text, options });
    }
  };
  const runtime = {
    isAuthorized: () => false,
    sessionFor(chatId, options = {}) {
      sessionCalls.push({ chatId, options });
      return session;
    }
  };
  const router = new TelegramMessageRouter(runtime);

  await router.handlePrivateMessage({
    message_id: 42,
    chat: { id: 1234, type: "private" },
    direct_messages_topic: { topic_id: 7 },
    from: { username: "Intruder" },
    text: "hello"
  });

  assert.equal(sessionCalls.length, 1);
  assert.equal(sessionCalls[0].chatId, 1234);
  assert.equal(sessionCalls[0].options.conversationId, "1234:direct:7");
  assert.deepEqual(sessionCalls[0].options.deliveryAnchor, {
    chatId: 1234,
    replyTarget: { directMessagesTopicId: 7 }
  });
  assert.match(sentTexts[0].text, /@intruder/);
  assert.deepEqual(sentTexts[0].options, { replyTarget: { directMessagesTopicId: 7 } });
});

test("TelegramMessageRouter routes topic media groups into one Pi group turn", async () => {
  const turns = [];
  const sessionCalls = [];
  const stagedMessageIds = [];
  const session = {
    async stageInputAttachmentsFromMessage(message) {
      stagedMessageIds.push(message.message_id);
      return [{ kind: "photo", localPath: `/tmp/photo-${message.message_id}.jpg` }];
    },
    async enqueueTurn(turn) {
      turns.push(turn);
    }
  };

  const albumMessages = [
    createTelegramMessage({
      message_id: 10,
      message_thread_id: 99,
      media_group_id: "album-1",
      photo: [{ file_id: "photo-10", file_size: 10 }]
    }),
    createTelegramMessage({
      message_id: 11,
      message_thread_id: 99,
      media_group_id: "album-1",
      text: undefined,
      caption: "caption from album",
      photo: [{ file_id: "photo-11", file_size: 20 }]
    })
  ];

  const runtime = {
    botUsername: "relaybot",
    botConfig: { username: "relaybot" },
    async waitForAgentOperation() {},
    isActive: () => true,
    isManager: () => true,
    sessionFor(chatId, options = {}) {
      sessionCalls.push({ chatId, options });
      return session;
    },
    mediaGroupBuffer: {
      async queue(_session, message, callback) {
        assert.equal(message.message_id, 10);
        await callback(albumMessages);
      }
    },
    groupIdentity: () => ({ botName: "Relay", botHandle: "@relaybot" }),
    buildGroupReferenceText: async () => "referenced post",
    handleGroupMessage: null,
    handleGroupTriggerMessages: null
  };
  const router = new TelegramMessageRouter(runtime);
  runtime.handleGroupMessage = (message, options) => router.handleGroupMessage(message, options);
  runtime.handleGroupTriggerMessages = (options) => router.handleGroupTriggerMessages(options);

  await router.handleMessage(albumMessages[0]);

  assert.equal(sessionCalls.length, 1);
  assert.equal(sessionCalls[0].chatId, -1001);
  assert.equal(sessionCalls[0].options.conversationId, "-1001:topic:99");
  assert.deepEqual(sessionCalls[0].options.deliveryAnchor, {
    chatId: -1001,
    replyTarget: { messageThreadId: 99 }
  });
  assert.deepEqual(stagedMessageIds, [10, 11]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].mode, "group");
  assert.equal(turns[0].mergeKey, "group");
  assert.deepEqual(turns[0].groupIdentity, { botName: "Relay", botHandle: "@relaybot" });
  assert.deepEqual(turns[0].replyTarget, { messageThreadId: 99 });
  assert.equal(turns[0].groupInput.messages.length, 1);
  assert.match(turns[0].groupInput.messages[0], /caption from album/);
  assert.match(turns[0].groupInput.messages[0], /\/tmp\/photo-10\.jpg/);
  assert.match(turns[0].groupInput.messages[0], /\/tmp\/photo-11\.jpg/);
  assert.match(turns[0].groupInput.messages[0], /Reference context:\nreferenced post/);
});

test("TelegramMessageRouter advances update offset only after successful handling", async () => {
  const handledMessages = [];
  const runtime = {
    offset: 100,
    async handleMessage(message) {
      handledMessages.push(message.message_id);
      if (message.message_id === 1) {
        throw new Error("handler failed");
      }
    }
  };
  const router = new TelegramMessageRouter(runtime);

  await assert.rejects(
    router.handleUpdate({
      update_id: 123,
      message: createTelegramMessage({ message_id: 1 })
    }),
    /handler failed/
  );
  assert.equal(runtime.offset, 100);

  await router.handleUpdate({
    update_id: 124,
    message: createTelegramMessage({ message_id: 2 })
  });
  assert.equal(runtime.offset, 125);
  assert.deepEqual(handledMessages, [1, 2]);
});

test("MattermostEventRouter preserves group command target rejection and thread sessions", async () => {
  const sentTexts = [];
  const sessionCalls = [];
  const session = {
    async sendText(text, options = {}) {
      sentTexts.push({ text, options });
    }
  };
  const runtime = {
    botUserId: "bot-user",
    botUsername: "relaybot",
    botDisplayName: "Relay Bot",
    async waitForAgentOperation() {},
    isActive: () => true,
    async enrichPost(post) {
      return { ...post, user: { username: "member", first_name: "Member" } };
    },
    async channelFor(channelId) {
      return { id: channelId, type: "O" };
    },
    isDirectChannel: () => false,
    sessionFor(channelId, options = {}) {
      sessionCalls.push({ channelId, options });
      return session;
    }
  };
  const router = new MattermostEventRouter(runtime);

  await router.handleEvent({
    event: "posted",
    data: {
      post: JSON.stringify({
        id: "post-1",
        channel_id: "channel-1",
        root_id: "root-1",
        user_id: "member-user",
        message: "!status"
      })
    }
  });

  assert.equal(sessionCalls.length, 1);
  assert.equal(sessionCalls[0].channelId, "channel-1");
  assert.equal(sessionCalls[0].options.conversationId, "channel-1:thread:root-1");
  assert.deepEqual(sessionCalls[0].options.deliveryAnchor, {
    channelId: "channel-1",
    replyTarget: { rootId: "root-1" }
  });
  assert.equal(sentTexts.length, 1);
  assert.match(sentTexts[0].text, /Group commands must mention this bot/);
  assert.deepEqual(sentTexts[0].options, { replyTarget: { rootId: "root-1" } });
});

test("MattermostEventRouter builds group turns with attachments and reference context", async () => {
  const turns = [];
  const stagedPostIds = [];
  const session = {
    async stageInputAttachmentsFromPost(post) {
      stagedPostIds.push(post.id);
      return [{ kind: "document", localPath: "/tmp/report.txt" }];
    },
    async enqueueTurn(turn) {
      turns.push(turn);
    }
  };
  const runtime = {
    buildGroupReferenceText: async () => "thread root text",
    groupIdentity: () => ({ botName: "Relay", botHandle: "@relaybot" })
  };
  const router = new MattermostEventRouter(runtime);

  await router.handleGroupTriggerPost({
    session,
    post: {
      id: "post-2",
      channel_id: "channel-1",
      root_id: "root-1",
      create_at: 1_800_000_000_000,
      user: { username: "member", first_name: "Member" },
      message: "please inspect this file",
      file_ids: ["file-1"],
      metadata: {
        files: [{ id: "file-1", name: "report.txt", mime_type: "text/plain", size: 12 }]
      }
    }
  });

  assert.deepEqual(stagedPostIds, ["post-2"]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].mode, "group");
  assert.deepEqual(turns[0].groupIdentity, { botName: "Relay", botHandle: "@relaybot" });
  assert.deepEqual(turns[0].replyTarget, { rootId: "root-1" });
  assert.match(turns[0].groupInput.messages[0], /please inspect this file/);
  assert.match(turns[0].groupInput.messages[0], /\/tmp\/report\.txt/);
  assert.match(turns[0].groupInput.messages[0], /Reference context:\nthread root text/);
});

test("MattermostConnectionLoop connect installs websocket callbacks and wakes on close", async () => {
  const logs = [];
  const handledEvents = [];
  let oldClosed = false;
  let capturedOptions = null;
  let wakeCount = 0;
  const session = {
    sockets: [],
    setWebSocket(socket) {
      this.sockets.push(socket);
    }
  };
  const websocket = {
    socket: { readyState: 1 },
    openedAt: 1234,
    lastActivityAt: 1234,
    lastMessageAt: 1234,
    closeCount: 0,
    close() {
      this.closeCount += 1;
    }
  };
  const runtime = {
    websocket: {
      socket: { readyState: 3 },
      close() {
        oldClosed = true;
      }
    },
    pendingWebSocket: null,
    stopRequested: false,
    reconnectCount: 0,
    sessions: new Map([["session-1", session]]),
    wakeConnectionLoop: () => {
      wakeCount += 1;
    },
    log: (message) => logs.push(message),
    async handleEvent(event) {
      handledEvents.push(event);
    },
    botApi: {
      async connectWebSocket(options) {
        capturedOptions = options;
        const pending = { closeCount: 0, close() { this.closeCount += 1; } };
        options.onClient(pending);
        assert.equal(runtime.pendingWebSocket, pending);
        options.onOpen(websocket);
        return websocket;
      }
    }
  };
  const loop = new MattermostConnectionLoop(runtime);

  const connected = await loop.connect();
  assert.equal(oldClosed, true);
  assert.equal(connected, websocket);
  assert.equal(runtime.websocket, websocket);
  assert.equal(runtime.pendingWebSocket, null);
  assert.equal(runtime.reconnectCount, 1);
  assert.deepEqual(session.sockets, [websocket]);
  assert.equal(runtime.lastWsOpenAt, 1234);
  assert.equal(runtime.lastWsActivityAt, 1234);
  assert.match(logs.join("\n"), /websocket reconnect success: count=1/);

  await capturedOptions.onEvent({ event: "posted", data: { post: { id: "post-1" } } });
  await capturedOptions.onEvent({ event: "hello", data: {} });
  assert.deepEqual(handledEvents, [{ event: "posted", data: { post: { id: "post-1" } } }]);

  capturedOptions.onClose({ code: 1006, reason: "lost" }, websocket);
  assert.equal(runtime.websocket, null);
  assert.equal(wakeCount, 1);
});

test("MattermostConnectionLoop closes stale open websockets", () => {
  const logs = [];
  const websocket = {
    socket: { readyState: 1 },
    lastActivityAt: 1000,
    closeCount: 0,
    close() {
      this.closeCount += 1;
    }
  };
  let loop = null;
  const runtime = {
    websocket,
    staleWebSocketMs: 500,
    lastWsActivityAt: 1000,
    lastWsMessageAt: 1000,
    lastWsOpenAt: 1000,
    log: (message) => logs.push(message),
    isWebSocketStale(now) {
      return loop.isWebSocketStale(now);
    }
  };
  loop = new MattermostConnectionLoop(runtime);

  assert.equal(loop.isWebSocketStale(1499), false);
  assert.equal(loop.isWebSocketStale(1501), true);
  assert.equal(loop.closeStaleWebSocket(1501), true);
  assert.equal(runtime.websocket, null);
  assert.equal(websocket.closeCount, 1);
  assert.match(logs[0], /websocket stale: last_activity_at=1000 stale_ms=501/);
});
