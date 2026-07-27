import type { Loop } from "../db/schema.js";

/**
 * Deliver the user's prompt unchanged, followed only by the complete report
 * contract. The run index intentionally remains an internal history fact.
 */
export function buildRunTask(loop: Loop): string {
  return `${loop.prompt}\n\nStatus definitions:\n- keep: ${loop.statusKeep}\n- no-change: ${loop.statusNoChange}\n- block: ${loop.statusBlock}\n\nBefore finishing, call exactly once:\npievo report --message "<summary>" --status <keep|no-change|block>`;
}
