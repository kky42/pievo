import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  OUTBOUND_ATTACHMENT_SIZE_LIMIT_BYTES,
  outboundAttachmentLimitText,
  resolveOutboundAttachment
} from "../src/chat_adapter/common/outbound-attachments.js";
import {
  MessageRenderer as TelegramMessageRenderer,
  TELEGRAM_RICH_DRAFTS_ENV,
  TELEGRAM_RICH_MESSAGES_ENV,
  isTelegramRichDraftsEnabled,
  isTelegramRichMessagesEnabled
} from "../src/chat_adapter/telegram/message-renderer.js";
import { MessageRenderer as MattermostMessageRenderer } from "../src/chat_adapter/mattermost/message-renderer.js";
import { FakeBotApi } from "./support/fakes.js";

async function withTempDir(callback) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pievo-outbound-attachment-"));
  try {
    return await callback(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test("resolveOutboundAttachment resolves local files from workdir", async () => {
  await withTempDir(async (tempDir) => {
    const filePath = path.join(tempDir, "report.txt");
    await fs.writeFile(filePath, "report", "utf8");

    const result = await resolveOutboundAttachment(
      { path: "report.txt", kind: "document" },
      { workdir: tempDir }
    );

    assert.equal(result.ok, true);
    assert.deepEqual(result.descriptor, {
      kind: "document",
      rawKind: null,
      path: "report.txt",
      filePath,
      fileName: "report.txt",
      caption: null,
      sizeBytes: 6
    });
  });
});

test("resolveOutboundAttachment normalizes validation failures", async () => {
  await withTempDir(async (tempDir) => {
    const missing = await resolveOutboundAttachment(
      { path: "missing.bin", kind: "photo", rawKind: "image" },
      { workdir: tempDir }
    );
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, "file not found");
    assert.equal(
      missing.errorText,
      "Attachment error: path=missing.bin; kind=image; reason=file not found"
    );

    const dirPath = path.join(tempDir, "folder");
    await fs.mkdir(dirPath);
    const directory = await resolveOutboundAttachment(
      { path: "folder", kind: "document" },
      { workdir: tempDir }
    );
    assert.equal(directory.ok, false);
    assert.equal(directory.reason, "path is not a file");

    const largePath = path.join(tempDir, "large.bin");
    await fs.writeFile(largePath, "", "utf8");
    await fs.truncate(largePath, OUTBOUND_ATTACHMENT_SIZE_LIMIT_BYTES + 1);
    const large = await resolveOutboundAttachment(
      { path: "large.bin", kind: "document" },
      { workdir: tempDir }
    );
    assert.equal(large.ok, false);
    assert.equal(large.reason, `file exceeds the ${outboundAttachmentLimitText()} limit`);
  });
});

test("resolveOutboundAttachment returns entry errors before stat failures", async () => {
  await withTempDir(async (tempDir) => {
    const result = await resolveOutboundAttachment(
      { path: "does-not-exist.txt", kind: "document", error: "unsupported attachment" },
      { workdir: tempDir }
    );

    assert.equal(result.ok, false);
    assert.equal(result.reason, "unsupported attachment");
    assert.equal(
      result.errorText,
      "Attachment error: path=does-not-exist.txt; kind=document; reason=unsupported attachment"
    );
  });
});

test("Telegram renderer sends native attachments through the common resolver", async () => {
  await withTempDir(async (tempDir) => {
    const filePath = path.join(tempDir, "report.txt");
    await fs.writeFile(filePath, "report", "utf8");
    const botApi = new FakeBotApi();
    const renderer = new TelegramMessageRenderer({ botApi, chatId: 42 });

    await renderer.sendNativeAttachment(
      { path: "report.txt", kind: "document" },
      { workdir: tempDir, replyTarget: { messageThreadId: 9 } }
    );

    assert.deepEqual(botApi.attachments, [
      {
        chatId: 42,
        kind: "document",
        filePath,
        fileName: "report.txt",
        messageThreadId: 9
      }
    ]);
  });
});

test("Telegram renderer preserves outbound attachment captions", async () => {
  await withTempDir(async (tempDir) => {
    const filePath = path.join(tempDir, "report.txt");
    await fs.writeFile(filePath, "report", "utf8");
    const botApi = new FakeBotApi();
    const renderer = new TelegramMessageRenderer({ botApi, chatId: 42 });

    await renderer.sendNativeAttachment(
      { path: "report.txt", kind: "document", caption: "See attached" },
      { workdir: tempDir, replyTarget: { messageThreadId: 9 } }
    );

    assert.deepEqual(botApi.attachments, [
      {
        chatId: 42,
        kind: "document",
        filePath,
        fileName: "report.txt",
        caption: "See attached",
        messageThreadId: 9
      }
    ]);
  });
});

test("Mattermost renderer sends native attachments through the common resolver", async () => {
  await withTempDir(async (tempDir) => {
    const filePath = path.join(tempDir, "report.txt");
    await fs.writeFile(filePath, "report", "utf8");
    const botApi = {
      uploads: [],
      posts: [],
      async uploadFile(payload) {
        this.uploads.push(payload);
        return { file_infos: [{ id: "file-1" }] };
      },
      async createPost(payload) {
        this.posts.push(payload);
        return { id: "post-1" };
      }
    };
    const renderer = new MattermostMessageRenderer({ botApi, channelId: "channel-1" });

    await renderer.sendNativeAttachment(
      { path: "report.txt", kind: "document", caption: "See attached" },
      { workdir: tempDir, replyTarget: { rootId: "root-1" } }
    );

    assert.deepEqual(botApi.uploads, [
      {
        channelId: "channel-1",
        filePath,
        fileName: "report.txt"
      }
    ]);
    assert.deepEqual(botApi.posts, [
      {
        channelId: "channel-1",
        message: "See attached",
        rootId: "root-1",
        fileIds: ["file-1"]
      }
    ]);
  });
});

test("Telegram final rendering can avoid reusing an active progress message", async () => {
  const botApi = new FakeBotApi();
  const renderer = new TelegramMessageRenderer({ botApi, chatId: 42 });
  renderer.progressMessageId = 7;
  renderer.lastRenderedProgressText = "🟢 working";

  await renderer.renderFinalMessage("**done**", { reuseProgressMessage: false });

  assert.equal(botApi.edits.length, 0);
  assert.equal(botApi.messages.length, 1);
  assert.equal(renderer.progressMessageId, 7);
  assert.equal(renderer.lastRenderedProgressText, "🟢 working");
});

test("Mattermost final rendering can avoid reusing an active progress post", async () => {
  const botApi = {
    posts: [],
    updates: [],
    async createPost(payload) {
      this.posts.push(payload);
      return { id: `post-${this.posts.length}` };
    },
    async updatePost(payload) {
      this.updates.push(payload);
      return { id: payload.postId };
    }
  };
  const renderer = new MattermostMessageRenderer({ botApi, channelId: "channel-1" });
  renderer.progressMessageId = "progress-1";
  renderer.lastRenderedProgressText = ":hourglass_flowing_sand: **Running:** working";

  await renderer.renderFinalMessage("done", { reuseProgressMessage: false });

  assert.equal(botApi.updates.length, 0);
  assert.deepEqual(botApi.posts, [{ channelId: "channel-1", message: "done", rootId: null }]);
  assert.equal(renderer.progressMessageId, "progress-1");
  assert.equal(renderer.lastRenderedProgressText, ":hourglass_flowing_sand: **Running:** working");
});

test("Telegram rich messages default on while rich drafts require explicit opt-in", () => {
  assert.equal(isTelegramRichMessagesEnabled({}), true);
  assert.equal(isTelegramRichMessagesEnabled({ [TELEGRAM_RICH_MESSAGES_ENV]: "1" }), true);
  assert.equal(isTelegramRichMessagesEnabled({ [TELEGRAM_RICH_MESSAGES_ENV]: "0" }), false);
  assert.equal(isTelegramRichMessagesEnabled({ OTHER_RICH_MESSAGES_ENV: "0" }), true);

  assert.equal(isTelegramRichDraftsEnabled({}), false);
  assert.equal(isTelegramRichDraftsEnabled({ [TELEGRAM_RICH_DRAFTS_ENV]: "1" }), true);
  assert.equal(isTelegramRichDraftsEnabled({ [TELEGRAM_RICH_DRAFTS_ENV]: "0" }), false);
  assert.equal(isTelegramRichDraftsEnabled({ OTHER_RICH_DRAFTS_ENV: "1" }), false);
});
