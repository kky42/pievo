import { expect, test } from "vitest";

import type { Loop } from "../db/schema.js";
import { ATTENTION_CAP, buildRunTask, parseFinalStatus } from "./prompt.js";

const loop = {
  id: "loop-test",
  prompt: "First line.\n\n  Preserve this spacing.  ",
  statusKeep: "A useful result exists.",
  statusNoChange: "The requested check completed without a change.",
  statusBlock: "Human input is required.",
  artifacts: ["report.html"],
} as Loop;

test("delivery prompt starts with the unchanged user prompt and ends with the status line contract", () => {
  const task = buildRunTask(loop);
  expect(task.startsWith(`First line.\n\n  Preserve this spacing.  \n\nStatus definitions:\n- keep: A useful result exists.\n`)).toBe(true);
  expect(task).toContain("- report.html: artifact shown on the Pievo dashboard (max 256 KB).");
  expect(task.endsWith("\nSTATUS: keep|no-change|block")).toBe(true);
});

test("the previous run's file notices are repeated to the next run", () => {
  const task = buildRunTask({ ...loop, artifacts: [] } as Loop, ["MEMORY.md: 9001 characters exceeds the 8000-character limit; the previous version was kept"]);
  expect(task).not.toContain("report.html");
  expect(task).toContain("Notices from the previous run:\n- MEMORY.md: 9001 characters exceeds the 8000-character limit; the previous version was kept\n\n");
});

test("prompt does not inject loop identity or history index", () => {
  const task = buildRunTask(loop);
  expect(task).not.toContain("loop-test");
  expect(task).not.toContain("#99");
});

test("the last exact STATUS line sets status; the rest is the summary", () => {
  expect(parseFinalStatus("Did the work.\n\nSTATUS: keep")).toEqual({ status: "keep", message: "Did the work.", attention: null });
  expect(parseFinalStatus("STATUS: block mentioned early\nsummary\n**STATUS: No-Change**\n")).toEqual({
    status: "no-change",
    message: "STATUS: block mentioned early\nsummary",
    attention: null,
  });
  expect(parseFinalStatus("all good\n`STATUS: block.`")).toEqual({ status: "block", message: "all good", attention: null });
  expect(parseFinalStatus("STATUS: keep")).toEqual({ status: "keep", message: "", attention: null });
  expect(parseFinalStatus("summary\nSTATUS: keep\n\n")).toEqual({ status: "keep", message: "summary", attention: null });
});

test("an ATTENTION line directly above the status line is independent of the status", () => {
  expect(parseFinalStatus("Disk at 83%.\nATTENTION: macmini disk above 80%\nSTATUS: keep")).toEqual({
    status: "keep",
    message: "Disk at 83%.",
    attention: "macmini disk above 80%",
  });
  expect(parseFinalStatus("x\n\n**ATTENTION: port 8888 open**\n\nSTATUS: block")).toMatchObject({ status: "block", message: "x", attention: "port 8888 open" });
  expect(parseFinalStatus("x\nATTENTION: none\nSTATUS: keep")).toEqual({ status: "keep", message: "x", attention: null });
  expect(parseFinalStatus("ATTENTION: early\nsummary\nSTATUS: keep")).toEqual({ status: "keep", message: "ATTENTION: early\nsummary", attention: null });
  expect(parseFinalStatus(`ATTENTION: ${"a".repeat(500)}\nSTATUS: keep`)!.attention).toHaveLength(ATTENTION_CAP);
  expect(parseFinalStatus("x\nATTENTION: disk 85%\nATTENTION: port 8888 open\nSTATUS: keep")).toEqual({
    status: "keep",
    message: "x",
    attention: "disk 85%; port 8888 open",
  });
});

test("a final response without a final exact status line has no status", () => {
  for (const text of [
    undefined, null, "", "done", "STATUS: maybe", "status keep",
    "STATUS: keep because it worked", "STATUS: keep\none more note",
  ]) {
    expect(parseFinalStatus(text)).toBeUndefined();
  }
});
