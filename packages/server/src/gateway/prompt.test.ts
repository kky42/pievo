import { expect, test } from "vitest";

import type { Loop } from "../db/schema.js";
import { ATTENTION_CAP, buildRunTask, parseFinalStatus } from "./prompt.js";

const loop = {
  id: "loop-test",
  name: "Disk watch",
  scheduleMode: "cron",
  cron: "0 8 * * *",
  timezone: "UTC",
  prompt: "First line.\n\n  Preserve this spacing.  ",
} as Loop;

test("delivery keeps the user prompt unchanged between the run header and the contract", () => {
  const task = buildRunTask(loop, { runIndex: 1, now: "2026-10-23T08:00:00.000Z" });
  expect(task).toContain("\n\nFirst line.\n\n  Preserve this spacing.  \n\n---\n");
  expect(task.endsWith("Block pauses the loop.")).toBe(true);
  expect(task).toContain("\nSTATUS: ok|block\n");
});

test("the header gives the run index, the time, and the previous run's outcome and notices", () => {
  const task = buildRunTask(loop, {
    runIndex: 42,
    now: "2026-10-23T08:00:00.000Z",
    previous: {
      runIndex: 41,
      ts: "2026-10-22T08:00:05.000Z",
      phase: "done",
      status: "ok",
      attention: "new release",
      message: "Checked 3 feeds.\nLatest: v2.1",
      error: null,
      notices: ["MEMORY.md: 9001 characters exceeds the 8000-character limit; the previous version was kept"],
    },
  });
  expect(task.startsWith('Pievo run #42 of loop "Disk watch" (cron `0 8 * * *` (UTC)).\nNow: 2026-10-23T08:00:00.000Z.\n')).toBe(true);
  expect(task).toContain("Previous run: #41 at 2026-10-22T08:00:05.000Z, ok, attention: new release.");
  expect(task).toContain("> Checked 3 feeds.\n> Latest: v2.1");
  expect(task).toContain("Notice: MEMORY.md: 9001 characters exceeds");
  expect(buildRunTask(loop, { runIndex: 1, now: "2026-10-23T08:00:00.000Z" })).toContain("Previous run: none, this is the first run.");
  const block = buildRunTask(loop, {
    runIndex: 42,
    now: "2026-10-23T08:00:00.000Z",
    previous: { runIndex: 41, ts: "2026-10-22T08:00:05.000Z", phase: "done", status: "block", attention: "legacy block reason", message: "stopped", error: null, notices: [] },
  });
  expect(block).toContain("Previous run: #41 at 2026-10-22T08:00:05.000Z, block.");
  expect(block).not.toContain("attention: legacy block reason");
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
