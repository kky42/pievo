import fs from "node:fs/promises";
import path from "node:path";

export const OUTBOUND_ATTACHMENT_SIZE_LIMIT_BYTES = 50 * 1024 * 1024;
export const OUTBOUND_ATTACHMENT_SIZE_LIMIT_MB = 50;

export function outboundAttachmentLimitText() {
  return `${OUTBOUND_ATTACHMENT_SIZE_LIMIT_MB} MB`;
}

export function resolveOutboundAttachmentPath(filePath, workdir) {
  const normalizedPath = String(filePath ?? "").trim();
  if (!normalizedPath) {
    return "";
  }

  if (path.isAbsolute(normalizedPath)) {
    return normalizedPath;
  }

  return path.resolve(workdir || process.cwd(), normalizedPath);
}

export function outboundAttachmentKindLabel(entry) {
  return entry?.rawKind || entry?.kind || null;
}

export function formatOutboundAttachmentFailure(error) {
  if (!error || typeof error !== "object") {
    return String(error);
  }

  if (error instanceof Error) {
    if (error.message === "path is not a file") {
      return error.message;
    }

    if ("code" in error) {
      if (error.code === "ENOENT") {
        return "file not found";
      }
      if (error.code === "EACCES" || error.code === "EPERM") {
        return "permission denied";
      }
    }

    return error.message;
  }

  return String(error);
}

export function formatOutboundAttachmentErrorText(entry, reason) {
  const parts = [`Attachment error: path=${entry?.path || "(missing)"}`];
  const kind = outboundAttachmentKindLabel(entry);
  if (kind) {
    parts.push(`kind=${kind}`);
  }
  parts.push(`reason=${reason}`);
  return parts.join("; ");
}

function normalizeOutboundAttachmentDescriptor(entry, filePath, stats = null) {
  return {
    kind: entry?.kind,
    rawKind: entry?.rawKind ?? null,
    path: entry?.path ?? "",
    filePath,
    fileName: entry?.fileName || path.basename(String(filePath ?? "")),
    caption: entry?.caption ?? null,
    sizeBytes: stats?.size ?? null
  };
}

function attachmentFailure(entry, descriptor, reason) {
  return {
    ok: false,
    reason,
    errorText: formatOutboundAttachmentErrorText(entry, reason),
    descriptor
  };
}

export async function resolveOutboundAttachment(entry, options = {}) {
  const filePath = resolveOutboundAttachmentPath(entry?.path, options.workdir);
  let descriptor = normalizeOutboundAttachmentDescriptor(entry, filePath);

  if (entry?.error) {
    return attachmentFailure(entry, descriptor, entry.error);
  }

  let stats;
  try {
    stats = await fs.stat(filePath);
  } catch (error) {
    return attachmentFailure(entry, descriptor, formatOutboundAttachmentFailure(error));
  }

  if (!stats.isFile()) {
    return attachmentFailure(entry, descriptor, "path is not a file");
  }

  if (stats.size > OUTBOUND_ATTACHMENT_SIZE_LIMIT_BYTES) {
    return attachmentFailure(
      entry,
      descriptor,
      `file exceeds the ${outboundAttachmentLimitText()} limit`
    );
  }

  descriptor = normalizeOutboundAttachmentDescriptor(entry, filePath, stats);
  return {
    ok: true,
    descriptor
  };
}
