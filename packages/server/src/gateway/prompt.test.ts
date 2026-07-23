/**
 * The assembled run prompts must keep every run-essential directive after the
 * evolve guidance was unified into the single source skill/references/evolve.md
 * (run-dispatch and the installable skill now read the SAME file). These assertions
 * lock the run behavior for each role — losing a lever here is a regression, not a
 * doc tweak. The exec run's instructions live in the first USER turn (`buildExecTask`
 * ← exec-core.md, fills name/taskFile/goalLine/metricLine) with an empty system
 * prompt (run-experience redesign, Batch 1). Batch 2 extends the same move to
 * EVOLVE and STEER: their system prompts are now empty too and the standing prose
 * ships in the first user turn (`buildEvolveTask`/`buildSteerTask`). History stays
 * behind the bounded `pievo log` protocol rather than being inlined into delivery.
 */
import { expect, test } from "vitest";

import {
  buildSteerPrompt,
  buildSteerTask,
  buildEvolvePrompt,
  buildEvolveTask,
  buildExecTask,
  buildLoopSystemPrompt,
  cookbookPathForTaskFile,
} from "./prompt.js";
import type { Loop } from "../db/schema.js";

const loop = (over: Partial<Loop> = {}): Loop =>
  ({
    id: "loop-test",
    name: "Test Loop",
    cron: "0 8 * * *",
    timezone: "America/New_York",
    workdir: "/work",
    taskFile: "/work/pievo/test/README.md",
    metricSchema: null,
    allowControl: false,
    ui: null,
    ...over,
  }) as unknown as Loop;

// Batch 2: the evolve/steer system prompts are empty — the standing prose moved into
// the first user turn (like exec, Batch 1). The daemon's `--append-system-prompt-file`
// becomes a harmless no-op on every existing daemon (ships server-first).
test("evolve + steer system prompts are empty (prose moved to the user turn)", () => {
  expect(buildEvolvePrompt()).toBe("");
  expect(buildSteerPrompt()).toBe("");
});

test("cookbook path is derived beside Unix and Windows task files", () => {
  expect(cookbookPathForTaskFile("/work/pievo/test/README.md")).toBe("/work/pievo/test/COOKBOOK.md");
  expect(cookbookPathForTaskFile("C:\\work\\pievo\\test\\README.md")).toBe("C:\\work\\pievo\\test\\COOKBOOK.md");
  expect(cookbookPathForTaskFile("README.md")).toBe("COOKBOOK.md");
});

test("exec payload carries identity and uses Spec then bounded Cookbook evidence", () => {
  const task = buildExecTask(loop({
    goal: "runtime under 20 seconds",
    metricSchema: [{ key: "runtime", label: "Runtime", unit: "s" }],
  }), 12);
  expect(task).toContain("[loop exec #12 · Test Loop]");
  expect(task).toContain("Objective: runtime under 20 seconds");
  expect(task).toContain("Execution workspace (cwd):** /work");
  expect(task).toContain("/work/pievo/test/COOKBOOK.md");
  expect(task).toContain("loop content home");
  expect(task).toContain("not a live file listing");
  expect(task).toContain("README.md");
  expect(task.indexOf("README.md")).toBeLessThan(task.indexOf("COOKBOOK.md"));
  expect(task).toContain("pievo log --summary --after");
  expect(task).toContain("count < total");
  expect(task).toContain("finalTextAvailable");
  expect(task).toContain("requestText");
  expect(task).toContain('--message "<concise result or no-go reason>"');
  expect(task).toContain('--metrics \'{"runtime":<number|null>}\'');
  expect(task).toContain("Normally do not append to `## Timeline`");
  expect(task).toContain("legacy task-file sections");
  expect(task).not.toContain("pievo finish");
});

test("evolve payload progressively reviews bounded history without inlining run detail", () => {
  const buildWithLegacyHistoryArg = buildEvolveTask as unknown as (
    loop: Loop,
    runIndex: number,
    legacyHistory: Array<{ message: string; sessionId: string }>,
  ) => string;
  const task = buildWithLegacyHistoryArg(loop({ goal: "runtime under 20 seconds" }), 13, [
    { message: "recent-message-secret", sessionId: "session-secret-123" },
  ]);
  expect(task).toContain("[loop evolve #13 · Test Loop]");
  expect(task).toContain("Objective: runtime under 20 seconds");
  expect(task).toContain("Execution workspace (cwd): /work");
  expect(task).toContain("Loop content home: the directory containing the Task file above");
  expect(task).toContain("/work/pievo/test/COOKBOOK.md");
  expect(task).toContain("pievo log --summary --after");
  expect(task).toContain("pievo log --after");
  expect(task).toContain("pievo log --run");
  expect(task).toContain("--diff");
  expect(task).toContain("summary.through");
  expect(task).toContain("count < total");
  expect(task).toContain("finalTextAvailable");
  expect(task).toContain("requestText");
  expect(task).toContain("Use the loop content home for current artifact evidence");
  expect(task).toContain("a diff does not replace inspecting the current live files");
  expect(task).toContain('<loop-embed file="latest.md"></loop-embed>');
  expect(task).toContain("exactly one Timeline boundary");
  expect(task).toContain("never pass `--metrics`");
  expect(task).not.toContain("session-secret-123");
  expect(task).not.toContain("recent-message-secret");
});

test("steer payload carries owner authority and records an unproven boundary without advancing cursor", () => {
  const task = buildSteerTask(loop({ goal: "runtime under 20 seconds" }), "rename the loop", 14);
  expect(task).toContain("[loop steer #14 · Test Loop]");
  expect(task).toContain("Objective: runtime under 20 seconds");
  expect(task).toContain("Execution workspace (cwd): /work");
  expect(task).toContain("Loop content home: the directory containing the Task file above");
  expect(task).toContain("/work/pievo/test/COOKBOOK.md");
  expect(task).toContain("pievo show --json");
  expect(task).toContain("owner's instruction");
  expect(task).toContain("validation pending");
  expect(task).toContain('<loop-chart series="score:Score"></loop-chart>');
  expect(task).toContain('<loop-embed file="latest.md"></loop-embed>');
  expect(task).toContain("does not advance `Consolidated through`");
  expect(task).toContain("never pass `--metrics`");
  expect(task).toContain("Existing loops may have `## Current understanding`");
  expect(task).not.toContain("keeping its `## Spec` / `## Current understanding`");
});
