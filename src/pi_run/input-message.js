import { renderPrompt } from "../prompts/index.js";

/**
 * @typedef {object} Turn
 * @property {string} promptText
 * @property {any[]} attachments
 */

export function formatInputAttachment(attachment) {
  const localPath = String(attachment?.localPath ?? attachment?.path ?? "unavailable").trim() || "unavailable";
  const kind = String(attachment?.kind ?? "document").trim() || "document";
  return renderPrompt("templates/attachment-input-item.md", {
    path: localPath,
    kind
  });
}

export function formatInputAttachments(attachments) {
  const localAttachments = attachments.filter(Boolean);
  if (localAttachments.length === 0) {
    return "";
  }

  return renderPrompt("templates/attachment-input.md", {
    label: localAttachments.length === 1 ? "Attached file" : "Attached files",
    items: localAttachments.map(formatInputAttachment).join("\n")
  });
}

function buildAttachmentPrompt(promptText, attachments) {
  const normalizedPrompt = String(promptText ?? "").trim();
  const localAttachments = attachments.filter(Boolean);

  if (localAttachments.length === 0) {
    return normalizedPrompt;
  }

  const attachmentBlock = formatInputAttachments(localAttachments);
  return normalizedPrompt ? `${normalizedPrompt}\n\n${attachmentBlock}` : attachmentBlock;
}

/**
 * @param {Turn} turn
 */
export function buildTurnInputMessage(turn) {
  return buildAttachmentPrompt(turn?.promptText ?? "", turn?.attachments ?? []);
}
