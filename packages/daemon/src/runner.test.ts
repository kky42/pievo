/** Runner tests for provider spawn, telemetry collection, and terminal reports. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { buildAgentSpawn, executeDelivery, resolveExecTimeoutMs, type Delivery } from "./runner.js";
import { makeTerminalCollector } from "./telemetry.js";

describe("terminal JSONL collectors", () => {
  test("unknown agents fail closed instead of using a provider parser", () => {
    expect(() => makeTerminalCollector("unknown" as any)).toThrow("unsupported coding agent: unknown");
  });

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

  test("Pi aggregates assistant and successful compaction usage and keeps the latest assistant text", () => {
    const c = makeTerminalCollector("pi");
    c.feed('{"type":"session","version":3,"id":"pi-session","cwd":"/work"}\n');
    c.feed('{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"draft"}],"usage":{"input":10,"output":2,"cacheRead":3,"cacheWrite":4},"stopReason":"toolUse"}}\n');
    c.feed('{"type":"compaction_end","aborted":false,"result":{"usage":{"input":5,"output":6,"cacheRead":7,"cacheWrite":8}}}\n');
    c.feed('{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hidden"},{"type":"text","text":"final answer"}],"usage":{"input":20,"output":9,"cacheRead":11,"cacheWrite":13},"stopReason":"stop"}}\n');
    expect(c.result()).toEqual({
      sessionId: "pi-session",
      finalText: "final answer",
      usage: { inputTokens: 35, outputTokens: 17, cacheReadTokens: 21, cacheCreationTokens: 25 },
      isError: false,
      errorType: undefined,
    });
  });

  test.each(["error", "aborted"])("Pi treats final assistant stopReason %s as failure independently of process exit", (stopReason) => {
    const c = makeTerminalCollector("pi");
    c.feed(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "failed" }], usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, stopReason, errorMessage: "provider failed" } }) + "\n");
    expect(c.result()).toMatchObject({ isError: true, errorType: "provider failed", finalText: "failed" });
  });

  test("Pi includes standard toolResult usage without inspecting tool details", () => {
    const c = makeTerminalCollector("pi");
    c.feed('{"type":"message_end","message":{"role":"assistant","content":[],"usage":{"input":1,"output":2,"cacheRead":3,"cacheWrite":4},"stopReason":"toolUse"}}\n');
    c.feed('{"type":"message_end","message":{"role":"toolResult","toolName":"custom","details":{"usage":{"tokens":"unknown"}},"usage":{"input":5,"output":6,"cacheRead":7,"cacheWrite":8}}}\n');
    expect(c.result().usage).toEqual({ inputTokens: 6, outputTokens: 8, cacheReadTokens: 10, cacheCreationTokens: 12 });
  });

  test("Pi does not report an earlier tool-use draft as the final text", () => {
    const c = makeTerminalCollector("pi");
    c.feed('{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"draft"}],"usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0},"stopReason":"toolUse"}}\n');
    c.feed('{"type":"message_end","message":{"role":"assistant","content":[],"usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0},"stopReason":"error","errorMessage":"provider failed"}}\n');
    expect(c.result()).toMatchObject({ isError: true, errorType: "provider failed", finalText: undefined });
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
    delete process.env.PIEVO_PI_BIN;
  });

  test("claude-code: default bin + canonical argument vector", () => {
    const { bin, args } = buildAgentSpawn({ agent: "claude-code", prompt: "do it" });
    expect(bin).toBe("claude");
    expect(args).toEqual([
      "-p", "do it",
      "--output-format", "stream-json",
      "--verbose",
      "--permission-mode", "bypassPermissions",
      "--disallowed-tools", "ScheduleWakeup,CronCreate,CronList,CronDelete",
    ]);
  });

  test("claude-code: PIEVO_CLAUDE_BIN escape hatch + model, with no resume surface", () => {
    process.env.PIEVO_CLAUDE_BIN = "/opt/claude";
    const { bin, args } = buildAgentSpawn({ agent: "claude-code", prompt: "p", model: "opus" });
    expect(bin).toBe("/opt/claude");
    expect(args.slice(0, 2)).toEqual(["-p", "p"]);
    expect(args).not.toContain("--resume");
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
    const { bin, args } = buildAgentSpawn({ agent: "codex", prompt: "do it" });
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

  test("pi: exact JSON print argv and unchanged stdin, including model and thinking", () => {
    process.env.PIEVO_PI_BIN = "/opt/pi";
    const prompt = "  complete task\nwith trailing whitespace  \n";
    expect(buildAgentSpawn({ agent: "pi", prompt, model: "anthropic/claude-sonnet-4", reasoningEffort: "xhigh" })).toEqual({
      bin: "/opt/pi",
      args: [
        "-p", "--mode", "json", "--approve",
        "--model", "anthropic/claude-sonnet-4",
        "--thinking", "xhigh",
      ],
      stdin: prompt,
    });
  });

  test("pi: defaults the binary and omits optional provider flags", () => {
    expect(buildAgentSpawn({ agent: "pi", prompt: "task" })).toEqual({
      bin: "pi",
      args: ["-p", "--mode", "json", "--approve"],
      stdin: "task",
    });
  });

  test("an unknown agent throws instead of defaulting to Claude", () => {
    expect(() => buildAgentSpawn({ agent: "unknown" as any, prompt: "must not run" })).toThrow("unsupported coding agent: unknown");
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

// ---- runner integration fixtures ----

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
  delete process.env.PIEVO_PI_BIN;
  fs.rmSync(root, { recursive: true, force: true });
});

function delivery(overrides: Partial<Delivery> = {}): Delivery {
  return {
    runId: "run-1",
    runIndex: 1,
    runToken: "tok-1",
    loop: {
      id: "loop-1",
      name: "cookie-report",
      workdir,
      model: null,
      reasoningEffort: null,
      agent: "claude-code",
    },
    roots: [],
    task: "ORIGINAL TASK: produce the daily report",
    artifacts: [],
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

function writeFakePi(stopReason = "stop"): string {
  const p = path.join(root, `fake-pi-${stopReason}.sh`);
  fs.writeFileSync(p, [
    "#!/bin/sh",
    "cat > captured-task.txt",
    `echo '{"type":"session","version":3,"id":"pi-session"}'`,
    `echo '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"pi final"}],"usage":{"input":3,"output":4,"cacheRead":5,"cacheWrite":6},"stopReason":"${stopReason}","errorMessage":"pi provider error"}}'`,
    "exit 0",
    "",
  ].join("\n"), "utf8");
  fs.chmodSync(p, 0o755);
  return p;
}

describe("Pi delivery", () => {
  test("round-trips the complete composed task through stdin unchanged", async () => {
    process.env.PIEVO_PI_BIN = writeFakePi();
    const d = delivery();
    d.loop.agent = "pi";
    d.task = "  composed task\n\nreport contract  \n";
    const report = await executeDelivery(d, "http://server.test", []);
    expect(fs.readFileSync(path.join(workdir, "captured-task.txt"), "utf8")).toBe(d.task);
    expect(report).toMatchObject({ result: "success", exitCode: 0, sessionId: "pi-session", finalText: "pi final" });
  });

  test("fails an exit-zero run when Pi's last assistant stopReason is error", async () => {
    process.env.PIEVO_PI_BIN = writeFakePi("error");
    const d = delivery();
    d.loop.agent = "pi";
    const report = await executeDelivery(d, "http://server.test", []);
    expect(report).toMatchObject({ result: "failure", exitCode: 0, error: "pi provider error" });
  });
});

