/**
 * Opt-in, spend-bearing validation against the real provider JSONL schemas.
 *
 * Run explicitly:
 *   PIEVO_REAL_LLM_TESTS=1 pnpm --filter @kky42/pievo test src/telemetry.real.test.ts
 *
 * Never enable this in the default suite: it invokes both installed CLIs and
 * consumes the operator's real provider credentials/credits.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { runProcess } from "./spawn.js";
import { makeTerminalCollector, type TokenUsage } from "./telemetry.js";

const REAL_LLM_TESTS = process.env.PIEVO_REAL_LLM_TESTS === "1";
const PROCESS_TIMEOUT_MS = 4 * 60_000;
const TEST_TIMEOUT_MS = 5 * 60_000;

interface RealCase {
  name: string;
  agent: "claude-code" | "codex";
  command: string;
  marker: string;
  args(prompt: string): string[];
}

const cases: RealCase[] = [
  {
    name: "Claude Haiku 4.5 effort=high",
    agent: "claude-code",
    command: process.env.PIEVO_CLAUDE_BIN || "claude",
    marker: "PIEVO_REAL_CLAUDE_TELEMETRY_OK",
    args: (prompt) => [
      "-p", prompt,
      "--output-format", "stream-json",
      "--verbose",
      "--permission-mode", "bypassPermissions",
      // Use the concrete Haiku id: this machine's short `haiku` alias may be
      // remapped by local Claude Code configuration, which would make the smoke
      // test claim Haiku while exercising another backend model.
      "--model", "claude-haiku-4-5-20251001",
      "--effort", "high",
    ],
  },
  {
    name: "Codex gpt-5.6-luna reasoning=high",
    agent: "codex",
    command: process.env.PIEVO_CODEX_BIN || "codex",
    marker: "PIEVO_REAL_CODEX_TELEMETRY_OK",
    args: (prompt) => [
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "-m", "gpt-5.6-luna",
      "-c", 'model_reasoning_effort="high"',
      prompt,
    ],
  },
];

function assertPositiveUsage(usage: TokenUsage | undefined): void {
  expect(usage, "provider emitted no recognized token usage").toBeDefined();
  expect(usage!.inputTokens, "normalized inputTokens must be positive").toBeGreaterThan(0);
  expect(usage!.outputTokens, "outputTokens must be positive").toBeGreaterThan(0);
}

describe.skipIf(!REAL_LLM_TESTS)("real provider terminal telemetry", () => {
  test.each(cases)("$name matches the live JSONL schema", async ({ agent, command, marker, args }) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `pievo-real-${agent}-`));
    const collector = makeTerminalCollector(agent);
    const prompt = `Reply with exactly this marker and nothing else: ${marker}`;

    try {
      const processResult = await runProcess(command, args(prompt), {
        cwd,
        env: process.env,
        timeoutMs: PROCESS_TIMEOUT_MS,
        onStdout: collector.feed,
      });
      const telemetry = collector.result();
      const diagnostic = [
        `${command} exit=${processResult.code} signal=${processResult.signal} timedOut=${processResult.timedOut}`,
        processResult.stderr.trim(),
        processResult.stdout.trim(),
      ].filter(Boolean).join("\n");

      expect(processResult.timedOut, diagnostic).toBe(false);
      expect(processResult.code, diagnostic).toBe(0);
      expect(telemetry.isError, telemetry.errorType ?? diagnostic).toBe(false);
      expect(telemetry.sessionId?.trim(), diagnostic).toBeTruthy();
      expect(telemetry.finalText?.trim(), diagnostic).toBe(marker);
      assertPositiveUsage(telemetry.usage);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);
});
