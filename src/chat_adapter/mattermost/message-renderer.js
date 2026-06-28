import {
  formatOutboundAttachmentErrorText,
  formatOutboundAttachmentFailure,
  resolveOutboundAttachment
} from "../common/outbound-attachments.js";
import { sleep, splitPlainText, toErrorMessage } from "../../utils.js";

const MATTERMOST_RENDER_CHUNK_SIZE = 15000;
const TYPING_INTERVAL_MS = 5000;
const DELIVERY_RETRY_DELAYS_MS = [250, 1000];

function getMattermostPostId(result) {
  const id = String(result?.id ?? "").trim();
  return id || null;
}

function formatProgressText(text) {
  return `:hourglass_flowing_sand: **Running:** ${text}`;
}

function rootIdFromReplyTarget(replyTarget) {
  const rootId = String(replyTarget?.rootId ?? "").trim();
  return rootId || null;
}

function retryableNetworkError(error) {
  const message = toErrorMessage(error);
  if (/fetch failed/i.test(message)) {
    return true;
  }

  const code = error?.code ?? error?.cause?.code;
  return [
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "ENOTFOUND",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_SOCKET"
  ].includes(String(code ?? ""));
}

async function retryDelivery(label, operation, logger) {
  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      const delayMs = DELIVERY_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined || !retryableNetworkError(error)) {
        throw error;
      }

      attempt += 1;
      logger(
        `${label} failed: ${toErrorMessage(error)}; retrying (${attempt}/${DELIVERY_RETRY_DELAYS_MS.length})`
      );
      await sleep(delayMs);
    }
  }
}

export class MessageRenderer {
  constructor({ botApi, channelId, websocket = null, logger = () => {} }) {
    this.botApi = botApi;
    this.channelId = channelId;
    this.websocket = websocket;
    this.logger = logger;
    this.progressMessageId = null;
    this.lastRenderedProgressText = null;
    this.typingTimer = null;
    this.typingReplyTarget = null;
  }

  setWebSocket(websocket) {
    this.websocket = websocket;
  }

  resetTransientState() {
    this.progressMessageId = null;
    this.lastRenderedProgressText = null;
  }

  async clearProgressMessage() {
    const postId = this.progressMessageId;
    this.progressMessageId = null;
    this.lastRenderedProgressText = null;
    if (!postId) {
      return;
    }

    try {
      await this.botApi.deletePost({ postId });
    } catch {
      // Keep attachment delivery moving even if Mattermost refuses to delete the transient status.
    }
  }

  async sendMessageChunk(rawChunk, options = {}) {
    return retryDelivery(
      "post create",
      () => this.botApi.createPost({
        channelId: this.channelId,
        message: rawChunk,
        rootId: rootIdFromReplyTarget(options.replyTarget)
      }),
      this.logger
    );
  }

  async editMessageChunk(postId, rawChunk) {
    return retryDelivery(
      "post update",
      () => this.botApi.updatePost({
        postId,
        message: rawChunk
      }),
      this.logger
    );
  }

  async sendSplitText(rawText, options = {}) {
    let firstPostId = null;
    for (const rawChunk of splitPlainText(rawText, MATTERMOST_RENDER_CHUNK_SIZE)) {
      const result = await this.sendMessageChunk(rawChunk, options);
      firstPostId ??= getMattermostPostId(result);
    }
    return firstPostId;
  }

  async renderProgressText(text, options = {}) {
    const rawText = String(text ?? "").trim();
    if (!rawText) {
      return;
    }

    const displayText = formatProgressText(rawText);
    if (this.lastRenderedProgressText === displayText) {
      return;
    }

    if (this.progressMessageId) {
      try {
        await this.editMessageChunk(this.progressMessageId, displayText);
      } catch (error) {
        this.logger(`progress edit failed: ${toErrorMessage(error)}`);
        this.progressMessageId = await this.sendSplitText(displayText, options);
      }
    } else {
      this.progressMessageId = await this.sendSplitText(displayText, options);
    }

    this.lastRenderedProgressText = displayText;
  }

  async renderTerminalText(rawText, options = {}) {
    if (!rawText) {
      return;
    }

    const rawChunks = splitPlainText(rawText, MATTERMOST_RENDER_CHUNK_SIZE);
    const [firstChunk, ...remainingChunks] = rawChunks;

    if (this.progressMessageId && options.reuseProgressMessage !== false) {
      try {
        if (firstChunk !== this.lastRenderedProgressText) {
          await this.editMessageChunk(this.progressMessageId, firstChunk);
        }
        this.progressMessageId = null;
        this.lastRenderedProgressText = null;
      } catch (error) {
        this.logger(`terminal edit failed: ${toErrorMessage(error)}`);
        this.progressMessageId = null;
        this.lastRenderedProgressText = null;
        await this.sendMessageChunk(firstChunk, options);
      }

      for (const rawChunk of remainingChunks) {
        await this.sendMessageChunk(rawChunk, options);
      }
      return;
    }

    await this.sendSplitText(rawText, options);
  }

  async validateAttachmentEntry(entry, options = {}) {
    const result = await resolveOutboundAttachment(entry, options);
    if (!result.ok) {
      return result;
    }
    return {
      ok: true,
      filePath: result.descriptor.filePath,
      descriptor: result.descriptor
    };
  }

  async uploadAttachmentEntry(entry, options = {}) {
    const validation = await this.validateAttachmentEntry(entry, options);
    if (!validation.ok) {
      return {
        kind: "text",
        text: validation.errorText
      };
    }

    try {
      const result = await this.botApi.uploadFile({
        channelId: this.channelId,
        filePath: validation.descriptor.filePath,
        fileName: validation.descriptor.fileName
      });
      const fileInfos = Array.isArray(result?.file_infos) ? result.file_infos : [];
      const fileId = fileInfos[0]?.id;
      if (!fileId) {
        return {
          kind: "text",
          text: formatOutboundAttachmentErrorText(entry, "Mattermost did not return a file id")
        };
      }
      return { kind: "attachment", fileId, caption: validation.descriptor.caption };
    } catch (error) {
      return {
        kind: "text",
        text: formatOutboundAttachmentErrorText(entry, formatOutboundAttachmentFailure(error))
      };
    }
  }

  async sendNativeAttachment(entry, options = {}) {
    const result = await this.uploadAttachmentEntry(entry, options);
    if (result.kind === "text") {
      throw new Error(result.text);
    }

    await this.botApi.createPost({
      channelId: this.channelId,
      message: String(result.caption ?? ""),
      rootId: rootIdFromReplyTarget(options.replyTarget),
      fileIds: [result.fileId]
    });
  }

  async renderFinalMessage(text, options = {}) {
    await this.renderTerminalText(String(text ?? ""), options);
  }

  async renderGroupFinalMessage(_text, _options = {}) {
    // Group chat output is tool-driven. Use send_reply for visible group output.
  }

  async renderErrorText(text, options = {}) {
    await this.renderTerminalText(String(text ?? "").trim(), options);
  }

  async sendText(text, options = {}) {
    const rawText = String(text ?? "");
    if (!rawText) {
      return;
    }
    await this.sendSplitText(rawText, options);
  }

  startTyping(replyTarget = null) {
    if (this.typingTimer) {
      return;
    }
    this.typingReplyTarget = replyTarget;

    const tick = () => {
      try {
        this.websocket?.sendTyping?.({
          channelId: this.channelId,
          rootId: rootIdFromReplyTarget(this.typingReplyTarget)
        });
      } catch (error) {
        this.logger(`typing indicator failed: ${toErrorMessage(error)}`);
      }
    };

    tick();
    this.typingTimer = setInterval(tick, TYPING_INTERVAL_MS);
  }

  stopTyping() {
    if (this.typingTimer) {
      clearInterval(this.typingTimer);
      this.typingTimer = null;
      this.typingReplyTarget = null;
    }
  }
}
