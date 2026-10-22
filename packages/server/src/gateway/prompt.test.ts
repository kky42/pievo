import { expect, test } from "vitest";

import type { Loop } from "../db/schema.js";
import { buildRunTask, parseFinalStatus } from "./prompt.js";

const loop = {
  id: "loop-test",
  prompt: "First line.\n\n  Preserve this spacing.  ",
  statusKeep: "A useful result exists.",
  statusNoChange: "The requested check completed without a change.",
  statusBlock: "Human input is required.",
  artifacts: ["report.html"],
} as Loop;

test("delivery prompt is the unchanged user prompt plus the status, loop-file, and final-line contract", () => {
  expect(buildRunTask(loop)).toBe(`First line.

  Preserve this spacing.${"  "}

Status definitions:
- keep: A useful result exists.
- no-change: The requested check completed without a change.
- block: Human input is required.

Loop files in $PIEVO_LOOP_DIR:
- MEMORY.md: this loop's memory, kept across runs (max 8000 characters). Read it before you start. Before finishing, update it with anything that would help future runs avoid mistakes or work faster. Keep it concise: merge similar notes, delete stale or wrong ones, no run logs.
- report.html: artifact shown on the Pievo dashboard (max 2 MB). Update it only as the task above asks.
A file over its limit is rejected and its previous version kept. Other files in that directory are discarded.

End your final response with a short summary, then exactly one last line:
STATUS: keep|no-change|block`);
});

test("the previous run's file notices are repeated to the next run", () => {
  const task = buildRunTask({ ...loop, artifacts: [] } as Loop, ["MEMORY.md: 9001 characters exceeds the 8000-character limit; the previous version was kept"]);
  expect(task).not.toContain("report.html");
  expect(task).toContain("Notices from the previous run:\n- MEMORY.md: 9001 characters exceeds the 8000-character limit; the previous version was kept\n\nEnd your final response");
});

test("prompt does not inject loop identity or history index", () => {
  const task = buildRunTask(loop);
  expect(task).not.toContain("loop-test");
  expect(task).not.toContain("#99");
});

test("the last exact STATUS line sets status; the rest is the summary", () => {
  expect(parseFinalStatus("Did the work.\n\nSTATUS: keep")).toEqual({ status: "keep", message: "Did the work." });
  expect(parseFinalStatus("STATUS: block mentioned early\nsummary\n**STATUS: No-Change**\n")).toEqual({
    status: "no-change",
    message: "STATUS: block mentioned early\nsummary",
  });
  expect(parseFinalStatus("all good\n`STATUS: block.`")).toEqual({ status: "block", message: "all good" });
  expect(parseFinalStatus("STATUS: keep")).toEqual({ status: "keep", message: "" });
  expect(parseFinalStatus("summary\nSTATUS: keep\n\n")).toEqual({ status: "keep", message: "summary" });
});

test("a final response without a final exact status line has no status", () => {
  for (const text of [
    undefined, null, "", "done", "STATUS: maybe", "status keep",
    "STATUS: keep because it worked", "STATUS: keep\none more note",
  ]) {
    expect(parseFinalStatus(text)).toBeUndefined();
  }
});
