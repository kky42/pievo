/**
 * The assembled run prompts must keep every run-essential directive after the
 * evolve guidance was unified into the single source skill/references/evolve.md
 * (run-dispatch and the installable skill now read the SAME file). These assertions
 * lock the run behavior for each role — losing a lever here is a regression, not a
 * doc tweak. The exec run's instructions live in the first USER turn (`buildExecTask`
 * ← exec-core.md, fills name/taskFile/goalLine/stateLine) with an empty system
 * prompt (run-experience redesign, Batch 1). Batch 2 extends the same move to
 * EVOLVE and EDIT: their system prompts are now empty too, the standing prose ships
 * in the first user turn (`buildEvolveTask`/`buildEditTask`), and the evolve payload
 * inlines a COMPACT one-line-per-run survey (state keys not values, clipped message)
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
    stateSchema: null,
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

