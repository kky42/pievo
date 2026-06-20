import { buildTurnInputMessage } from "../../pi_run/input-message.js";
import { allowedInPrivateForAllowedUser } from "../common/command-router.js";
import { appendReferenceContext } from "../common/reference-context.js";
import { hasSupportedAttachment } from "./attachments.js";
import { replyTargetFromMattermostPost } from "./chat-session.js";
import { parseCommand, routeKnownTextCommand } from "./command-router.js";
import { renderGroupInputPost } from "./group-input.js";
import { postFromWebSocketEvent } from "./mattermost-api.js";

function unauthorizedMessage(user) {
  const username = String(user?.username ?? "").trim();
  if (username) {
    return `You are not authorized to use this bot. Your Mattermost username is @${username}. Add "${username}" to allowedUsernames in this Mattermost binding.`;
  }
  return "You are not authorized to use this bot. Add your Mattermost username to allowedUsernames in this Mattermost binding.";
}

const COMMAND_REJECTION_UNAUTHORIZED = "Only manager users can run Pievo commands.";
const COMMAND_REJECTION_OTHER_BOT = "That command targets another bot.";
const UNKNOWN_COMMAND_MESSAGE = "Unknown command.";

function missingTargetMessage(botUsername) {
  const suffix = botUsername ? `@${botUsername}` : "@this_bot";
  return `Group commands must mention this bot, for example !status ${suffix}.`;
}

function isBotPost(post, botUserId) {
  return String(post?.user_id ?? "") === String(botUserId ?? "");
}

function isDeletedPost(post) {
  return Boolean(post?.delete_at && Number(post.delete_at) > 0);
}

function normalizedPostText(post) {
  return String(post?.message ?? "");
}

function channelLikeConversationId(post) {
  const channelId = String(post?.channel_id ?? "").trim();
  if (!channelId) {
    return null;
  }
  const rootId = String(post?.root_id ?? "").trim();
  return rootId ? `${channelId}:thread:${rootId}` : channelId;
}

function deliveryAnchorFromMattermostPost(post) {
  const channelId = String(post?.channel_id ?? "").trim();
  if (!channelId) {
    return null;
  }
  return {
    channelId,
    replyTarget: replyTargetFromMattermostPost(post)
  };
}

export class MattermostEventRouter {
  constructor(runtime) {
    this.runtime = runtime;
  }

  async loadReferencePost(post) {
    const runtime = this.runtime;
    const rootId = String(post?.root_id ?? "").trim();
    if (!rootId) {
      return null;
    }

    try {
      const referencePost = await runtime.botApi.getPost(rootId);
      return await runtime.enrichPost(referencePost);
    } catch {
      return null;
    }
  }

  async buildPrivateReferenceText(session, post) {
    const referencePost = await this.runtime.loadReferencePost(post);
    if (!referencePost) {
      return "";
    }

    const attachments = await session.stageInputAttachmentsFromPost(referencePost);
    return buildTurnInputMessage({
      promptText: normalizedPostText(referencePost).trim(),
      attachments
    }).trim();
  }

  async buildGroupReferenceText(session, post) {
    const referencePost = await this.runtime.loadReferencePost(post);
    if (!referencePost) {
      return "";
    }

    const attachments = await session.stageInputAttachmentsFromPost(referencePost);
    return renderGroupInputPost(referencePost, attachments);
  }

  async handleEvent(event) {
    const runtime = this.runtime;
    await runtime.waitForAgentOperation();
    if (!runtime.isActive()) {
      return;
    }
    let post = postFromWebSocketEvent(event);
    if (!post || isDeletedPost(post) || isBotPost(post, runtime.botUserId)) {
      return;
    }
    post = await runtime.enrichPost(post);

    const platformChannelId = String(post?.channel_id ?? "").trim();
    if (!platformChannelId) {
      return;
    }

    const channel = await runtime.channelFor(platformChannelId);
    if (!channel) {
      return;
    }
    const isDirect = runtime.isDirectChannel(channel);
    const conversationId = isDirect ? platformChannelId : channelLikeConversationId(post);
    if (!conversationId) {
      return;
    }

    const text = normalizedPostText(post);
    const parsedCommand = parseCommand(text, runtime.botUsername, runtime.botDisplayName);
    if (parsedCommand?.ignored && !isDirect) {
      return;
    }
    const session = runtime.sessionFor(platformChannelId, {
      conversationId,
      deliveryAnchor: deliveryAnchorFromMattermostPost(post)
    });

    if (isDirect && !runtime.isAuthorized({ username: post?.user?.username ?? post?.username })) {
      await session.sendText(unauthorizedMessage(post?.user), {
        replyTarget: replyTargetFromMattermostPost(post)
      });
      return;
    }

    if (parsedCommand?.ignored) {
      if (isDirect) {
        await session.sendText(COMMAND_REJECTION_OTHER_BOT, {
          replyTarget: replyTargetFromMattermostPost(post)
        });
      }
      return;
    }

    if (hasSupportedAttachment(post) && isDirect) {
      const referenceText = await runtime.buildPrivateReferenceText(session, post);
      await session.handleAttachmentPosts([post], { referenceText });
      return;
    }

    const isCommandLike = Boolean(parsedCommand?.commandLike);
    const replyTarget = replyTargetFromMattermostPost(post);
    if (isCommandLike && !isDirect && parsedCommand.target === "none") {
      await session.sendText(missingTargetMessage(runtime.botUsername), { replyTarget });
      return;
    }

    if (isCommandLike) {
      if (
        !runtime.isManager({ username: post?.user?.username ?? post?.username }) &&
        !(isDirect && allowedInPrivateForAllowedUser(parsedCommand.command))
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

    if (isDirect) {
      await session.enqueueMessage(
        appendReferenceContext(text, await runtime.buildPrivateReferenceText(session, post)),
        { replyTarget }
      );
      return;
    }

    await runtime.handleGroupTriggerPost({ session, post });
  }

  async handleGroupTriggerPost({ session, post }) {
    const runtime = this.runtime;
    if (!normalizedPostText(post).trim() && !hasSupportedAttachment(post)) {
      return;
    }
    const attachments = await session.stageInputAttachmentsFromPost(post);
    const renderedMessage = renderGroupInputPost(post, attachments);
    const referenceText = await runtime.buildGroupReferenceText(session, post);

    await session.enqueueTurn({
      mode: "group",
      groupInput: {
        messages: [appendReferenceContext(renderedMessage, referenceText)]
      },
      mergeKey: "group",
      groupIdentity: runtime.groupIdentity(),
      replyTarget: replyTargetFromMattermostPost(post)
    });
  }
}

export function createMattermostEventRouter(runtime) {
  return new MattermostEventRouter(runtime);
}
