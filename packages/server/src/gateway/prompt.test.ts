import { expect, test } from "vitest";

import type { Loop } from "../db/schema.js";
import { ATTENTION_CAP, buildRunTask, parseFinalStatus } from "./prompt.js";

const loop = {
  id: "loop-test",
  prompt: "First line.\n\n  Preserve this spacing.  ",
  artifacts: ["report.html"],
} as Loop;

test("delivery prompt starts with the unchanged user prompt and ends with the status line contract", () => {
  const task = buildRunTask(loop);
  expect(task.startsWith(`First line.\n\n  Preserve this spacing.  \n\nLoop files in `)).toBe(true);
  expect(task).toContain("- report.html: artifact shown on the Pievo dashboard (max 256 KB).");
  expect(task).toContain("\nSTATUS: ok|block\n");
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
  expect(parseFinalStatus("Did the work.\n\nSTATUS: ok")).toEqual({ status: "ok", message: "Did the work.", attention: null });
  expect(parseFinalStatus("STATUS: block mentioned early\nsummary\n**STATUS: OK**\n")).toEqual({
    status: "ok",
    message: "STATUS: block mentioned early\nsummary",
    attention: null,
  });
  expect(parseFinalStatus("all good\n`STATUS: block.`")).toEqual({ status: "block", message: "all good", attention: null });
  expect(parseFinalStatus("STATUS: ok")).toEqual({ status: "ok", message: "", attention: null });
  expect(parseFinalStatus("summary\nSTATUS: ok\n\n")).toEqual({ status: "ok", message: "summary", attention: null });
});

test("an ATTENTION line directly above the status line is independent of the status", () => {
  expect(parseFinalStatus("Disk at 83%.\nATTENTION: macmini disk above 80%\nSTATUS: ok")).toEqual({
    status: "ok",
    message: "Disk at 83%.",
    attention: "macmini disk above 80%",
  });
  expect(parseFinalStatus("x\n\n**ATTENTION: port 8888 open**\n\nSTATUS: block")).toMatchObject({ status: "block", message: "x", attention: "port 8888 open" });
  expect(parseFinalStatus("x\nATTENTION: none\nSTATUS: ok")).toEqual({ status: "ok", message: "x", attention: null });
  expect(parseFinalStatus("ATTENTION: early\nsummary\nSTATUS: ok")).toEqual({ status: "ok", message: "ATTENTION: early\nsummary", attention: null });
  expect(parseFinalStatus(`ATTENTION: ${"a".repeat(500)}\nSTATUS: ok`)!.attention).toHaveLength(ATTENTION_CAP);
  expect(parseFinalStatus("x\nATTENTION: disk 85%\nATTENTION: port 8888 open\nSTATUS: ok")).toEqual({
    status: "ok",
    message: "x",
    attention: "disk 85%; port 8888 open",
  });
});

test("a final response without a final exact status line has no status", () => {
  for (const text of [
    undefined, null, "", "done", "STATUS: maybe", "status ok", "STATUS: keep", "STATUS: no-change",
    "STATUS: ok because it worked", "STATUS: ok\none more note",
  ]) {
    expect(parseFinalStatus(text)).toBeUndefined();
  }
});
