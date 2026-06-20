import { buildTurnInputMessage } from "../../pi_run/input-message.js";
import { normalizeTelegramUsername } from "../../utils.js";
import { allowedInPrivateForAllowedUser } from "../common/command-router.js";
import { appendReferenceContext } from "../common/reference-context.js";
import { hasSupportedAttachment, unsupportedAttachmentMessage } from "./attachments.js";
import { replyTargetFromTelegramMessage } from "./chat-session.js";
import { parseCommand, routeKnownTextCommand } from "./command-router.js";
import { renderGroupInputMessage } from "./group-input.js";
import { telegramMessageText } from "./rich-message.js";

function unauthorizedMessage(user) {
  const username = normalizeTelegramUsername(user?.username);
  if (username) {
    return `You are not authorized to use this bot. Your Telegram username is @${username}. Add "${username}" to allowedUsernames in this Telegram binding.`;
  }

  return "You are not authorized to use this bot. Your Telegram account has no username set. Add one in Telegram Settings, then add it to allowedUsernames in this Telegram binding.";
}

const COMMAND_REJECTION_UNAUTHORIZED = "Only manager users can run Pievo commands.";
const COMMAND_REJECTION_OTHER_BOT = "That command targets another bot.";
const UNKNOWN_COMMAND_MESSAGE = "Unknown command.";

function missingTargetMessage(botUsername) {
  const suffix = botUsername ? `@${botUsername}` : "@this_bot";
  return `Group commands must mention this bot, for example /status ${suffix}.`;
}

const IGNORED_SERVICE_MESSAGE_FIELDS = [
  "forum_topic_created",
  "forum_topic_closed",
  "forum_topic_reopened",
  "forum_topic_edited",
  "general_forum_topic_hidden",
  "general_forum_topic_unhidden"
];

function isIgnoredServiceMessage(message) {
  return IGNORED_SERVICE_MESSAGE_FIELDS.some((field) => message?.[field]);
}

function messageText(message) {
  return telegramMessageText(message);
}

// Telegram auto-sends a `/start` message when a user first opens a private chat
// with the bot (clicks the "Start" button). It is a Telegram-only convention and
// is not one of our commands, so ignore it silently instead of replying "Unknown command.".
function isTelegramStartCommand(message) {
  return messageText(message).trim().toLowerCase() === "/start";
}

function privateConversationId(message) {
  const chatId = message?.chat?.id;
  const directTopicId = message?.direct_messages_topic?.topic_id;
  if (chatId !== null && chatId !== undefined && directTopicId !== null && directTopicId !== undefined) {
    return `${chatId}:direct:${directTopicId}`;
  }
  return chatId;
}

function groupLikeConversationId(message) {
  const chatType = message?.chat?.type;
  if (chatType === "group" || chatType === "supergroup") {
    const topicId = message?.message_thread_id;
    return topicId === null || topicId === undefined
      ? String(message.chat.id)
      : `${message.chat.id}:topic:${topicId}`;
  }

  if (chatType === "private") {
    const title = typeof message?.chat?.title === "string" ? message.chat.title.trim() : "";
    if (title) {
      const topicId =
        message?.direct_messages_topic?.topic_id ??
        message?.message_thread_id;
      return topicId === null || topicId === undefined
        ? String(message.chat.id)
        : `${message.chat.id}:topic:${topicId}`;
    }
  }

  return null;
}

function deliveryAnchorFromTelegramMessage(message) {
  const chatId = message?.chat?.id;
  if (chatId === null || chatId === undefined) {
    return null;
  }
  return {
    chatId,
    replyTarget: replyTargetFromTelegramMessage(message)
  };
}

export class TelegramMessageRouter {
  constructor(runtime) {
    this.runtime = runtime;
  }

  async buildPrivateReferenceText(session, message) {
    const referenceMessage = message?.reply_to_message;
    if (!referenceMessage || typeof referenceMessage !== "object") {
      return "";
    }

    const attachments = await session.stageInputAttachmentsFromMessage(referenceMessage);
    return buildTurnInputMessage({
      promptText: messageText(referenceMessage).trim(),
      attachments
    }).trim();
  }

  async buildGroupReferenceText(session, message) {
    const referenceMessage = message?.reply_to_message;
    if (!referenceMessage || typeof referenceMessage !== "object") {
      return "";
    }

    const attachments = await session.stageInputAttachmentsFromMessage(referenceMessage);
    return renderGroupInputMessage(referenceMessage, attachments);
  }

  async handleMessage(message) {
    const runtime = this.runtime;
    await runtime.waitForAgentOperation();
    if (!runtime.isActive()) {
      return;
    }
    const chatId = message.chat?.id;
    if (!chatId) {
      return;
    }

    if (message.chat?.type === "private") {
      await runtime.handlePrivateMessage(message);
      return;
    }

    const groupConversationId = groupLikeConversationId(message);
    if (groupConversationId !== null) {
      await runtime.handleGroupMessage(message, { conversationId: groupConversationId });
      return;
    }
  }

  async handlePrivateMessage(message) {
    const runtime = this.runtime;
    const chatId = message.chat?.id;
    const replyTarget = replyTargetFromTelegramMessage(message);

    if (!runtime.isAuthorized(message.from)) {
      const session = runtime.sessionFor(chatId, {
        conversationId: privateConversationId(message),
        deliveryAnchor: deliveryAnchorFromTelegramMessage(message)
      });
      await session.sendText(unauthorizedMessage(message.from), { replyTarget });
      return;
    }

    if (isIgnoredServiceMessage(message)) {
      return;
    }

    if (isTelegramStartCommand(message)) {
      return;
    }

    const groupConversationId = groupLikeConversationId(message);
    if (groupConversationId !== null) {
      await runtime.handleGroupMessage(message, { conversationId: groupConversationId });
      return;
    }

    const session = runtime.sessionFor(chatId, {
      conversationId: privateConversationId(message),
      deliveryAnchor: deliveryAnchorFromTelegramMessage(message)
    });
    const text = messageText(message);
    if (text.trim()) {
      const parsedCommand = parseCommand(text, runtime.botUsername);
      if (parsedCommand?.ignored) {
        await session.sendText(COMMAND_REJECTION_OTHER_BOT, { replyTarget });
        return;
      }
      if (parsedCommand?.commandLike) {
        if (
          !runtime.isManager(message.from) &&
          !allowedInPrivateForAllowedUser(parsedCommand.command)
        ) {
          await session.sendText(COMMAND_REJECTION_UNAUTHORIZED, { replyTarget });
          return;
        }
        const routed = await routeKnownTextCommand({
          parsedCommand,
          session,
          runtime,
          replyTarget
        });
        if (!routed) {
          await session.sendText(UNKNOWN_COMMAND_MESSAGE, { replyTarget });
        }
        return;
      }
    }

    const supportedAttachment = hasSupportedAttachment(message);
    if (supportedAttachment) {
      await runtime.mediaGroupBuffer.queue(session, message, async (messages) => {
        const primaryMessage = messages.find((candidate) => messageText(candidate).trim()) ?? messages[0];
        const referenceText = await runtime.buildPrivateReferenceText(session, primaryMessage);
        await session.handleAttachmentMessages(messages, { referenceText });
      });
      return;
    }

    if (text.trim()) {
      await session.enqueueMessage(
        appendReferenceContext(text, await runtime.buildPrivateReferenceText(session, message)),
        { replyTarget }
      );
      return;
    }

    await session.sendText(unsupportedAttachmentMessage(), { replyTarget });
  }

  async handleGroupMessage(message, { conversationId = message.chat?.id } = {}) {
    const runtime = this.runtime;
    const chatId = message.chat?.id;
    if (isIgnoredServiceMessage(message)) {
      return;
    }

    const text = messageText(message);
    const parsedCommand = parseCommand(text, runtime.botUsername ?? runtime.botConfig.username);
    if (parsedCommand?.ignored) {
      return;
    }
    const isCommandLike = Boolean(parsedCommand?.commandLike);
    const replyTarget = replyTargetFromTelegramMessage(message);
    if (isCommandLike && parsedCommand.target === "none") {
      const session = runtime.sessionFor(chatId, {
        conversationId,
        deliveryAnchor: deliveryAnchorFromTelegramMessage(message)
      });
      await session.sendText(missingTargetMessage(runtime.botUsername ?? runtime.botConfig.username), {
        replyTarget
      });
      return;
    }

    const supportedAttachment = hasSupportedAttachment(message);
    if (!text.trim() && !supportedAttachment) {
      return;
    }

    const session = runtime.sessionFor(chatId, {
      conversationId,
      deliveryAnchor: deliveryAnchorFromTelegramMessage(message)
    });
    if (isCommandLike) {
      if (!runtime.isManager(message.from)) {
        await session.sendText(COMMAND_REJECTION_UNAUTHORIZED, { replyTarget });
        return;
      }
      const routed = await routeKnownTextCommand({
        parsedCommand,
        session,
        runtime,
        replyTarget
      });
      if (!routed) {
        await session.sendText(UNKNOWN_COMMAND_MESSAGE, { replyTarget });
      }
      return;
    }

    if (supportedAttachment) {
      await runtime.mediaGroupBuffer.queue(session, message, (messages) =>
        runtime.handleGroupTriggerMessages({ session, messages, triggerMessage: message })
      );
      return;
    }

    await runtime.handleGroupTriggerMessages({
      session,
      triggerMessage: message,
      messages: [message]
    });
  }

  async handleGroupTriggerMessages({ session, messages, triggerMessage = null }) {
    const runtime = this.runtime;
    if (!Array.isArray(messages) || messages.length === 0) {
      return;
    }

    const primaryMessage = messages.find((message) => messageText(message).trim()) ?? triggerMessage ?? messages[0];
    const renderedMessages = [];

    const mediaGroupId = messages[0]?.media_group_id;
    const isSingleMediaGroup =
      messages.length > 1 &&
      mediaGroupId &&
      messages.every((message) => message?.media_group_id === mediaGroupId);

    if (isSingleMediaGroup) {
      const attachments = [];
      for (const message of messages) {
        attachments.push(...await session.stageInputAttachmentsFromMessage(message));
      }
      renderedMessages.push(renderGroupInputMessage(primaryMessage, attachments));
    } else {
      for (const message of messages) {
        const attachments = await session.stageInputAttachmentsFromMessage(message);
        renderedMessages.push(renderGroupInputMessage(message, attachments));
      }
    }

    const referenceText = await runtime.buildGroupReferenceText(session, primaryMessage);
    if (referenceText && renderedMessages.length > 0) {
      renderedMessages[renderedMessages.length - 1] = appendReferenceContext(
        renderedMessages[renderedMessages.length - 1],
        referenceText
      );
    }

    await session.enqueueTurn({
      mode: "group",
      groupInput: {
        messages: renderedMessages
      },
      mergeKey: "group",
      groupIdentity: runtime.groupIdentity(),
      replyTarget: replyTargetFromTelegramMessage(primaryMessage)
    });
  }

  async handleUpdate(update) {
    const runtime = this.runtime;
    const nextOffset = typeof update.update_id === "number" ? update.update_id + 1 : undefined;
    if (update.message) {
      await runtime.handleMessage(update.message);
    }
    if (nextOffset !== undefined) {
      runtime.offset = nextOffset;
    }
  }
}

export function createTelegramMessageRouter(runtime) {
  return new TelegramMessageRouter(runtime);
}
