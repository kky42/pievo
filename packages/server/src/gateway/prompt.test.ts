import { expect, test } from "vitest";

import type { Loop } from "../db/schema.js";
import { buildRunTask } from "./prompt.js";

const loop = {
  id: "loop-test",
  prompt: "First line.\n\n  Preserve this spacing.  ",
  statusKeep: "A useful result exists.",
  statusNoChange: "The requested check completed without a change.",
  statusBlock: "Human input is required.",
} as Loop;

test("delivery prompt is exactly user prompt plus the report contract", () => {
  expect(buildRunTask(loop)).toBe(`First line.\n\n  Preserve this spacing.  \n\nStatus definitions:\n- keep: A useful result exists.\n- no-change: The requested check completed without a change.\n- block: Human input is required.\n\nBefore finishing, call exactly once:\npievo report --message "<summary>" --status <keep|no-change|block>`);
});

test("prompt does not inject loop identity or history index", () => {
  const task = buildRunTask(loop);
  expect(task).not.toContain("loop-test");
  expect(task).not.toContain("#99");
});
