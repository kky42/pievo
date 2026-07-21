/** Runner tests for provider spawn, telemetry collection, and terminal reports. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { buildAgentSpawn, resolveExecTimeoutMs, runDelivery, type Delivery } from "./runner.js";
import { makeTerminalCollector } from "./telemetry.js";

describe("terminal JSONL collectors", () => {
  test("Claude reads init session, result text/usage, ignores dollar cost, and flushes an unterminated line", () => {
    const c = makeTerminalCollector("claude-code");
    c.feed('{"type":"system","subtype":"init","session_id":"sess-1"}\n');
    c.feed('{"type":"assistant","message":{"content":[{"type":"text","text":"draft"}],"usage":{"input_tokens":10,"output_tokens":2}}}\n');
    c.feed('{"type":"result","is_error":false,"subtype":"success","result":"done","total_cost_usd":99,"usage":{"input_tokens":120,"output_tokens":950,"cache_read_input_tokens":48000,"cache_creation_input_tokens":900}}');
    expect(c.result()).toEqual({
      sessionId: "sess-1",
      finalText: "done",
      usage: { inputTokens: 120, outputTokens: 950, cacheReadTokens: 48000, cacheCreationTokens: 900 },
      isError: false,
      errorType: "success",
    });
    expect(c.result()).not.toHaveProperty("cost");
  });

  test("Claude falls back to assistant final text and usage without a result", () => {
    const c = makeTerminalCollector("claude-code");
    c.feed('{"type":"assistant","message":{"content":[{"type":"text","text":"assistant final"}],"usage":{"input_tokens":3,"output_tokens":4,"cache_read_input_tokens":5}}}\n');
    expect(c.result()).toMatchObject({
      finalText: "assistant final",
      usage: { inputTokens: 3, outputTokens: 4, cacheReadTokens: 5, cacheCreationTokens: 0 },
    });
  });

  test("Claude result modelUsage aggregates models and takes precedence over usage", () => {
    const c = makeTerminalCollector("claude-code");
    c.feed('{"type":"result","is_error":false,"result":"done","modelUsage":{"opus":{"inputTokens":10,"outputTokens":2,"cacheReadInputTokens":4,"cacheCreationInputTokens":1},"haiku":{"inputTokens":3,"outputTokens":5,"cacheReadInputTokens":6,"cacheCreationInputTokens":7}},"usage":{"input_tokens":999,"output_tokens":999}}\n');
    expect(c.result().usage).toEqual({ inputTokens: 13, outputTokens: 7, cacheReadTokens: 10, cacheCreationTokens: 8 });
  });

  test("Codex reads thread, terminal usage/text, and subtracts resumed history from token_count fallback", () => {
    const c = makeTerminalCollector("codex");
    c.feed('{"type":"thread.started","thread_id":"thread-1"}\n');
    c.feed('{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":110,"cached_input_tokens":30,"output_tokens":55},"last_token_usage":{"input_tokens":10,"cached_input_tokens":5,"output_tokens":5}}}}\n');
    c.feed('{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":125,"cached_input_tokens":37,"output_tokens":61},"last_token_usage":{"input_tokens":15,"cached_input_tokens":7,"output_tokens":6}}}}\n');
    c.feed('{"type":"item.completed","item":{"type":"agent_message","text":"codex final"}}\n');
    expect(c.result()).toMatchObject({
      sessionId: "thread-1",
      finalText: "codex final",
      // Raw resumed delta is input=25 including cached=12, so normalized
      // uncached input is 13 rather than double-counting cached tokens.
      usage: { inputTokens: 13, outputTokens: 11, cacheReadTokens: 12, cacheCreationTokens: 0 },
      isError: false,
    });
  });

  test("Codex turn.completed usage is authoritative and splits cached from uncached input", () => {
    const c = makeTerminalCollector("codex");
    c.feed('{"type":"turn.completed","usage":{"input_tokens":7,"cached_input_tokens":2,"output_tokens":9}}\n');
    expect(c.result().usage).toEqual({ inputTokens: 5, outputTokens: 9, cacheReadTokens: 2, cacheCreationTokens: 0 });
  });

  test("Codex generic errors are diagnostic when a later turn completes", () => {
    const c = makeTerminalCollector("codex");
    c.feed('{"type":"error","message":"temporary stream diagnostic"}\n');
    c.feed('{"type":"turn.completed","usage":{"input_tokens":4,"cached_input_tokens":1,"output_tokens":2}}\n');
    expect(c.result()).toMatchObject({ isError: false });
    expect(c.result().errorType).toBeUndefined();
  });

  test("Codex generic error is the fallback when no successful terminal event arrives", () => {
    const c = makeTerminalCollector("codex");
    c.feed('{"type":"error","message":"connection dropped"}\n');
    expect(c.result()).toMatchObject({ isError: true, errorType: "connection dropped" });
  });

  test("Codex final text accepts nested content and structured_content shapes", () => {
    const nested = makeTerminalCollector("codex");
    nested.feed('{"type":"item.completed","item":{"type":"agent_message","content":[{"type":"text","content":"nested "},{"message":{"text":"text"}}]}}\n');
    expect(nested.result().finalText).toBe("nested text");

    const structured = makeTerminalCollector("codex");
    structured.feed('{"type":"item.completed","item":{"type":"agent_message","structured_content":{"answer":42}}}\n');
    expect(structured.result().finalText).toBe('{"answer":42}');
  });
});

describe("buildAgentSpawn", () => {
  afterEach(() => {
    delete process.env.PIEVO_CLAUDE_BIN;
    delete process.env.PIEVO_CODEX_BIN;
  });

  test("claude-code: default bin + the claude arg vector (--verbose, stream-json, sys file)", () => {
    const { bin, args } = buildAgentSpawn({ agent: "claude-code", prompt: "do it", sysFile: "/tmp/sys.md" });
    expect(bin).toBe("claude");
    expect(args).toEqual([
      "-p", "do it",
      "--output-format", "stream-json",
      "--verbose",
      "--permission-mode", "bypassPermissions",
      "--append-system-prompt-file", "/tmp/sys.md",
      "--disallowed-tools", "ScheduleWakeup,CronCreate,CronList,CronDelete",
    ]);
  });

  test("claude-code: PIEVO_CLAUDE_BIN escape hatch + model, with no resume surface", () => {
    process.env.PIEVO_CLAUDE_BIN = "/opt/claude";
    const { bin, args } = buildAgentSpawn({ agent: "claude-code", prompt: "p", model: "opus" });
    expect(bin).toBe("/opt/claude");
    expect(args.slice(0, 2)).toEqual(["-p", "p"]);
    expect(args).not.toContain("--resume");
    expect(args).not.toContain("--append-system-prompt-file");
    expect(args.slice(-2)).toEqual(["--model", "opus"]);
  });

  test("claude-code: passes an explicitly configured reasoning effort verbatim", () => {
    const { args } = buildAgentSpawn({
      agent: "claude-code",
      prompt: "do it",
      reasoningEffort: "custom-high",
    });
    expect(args.slice(-2)).toEqual(["--effort", "custom-high"]);
  });

  test("codex: codex exec arm — not claude flags; unattended + json + skip-git", () => {
    // A sysFile is passed but codex has no Claude sys-prompt-file flag — drop it.
    const { bin, args } = buildAgentSpawn({ agent: "codex", prompt: "do it", sysFile: "/tmp/sys.md" });
    expect(bin).toBe("codex");
    expect(args).toEqual([
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "-c", "shell_environment_policy.inherit=all",
      "do it",
    ]);
    // Never emit Claude-shaped flags on the codex arm.
    expect(args).not.toContain("-p");
    expect(args).not.toContain("--verbose");
    expect(args).not.toContain("--append-system-prompt-file");
    expect(args).not.toContain("stream-json");
    expect(args).not.toContain("--permission-mode");
    expect(args).not.toContain("--disallowed-tools");
  });

  test("codex: passes an explicitly configured reasoning effort verbatim", () => {
    const { args } = buildAgentSpawn({
      agent: "codex",
      prompt: "do it",
      reasoningEffort: "custom-high",
    });
    expect(args).toContain('model_reasoning_effort="custom-high"');
  });

  test("codex: PIEVO_CODEX_BIN escape hatch + model, with no resume subcommand", () => {
    process.env.PIEVO_CODEX_BIN = "/opt/codex";
    const { bin, args } = buildAgentSpawn({
      agent: "codex",
      prompt: "run once",
      model: "o3",
    });
    expect(bin).toBe("/opt/codex");
    expect(args).toEqual([
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "-c", "shell_environment_policy.inherit=all",
      "-m", "o3",
      "run once",
    ]);
    expect(args).not.toContain("resume");
  });
});

// ---- fallback path integration ----

let root: string;
let workdir: string;

/** A fake `claude` that records the `-p` task (argv $2) to cwd/captured-task.txt and
 *  emits one stream-json result line so the runner parses a clean success. */
function writeFakeClaude(): string {
  const p = path.join(root, "fake-claude.sh");
  fs.writeFileSync(
    p,
    [
      "#!/bin/sh",
      // args are: -p <task> --output-format stream-json ...
      'printf "%s" "$2" > captured-task.txt',
      `echo '{"type":"result","is_error":false,"subtype":"success","result":"delivered","session_id":"sess-test"}'`,
      "exit 0",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.chmodSync(p, 0o755);
  return p;
}


beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-runner-"));
  workdir = path.join(root, "work");
  fs.mkdirSync(workdir, { recursive: true });
});
afterEach(() => {
  delete process.env.PIEVO_CLAUDE_BIN;
  delete process.env.PIEVO_CODEX_BIN;
  fs.rmSync(root, { recursive: true, force: true });
});

function delivery(overrides: Partial<Delivery> = {}): Delivery {
  return {
    runId: "run-1",
    runToken: "tok-1",
    role: "exec",
    loop: {
      id: "loop-1",
      name: "cookie-report",
      workdir,
      taskFile: null,
      model: null,
      reasoningEffort: null,
      allowControl: false,
    },
    systemPrompt: "SYS",
    task: "ORIGINAL TASK: produce the daily report",
    ...overrides,
  };
}



describe("resolveExecTimeoutMs", () => {
  test("defaults to 12 hours when PIEVO_EXEC_TIMEOUT_MS is unset", () => {
    expect(resolveExecTimeoutMs(undefined)).toBe(12 * 60 * 60 * 1000);
  });

  test("accepts a positive user override", () => {
    expect(resolveExecTimeoutMs("7200000")).toBe(2 * 60 * 60 * 1000);
  });

  test.each(["", "0", "-1", "not-a-number"])("falls back to 12 hours for %j", (value) => {
    expect(resolveExecTimeoutMs(value)).toBe(12 * 60 * 60 * 1000);
  });
});

/** A fake claude that records EVERY arg it was handed (one per line) to
 *  cwd/argv.txt, then emits a clean success — so a test can assert which flags the
 *  runner did (or did not) pass. */
function writeArgvClaude(): string {
  const p = path.join(root, "argv-claude.sh");
  fs.writeFileSync(
    p,
    [
      "#!/bin/sh",
      'printf "%s\\n" "$@" > argv.txt',
      `echo '{"type":"result","is_error":false,"subtype":"success","result":"delivered","session_id":"sess-args"}'`,
      "exit 0",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.chmodSync(p, 0o755);
  return p;
}







