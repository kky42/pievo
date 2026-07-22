/**
 * The assembled run prompts must keep every run-essential directive after the
 * evolve guidance was unified into the single source skill/references/evolve.md
 * (run-dispatch and the installable skill now read the SAME file). These assertions
 * lock the run behavior for each role — losing a lever here is a regression, not a
 * doc tweak. The exec run's instructions live in the first USER turn (`buildExecTask`
 * ← exec-core.md, fills name/taskFile/goalLine/metricLine) with an empty system
 * prompt (run-experience redesign, Batch 1). Batch 2 extends the same move to
 * EVOLVE and EDIT: their system prompts are now empty too, the standing prose ships
 * in the first user turn (`buildEvolveTask`/`buildEditTask`), and the evolve payload
 * inlines a COMPACT one-line-per-run survey (metric keys not values, clipped message)
 * instead of full pretty-printed JSON. These assertions lock that.
 */
import { expect, test } from "vitest";

import {
  buildEditPrompt,
  buildEditTask,
  buildEvolvePrompt,
  buildEvolveTask,
  buildExecTask,
  buildLoopSystemPrompt,
} from "./prompt.js";
import type { Loop, Run } from "../db/schema.js";

const loop = (over: Partial<Loop> = {}): Loop =>
  ({
    id: "loop-test",
    name: "Test Loop",
    cron: "0 8 * * *",
    timezone: "America/New_York",
    taskFile: "/work/pievo/test/README.md",
    metricSchema: null,
    allowControl: false,
    ui: null,
    ...over,
  }) as unknown as Loop;

// Batch 2: the evolve/edit system prompts are empty — the standing prose moved into
// the first user turn (like exec, Batch 1). The daemon's `--append-system-prompt-file`
// becomes a harmless no-op on every existing daemon (ships server-first).
test("evolve + edit system prompts are empty (prose moved to the user turn)", () => {
  expect(buildEvolvePrompt()).toBe("");
  expect(buildEditPrompt()).toBe("");
});

test("exec prompt requires message and exact metrics while keeping goal non-terminal", () => {
  const task = buildExecTask(loop({
    goal: "runtime under 20 seconds",
    metricSchema: [{ key: "runtime", label: "Runtime", unit: "s" }],
  }));
  expect(task).toContain("Objective: runtime under 20 seconds");
  expect(task).toContain('--message "<concise result or no-go reason>"');
  expect(task).toContain('--metrics \'{"runtime":<number|null>}\'');
  expect(task).toContain("Negative values are valid observations");
  expect(task).not.toContain("pievo finish");
  expect(task).not.toContain("--state");
});

test("edit and evolve prompts require messages and forbid metrics", () => {
  const edit = buildEditTask(loop(), "rename the loop");
  const evolve = buildEvolveTask(loop(), [] as Run[]);
  for (const task of [edit, evolve]) {
    expect(task).toContain("--message");
    for (const line of task.split("\n").filter((line) => line.includes("pievo report"))) {
      expect(line).toContain("--status");
      expect(line).toContain("--message");
    }
    expect(task).toContain("never pass `--metrics`");
    expect(task).not.toContain("pievo finish");
  }
});
