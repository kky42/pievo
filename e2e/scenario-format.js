import fs from "node:fs/promises";
import path from "node:path";

import { formatInputAttachments } from "../src/pi_run/input-message.js";
import { formatLocalTimestamp } from "../src/utils.js";

export function sanitizeFileName(value) {
  return String(value ?? "scenario").replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "scenario";
}

export function defaultTimestamp(stepIndex, messageIndex) {
  const date = new Date(Date.UTC(2026, 0, 1, 9, stepIndex, messageIndex));
  return formatLocalTimestamp(Math.floor(date.getTime() / 1000));
}

export function formatScenarioMessage(message, stepIndex, messageIndex) {
  if (typeof message === "string") return message.trim();
  if (message?.raw) return String(message.raw).trim();

  const timestamp = String(message?.at ?? defaultTimestamp(stepIndex, messageIndex)).trim();
  const sender = String(message?.from ?? message?.sender ?? "User").trim() || "User";
  const handle = String(message?.handle ?? message?.username ?? "no handle").trim() || "no handle";
  const handleText = handle.startsWith("@") || handle === "no handle" ? handle : `@${handle}`;
  const text = String(message?.text ?? "").trim();
  return `[${timestamp}] ${sender} (${handleText}):\n${text}`;
}

function appendAttachmentsToMessage(message, attachments) {
  const renderedMessage = String(message ?? "").trimEnd();
  const attachmentBlock = formatInputAttachments(attachments);
  return renderedMessage ? `${renderedMessage}\n\n${attachmentBlock}` : attachmentBlock;
}

export function normalizeStepMessages(step, stepIndex, { attachments = [] } = {}) {
  const rawMessages = Array.isArray(step.messages) ? step.messages : [];
  const messages = rawMessages.map((message, messageIndex) => formatScenarioMessage(message, stepIndex, messageIndex));
  const localAttachments = attachments.filter(Boolean);
  if (localAttachments.length === 0) {
    return messages;
  }

  if (messages.length === 0) {
    return [appendAttachmentsToMessage(formatScenarioMessage({ text: "" }, stepIndex, 0), localAttachments)];
  }

  const lastIndex = messages.length - 1;
  messages[lastIndex] = appendAttachmentsToMessage(messages[lastIndex], localAttachments);
  return messages;
}

export async function writeScenarioFiles(workdir, files = []) {
  for (const file of files) {
    const relativePath = String(file?.path ?? "").trim();
    if (!relativePath) throw new Error("scenario file entry missing path");
    const targetPath = path.resolve(workdir, relativePath);
    if (!targetPath.startsWith(path.resolve(workdir) + path.sep) && targetPath !== path.resolve(workdir)) {
      throw new Error(`scenario file path escapes workdir: ${relativePath}`);
    }
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, String(file?.content ?? ""), "utf8");
  }
}

export function stepAttachments(step, workdir) {
  if (!Array.isArray(step.attachments)) return [];
  return step.attachments.map((attachment) => ({
    kind: String(attachment.kind ?? "document"),
    localPath: path.resolve(workdir, String(attachment.path ?? attachment.localPath ?? ""))
  }));
}
