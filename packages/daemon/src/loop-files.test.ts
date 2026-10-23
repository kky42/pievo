import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.hoisted(() => {
  process.env.PIEVO_HOME = `/tmp/pievo-loop-files-test-home-${process.pid}`;
});

import { MEMORY_CHAR_CAP, RUNS_DIR, collectMemory, prepareMemory, pruneRunDirs, removeRunDir, runDir } from "./loop-files.js";

const runId = "run-1";

beforeEach(() => {
  fs.rmSync(process.env.PIEVO_HOME!, { recursive: true, force: true });
});
afterEach(() => {
  fs.rmSync(process.env.PIEVO_HOME!, { recursive: true, force: true });
});

describe("collectMemory", () => {
  test("unchanged and deleted memory keep the previous version; a change is collected", () => {
    const dir = prepareMemory(runId, "- old");
    expect(fs.readFileSync(path.join(dir, "MEMORY.md"), "utf8")).toBe("- old");
    expect(collectMemory(dir, "- old")).toEqual({ notices: [] });
    fs.writeFileSync(path.join(dir, "MEMORY.md"), "");
    expect(collectMemory(dir, "- old")).toEqual({ memory: "", notices: [] });
    fs.rmSync(path.join(dir, "MEMORY.md"));
    expect(collectMemory(dir, "- old")).toEqual({ notices: [] });
  });

  test("over-limit, binary, and non-regular versions become notices instead of being truncated", () => {
    const dir = prepareMemory(runId, "");
    const file = path.join(dir, "MEMORY.md");
    fs.writeFileSync(file, "é".repeat(MEMORY_CHAR_CAP + 1));
    expect(collectMemory(dir, "").notices).toEqual([`MEMORY.md: ${MEMORY_CHAR_CAP + 1} characters exceeds the ${MEMORY_CHAR_CAP}-character limit; the previous version was kept`]);
    fs.writeFileSync(file, "x".repeat(MEMORY_CHAR_CAP * 4 + 1));
    expect(collectMemory(dir, "").notices[0]).toContain("exceeds the 8000-character limit");
    fs.writeFileSync(file, "a\0b");
    expect(collectMemory(dir, "").notices[0]).toContain("binary content");
    fs.rmSync(file);
    fs.mkdirSync(file);
    expect(collectMemory(dir, "").notices[0]).toContain("not a regular file");
  });

  test("a canceled or timed-out run reports a change only as discarded", () => {
    const dir = prepareMemory(runId, "- old");
    fs.writeFileSync(path.join(dir, "MEMORY.md"), "- half written");
    expect(collectMemory(dir, "- old", "the run was canceled")).toEqual({
      notices: ["MEMORY.md: the run was canceled; this run's edit was discarded"],
    });
  });
});

test("runDir rejects unsafe ids and removeRunDir/pruneRunDirs clean run directories", () => {
  expect(() => runDir("../escape")).toThrow();
  prepareMemory(runId, "x");
  prepareMemory("run-2", "y");
  removeRunDir(runId);
  expect(fs.existsSync(path.join(RUNS_DIR, runId))).toBe(false);
  pruneRunDirs();
  expect(fs.readdirSync(RUNS_DIR)).toEqual([]);
});
