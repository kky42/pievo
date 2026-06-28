import {
  formatOutboundAttachmentErrorText,
  formatOutboundAttachmentFailure,
  resolveOutboundAttachment
} from "../common/outbound-attachments.js";
import { splitPlainText, toErrorMessage } from "../../utils.js";
import { renderMarkdownToTelegramHtml } from "./markdown-renderer.js";
import { escapeTelegramMarkdown } from "./render.js";
import { TelegramApiError } from "./telegram-api.js";

const TELEGRAM_RENDER_CHUNK_SIZE = 3500;
const TELEGRAM_RICH_RENDER_CHUNK_SIZE = 32000;
const TELEGRAM_MAX_DRAFT_ID = 2_147_483_647;
export const TELEGRAM_RICH_MESSAGES_ENV = "PIEVO_TELEGRAM_RICH_MESSAGES";
export const TELEGRAM_RICH_DRAFTS_ENV = "PIEVO_TELEGRAM_RICH_DRAFTS";

export function isTelegramRichMessagesEnabled(env = process.env) {
  return env[TELEGRAM_RICH_MESSAGES_ENV] !== "0";
}

export function isTelegramRichDraftsEnabled(env = process.env) {
  return env[TELEGRAM_RICH_DRAFTS_ENV] === "1";
}

function escapeHtmlText(text) {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function isParseError(error) {
  return (
    error instanceof TelegramApiError &&
    error.errorCode === 400 &&
    /parse entities/i.test(error.message)
  );
}

function isUnsupportedRichMessageError(error) {
  return (
    error instanceof TelegramApiError &&
    (error.errorCode === 404 || /not found|unsupported|unknown method/i.test(error.message))
  );
}

function isRecoverableRichMessageError(error) {
  return error instanceof TelegramApiError && (error.errorCode === 400 || isUnsupportedRichMessageError(error));
}

function getTelegramMessageId(result) {
  const rawMessageId = result?.message_id ?? result?.messageId;
  const messageId = Number(rawMessageId);
  return Number.isFinite(messageId) ? messageId : null;
}

function formatProgressText(text) {
  return `🟢 ${text}`;
}

function richMarkdownCandidate(rawText) {
  const text = String(rawText ?? "");
  if (!text.trim() || text.length > TELEGRAM_RICH_RENDER_CHUNK_SIZE) {
    return null;
  }
  return text;
}

function buildRenderAttempts(rawChunk) {
  return [
    { text: rawChunk, parseMode: "HTML" },
    { text: escapeTelegramMarkdown(rawChunk), parseMode: "MarkdownV2" },
    { text: rawChunk, parseMode: null }
  ];
}

function outboundMessageTarget(replyTarget) {
  if (!replyTarget) {
    return {};
  }
  const target = {};
  if (replyTarget.directMessagesTopicId !== null && replyTarget.directMessagesTopicId !== undefined) {
    target.directMessagesTopicId = replyTarget.directMessagesTopicId;
    return target;
  }
  if (replyTarget.messageThreadId !== null && replyTarget.messageThreadId !== undefined) {
    target.messageThreadId = replyTarget.messageThreadId;
  }
  return target;
}

function isDirectMessagesTopicTarget(replyTarget) {
  return replyTarget?.directMessagesTopicId !== null && replyTarget?.directMessagesTopicId !== undefined;
}

export class MessageRenderer {
  constructor({ botApi, chatId, logger = () => {} }) {
    this.botApi = botApi;
    this.chatId = chatId;
    this.logger = logger;
    this.progressMessageId = null;
    this.lastRenderedProgressText = null;
    this.progressRenderedAsDraft = false;
    this.typingTimer = null;
    this.richMessagesUnavailable = false;
    this.richDraftsUnavailable = false;
    this.richDraftId = null;
  }

  resetTransientState() {
    this.markProgressSuperseded();
  }

  markProgressSuperseded() {
    this.progressMessageId = null;
    this.lastRenderedProgressText = null;
    this.progressRenderedAsDraft = false;
    this.richDraftId = null;
  }

  async clearProgressMessage() {
    const messageId = this.progressMessageId;
    this.markProgressSuperseded();

    if (!messageId) {
      return;
    }

    try {
      await this.botApi.deleteMessage({
        chatId: this.chatId,
        messageId
      });
    } catch {
      // Keep attachment delivery moving even if Telegram refuses to delete the transient status.
    }
  }

  async refreshProgressDraft(options = {}) {
    const displayText = this.lastRenderedProgressText;
    if (!this.progressRenderedAsDraft || !displayText) {
      return;
    }

    const refreshed = await this.tryRenderProgressDraft(displayText, options);
    if (refreshed) {
      return;
    }

    if (
      !this.progressRenderedAsDraft ||
      this.lastRenderedProgressText !== displayText ||
      this.progressMessageId
    ) {
      return;
    }

    this.progressRenderedAsDraft = false;
    this.progressMessageId = await this.sendSplitText(displayText, options);
  }

  async renderWithFallback(renderAttempt) {
    let previousParseError = null;

    for (const attempt of buildRenderAttempts(renderAttempt.rawChunk)) {
      try {
        return await renderAttempt.send(attempt);
      } catch (error) {
        if (!isParseError(error) || attempt.parseMode === null) {
          throw error;
        }
        previousParseError = error;
      }
    }

    throw previousParseError ?? new Error("Telegram render fallback exhausted unexpectedly.");
  }

  async trySendRichMarkdown(rawText, options = {}) {
    if (
      !isTelegramRichMessagesEnabled() ||
      this.richMessagesUnavailable ||
      typeof this.botApi.sendRichMessage !== "function"
    ) {
      return null;
    }

    const markdown = richMarkdownCandidate(rawText);
    if (markdown === null) {
      return null;
    }

    try {
      return await this.botApi.sendRichMessage({
        chatId: this.chatId,
        richMessage: { markdown },
        ...outboundMessageTarget(options.replyTarget)
      });
    } catch (error) {
      if (!isRecoverableRichMessageError(error)) {
        throw error;
      }
      if (isUnsupportedRichMessageError(error)) {
        this.richMessagesUnavailable = true;
      } else {
        this.logger(`rich message fallback: ${toErrorMessage(error)}`);
      }
      return null;
    }
  }

  async sendRichText(markdown, options = {}) {
    const rawMarkdown = String(markdown ?? "");
    if (!rawMarkdown) {
      return;
    }

    const result = await this.trySendRichMarkdown(rawMarkdown, options);
    if (result) {
      return result;
    }

    return this.sendText(options.fallbackText ?? rawMarkdown, {
      ...options,
      allowRich: false
    });
  }

  nextRichDraftId() {
    if (!this.richDraftId) {
      this.richDraftId = Math.floor(Date.now() % TELEGRAM_MAX_DRAFT_ID) || 1;
    }
    return this.richDraftId;
  }

  draftMessageThreadId(replyTarget) {
    if (replyTarget?.messageThreadId !== null && replyTarget?.messageThreadId !== undefined) {
      return replyTarget.messageThreadId;
    }
    return null;
  }

  canSendRichDraft() {
    return (
      isTelegramRichDraftsEnabled() &&
      !this.richDraftsUnavailable &&
      Number(this.chatId) > 0 &&
      typeof this.botApi.sendRichMessageDraft === "function"
    );
  }

  async tryRenderProgressDraft(displayText, options = {}) {
    if (!this.canSendRichDraft() || isDirectMessagesTopicTarget(options.replyTarget)) {
      return false;
    }

    try {
      await this.botApi.sendRichMessageDraft({
        chatId: this.chatId,
        draftId: this.nextRichDraftId(),
        richMessage: {
          html: `<tg-thinking>${escapeHtmlText(displayText)}</tg-thinking>`
        },
        messageThreadId: this.draftMessageThreadId(options.replyTarget)
      });
      return true;
    } catch (error) {
      if (!isRecoverableRichMessageError(error)) {
        throw error;
      }
      this.richDraftsUnavailable = true;
      if (!isUnsupportedRichMessageError(error)) {
        this.logger(`rich draft fallback: ${toErrorMessage(error)}`);
      }
      return false;
    }
  }

  async sendMessageChunk(rawChunk, options = {}) {
    const renderChunk = options.renderMarkdown
      ? renderMarkdownToTelegramHtml(rawChunk)
      : rawChunk;
    return this.renderWithFallback({
      rawChunk: renderChunk,
      send: ({ text, parseMode }) =>
        this.botApi.sendMessage({
          chatId: this.chatId,
          text,
          parseMode,
          ...outboundMessageTarget(options.replyTarget)
        })
    });
  }

  async editMessageChunk(messageId, rawChunk, options = {}) {
    const renderChunk = options.renderMarkdown
      ? renderMarkdownToTelegramHtml(rawChunk)
      : rawChunk;
    return this.renderWithFallback({
      rawChunk: renderChunk,
      send: ({ text, parseMode }) =>
        this.botApi.editMessageText({
          chatId: this.chatId,
          messageId,
          text,
          parseMode
        })
    });
  }

  async sendSplitText(rawText, options = {}) {
    let firstMessageId = null;

    for (const rawChunk of splitPlainText(rawText, TELEGRAM_RENDER_CHUNK_SIZE)) {
      const result = await this.sendMessageChunk(rawChunk, options);
      firstMessageId ??= getTelegramMessageId(result);
    }

    return firstMessageId;
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

    if (await this.tryRenderProgressDraft(displayText, options)) {
      this.lastRenderedProgressText = displayText;
      this.progressRenderedAsDraft = true;
      return;
    }

    if (this.progressMessageId) {
      try {
        await this.editMessageChunk(this.progressMessageId, displayText);
      } catch (error) {
        this.logger(`progress edit failed; sending a replacement: ${toErrorMessage(error)}`);
        this.progressMessageId = await this.sendSplitText(displayText, options);
      }
    } else {
      this.progressMessageId = await this.sendSplitText(displayText, options);
    }

    this.lastRenderedProgressText = displayText;
    this.progressRenderedAsDraft = false;
  }

  async tryRenderRichTerminalText(rawText, options = {}) {
    if (!options.richMarkdown) {
      return false;
    }

    const result = await this.trySendRichMarkdown(rawText, options);
    if (!result) {
      return false;
    }

    if (options.reuseProgressMessage === false) {
      return true;
    }

    if (this.progressMessageId) {
      await this.clearProgressMessage();
    } else {
      this.markProgressSuperseded();
    }
    return true;
  }

  async renderTerminalText(rawText, options = {}) {
    if (!rawText) {
      return;
    }

    if (await this.tryRenderRichTerminalText(rawText, options)) {
      return;
    }

    const rawChunks = splitPlainText(rawText, TELEGRAM_RENDER_CHUNK_SIZE);
    const [firstChunk, ...remainingChunks] = rawChunks;

    if (this.progressMessageId && options.reuseProgressMessage !== false) {
      if (firstChunk !== this.lastRenderedProgressText) {
        try {
          await this.editMessageChunk(this.progressMessageId, firstChunk, options);
        } catch (error) {
          this.logger(`final edit failed; sending a replacement: ${toErrorMessage(error)}`);
          await this.sendMessageChunk(firstChunk, options);
        }
      }
      this.markProgressSuperseded();

      for (const rawChunk of remainingChunks) {
        await this.sendMessageChunk(rawChunk, options);
      }
      return;
    }

    await this.sendSplitText(rawText, options);
    if (options.reuseProgressMessage !== false) {
      this.markProgressSuperseded();
    }
  }

  async sendAttachment(attachment, options = {}) {
    return this.botApi.sendLocalAttachment({
      chatId: this.chatId,
      kind: attachment.kind,
      filePath: attachment.filePath,
      fileName: attachment.fileName,
      caption: attachment.caption,
      ...outboundMessageTarget(options.replyTarget)
    });
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

  async deliverAttachmentEntry(entry, options = {}) {
    const validation = await this.validateAttachmentEntry(entry, options);
    if (!validation.ok) {
      return {
        kind: "text",
        text: validation.errorText
      };
    }

    try {
      await this.sendAttachment(validation.descriptor, options);
    } catch (error) {
      return {
        kind: "text",
        text: formatOutboundAttachmentErrorText(entry, formatOutboundAttachmentFailure(error))
      };
    }

    return { kind: "attachment" };
  }

  async sendNativeAttachment(entry, options = {}) {
    const validation = await this.validateAttachmentEntry(entry, options);
    if (!validation.ok) {
      throw new Error(validation.errorText);
    }

    try {
      await this.sendAttachment(validation.descriptor, options);
    } catch (error) {
      throw new Error(formatOutboundAttachmentErrorText(entry, formatOutboundAttachmentFailure(error)));
    }
  }

  async renderFinalMessage(text, options = {}) {
    await this.renderTerminalText(String(text ?? ""), {
      ...options,
      richMarkdown: true,
      renderMarkdown: true
    });
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

    if (options.allowRich !== false) {
      const result = await this.trySendRichMarkdown(rawText, options);
      if (result) {
        return result;
      }
    }

    return this.sendSplitText(rawText, options);
  }

  startTyping(replyTarget = null) {
    if (this.typingTimer) {
      return;
    }

    const tick = async () => {
      if (!isDirectMessagesTopicTarget(replyTarget)) {
        try {
          await this.botApi.sendChatAction({
            chatId: this.chatId,
            action: "typing",
            ...outboundMessageTarget(replyTarget)
          });
        } catch (error) {
          this.logger(`typing indicator failed: ${toErrorMessage(error)}`);
        }
      }

      try {
        await this.refreshProgressDraft({ replyTarget });
      } catch (error) {
        this.logger(`progress draft refresh failed: ${toErrorMessage(error)}`);
      }
    };

    void tick();
    this.typingTimer = setInterval(() => {
      void tick();
    }, 4000);
  }

  stopTyping() {
    if (this.typingTimer) {
      clearInterval(this.typingTimer);
      this.typingTimer = null;
    }
  }
}
