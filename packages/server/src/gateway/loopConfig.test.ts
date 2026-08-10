import { expect, test } from "vitest";

import { isAbsoluteWorkdir, scheduleFromLoop, validateArtifactPaths, validateLoopCreate, validateLoopEdit, validateSchedule } from "./loopConfig.js";
import type { Loop } from "../db/schema.js";

const base = {
  name: "Daily check",
  schedule: { mode: "cron", cron: "0 6 * * *", timezone: "UTC", overlap: "skip" },
  workdir: "/work/project",
  agent: "claude-code",
  prompt: "Inspect the project exactly as requested.",
  statusDefinitions: {
    keep: "A useful result was produced.",
    noChange: "The check completed and no change was needed.",
    block: "Owner input is required.",
  },
};

test("canonical create requires the complete prompt-runner config", () => {
  const validated = validateLoopCreate(base);
  expect(validated).toMatchObject({
    ok: true,
    value: {
      row: {
        name: "Daily check",
        scheduleMode: "cron",
        cronOverlap: "skip",
        continuousDelayMinutes: 1,
        timezone: "UTC",
        prompt: base.prompt,
        statusKeep: base.statusDefinitions.keep,
        artifacts: [],
      },
    },
  });
  expect(validateLoopCreate({ ...base, prompt: "" })).toMatchObject({ ok: false, detail: "prompt is required" });
  expect(validateLoopCreate({ ...base, statusDefinitions: { keep: "yes", noChange: "no" } })).toMatchObject({ ok: false });
  expect(validateLoopCreate({ ...base, cron: "0 7 * * *" } as any)).toMatchObject({ ok: false });
  expect(validateLoopCreate({ ...base, enabled: "false" } as any)).toMatchObject({ ok: false, detail: "enabled must be boolean" });
  expect(validateLoopCreate({ ...base, artifacts: "report.md" } as any)).toMatchObject({ ok: false });
});

test("canonical create and edit normalize optional loop tags", () => {
  expect(validateLoopCreate({ ...base, tags: [" Project ", "ＤＡＩＬＹ"] })).toMatchObject({
    ok: true,
    value: { config: { tags: ["daily", "project"] }, row: { tags: ["daily", "project"] } },
  });
  expect(validateLoopCreate({ ...base, tags: ["active"] })).toMatchObject({ ok: false });

  const loop = {
    ...base,
    id: "loop-tags",
    tags: ["old"],
    scheduleMode: "cron",
    cron: "0 6 * * *",
    timezone: "UTC",
    cronOverlap: "skip",
    continuousDelayMinutes: 1,
  } as unknown as Loop;
  expect(validateLoopEdit(loop, {})).toEqual({ ok: true, value: {} });
  expect(validateLoopEdit(loop, { tags: [] })).toEqual({ ok: true, value: { tags: [] } });
  expect(validateLoopEdit(loop, { tags: null })).toMatchObject({ ok: false });
  expect(validateLoopEdit(loop, { tags: ["Beta", "alpha"] })).toEqual({ ok: true, value: { tags: ["alpha", "beta"] } });
  expect(validateLoopEdit(loop, { tags: ["a", "b", "c", "d", "e"] })).toMatchObject({ ok: false });
});

test("Pi thinking is conditional and agent switches validate the effective edit state", () => {
  for (const reasoningEffort of ["off", "minimal", "low", "medium", "high", "xhigh", "max", null]) {
    expect(validateLoopCreate({ ...base, agent: "pi", reasoningEffort })).toMatchObject({ ok: true });
  }
  expect(validateLoopCreate({ ...base, agent: "pi", reasoningEffort: "custom-high" })).toMatchObject({ ok: false, detail: expect.stringContaining("for pi") });
  expect(validateLoopCreate({ ...base, agent: "codex", reasoningEffort: "custom-high", model: " unchanged/model " })).toMatchObject({
    ok: true,
    value: { config: { model: "unchanged/model", reasoningEffort: "custom-high" } },
  });

  const loop = {
    ...base,
    id: "loop-pi-switch",
    agent: "codex",
    reasoningEffort: "custom-high",
    scheduleMode: "cron",
    cron: "0 6 * * *",
    timezone: "UTC",
    cronOverlap: "skip",
    continuousDelayMinutes: 1,
  } as unknown as Loop;
  expect(validateLoopEdit(loop, { agent: "pi" })).toMatchObject({ ok: false, detail: expect.stringContaining("for pi") });
  expect(validateLoopEdit(loop, { agent: "pi", reasoningEffort: "high" })).toEqual({ ok: true, value: { agent: "pi", reasoningEffort: "high" } });

  const piLoop = { ...loop, agent: "pi", reasoningEffort: "xhigh" } as Loop;
  expect(validateLoopEdit(piLoop, { reasoningEffort: "turbo" })).toMatchObject({ ok: false });
  expect(validateLoopEdit(piLoop, { agent: "claude-code", reasoningEffort: "turbo" })).toEqual({ ok: true, value: { agent: "claude-code", reasoningEffort: "turbo" } });
});

test("schedule is an exclusive discriminated union", () => {
  expect(validateSchedule({ mode: "cron", cron: "0 6 * * *", timezone: "UTC", overlap: "queue-one", delayMinutes: 5 })).toMatchObject({ ok: false });
  expect(validateSchedule({ mode: "cron", cron: "0 6 * * *", overlap: "queue-one" })).toMatchObject({ ok: false, detail: "schedule.timezone is required" });
  expect(validateSchedule({ mode: "continuous", delayMinutes: 5, cron: "0 6 * * *" })).toMatchObject({ ok: false });
  expect(validateSchedule({ mode: "continuous", delayMinutes: 0 })).toMatchObject({ ok: false });
  expect(validateSchedule({ mode: "continuous", delayMinutes: "5" })).toMatchObject({ ok: false, detail: expect.stringContaining("JSON integer") });
  expect(validateSchedule({ mode: "continuous", delayMinutes: true })).toMatchObject({ ok: false });
  expect(validateSchedule({ mode: "continuous", delayMinutes: 5 })).toEqual({ ok: true, value: { mode: "continuous", delayMinutes: 5 } });
});

test("schedule rows fail closed at every read", () => {
  expect(() => scheduleFromLoop({
    id: "loop-missing-timezone",
    scheduleMode: "cron",
    cron: "0 6 * * *",
    timezone: null,
    cronOverlap: "skip",
  } as Loop)).toThrow("invariant: cron loop loop-missing-timezone has no timezone");
  expect(() => scheduleFromLoop({ id: "loop-unknown", scheduleMode: "legacy" } as unknown as Loop))
    .toThrow("invariant: loop loop-unknown has unknown schedule mode: legacy");
});

test("workdir is absolute in either supported platform syntax", () => {
  expect(isAbsoluteWorkdir("/work/project")).toBe(true);
  expect(isAbsoluteWorkdir("C:\\work\\project")).toBe(true);
  expect(isAbsoluteWorkdir("\\\\server\\share\\project")).toBe(true);
  for (const workdir of ["work/project", "./work", "../work", "~/work"]) {
    expect(isAbsoluteWorkdir(workdir)).toBe(false);
    expect(validateLoopCreate({ ...base, workdir })).toEqual({ ok: false, detail: "workdir must be an absolute path" });
  }
});

test("artifact paths preserve exact literals without glob, count, or path-length caps", () => {
  const long = `${"a".repeat(5000)}.txt`;
  const many = Array.from({ length: 300 }, (_, i) => `reports/${i}.md`);
  const paths = ["reports/latest.md", " report.md ", "reports/*.md", long, ...many];
  expect(validateArtifactPaths(paths)).toEqual({ ok: true, value: paths });
  for (const artifactPath of ["/etc/passwd", "C:\\secrets.txt", "../secret", "a/../../secret", "a/./report", "a//report"]) {
    expect(validateArtifactPaths([artifactPath])).toMatchObject({ ok: false });
  }
});

test("canonical edit rejects unknown top-level fields", () => {
  const loop = {
    ...base,
    id: "loop-1",
    scheduleMode: "cron",
    cron: "0 6 * * *",
    timezone: "UTC",
    cronOverlap: "skip",
    continuousDelayMinutes: 1,
    statusKeep: base.statusDefinitions.keep,
    statusNoChange: base.statusDefinitions.noChange,
    statusBlock: base.statusDefinitions.block,
    artifacts: [],
  } as unknown as Loop;
  expect(validateLoopEdit(loop, { schedule: { mode: "continuous", delayMinutes: 7 } })).toMatchObject({
    ok: true,
    value: { scheduleMode: "continuous", continuousDelayMinutes: 7 },
  });
  expect(validateLoopEdit(loop, { scheduleMode: "continuous" })).toMatchObject({ ok: false });
  expect(validateLoopEdit(loop, { workdir: "relative/project" })).toEqual({ ok: false, detail: "workdir must be an absolute path" });
  expect(validateLoopEdit(loop, { unknown: true })).toMatchObject({ ok: false });
});
