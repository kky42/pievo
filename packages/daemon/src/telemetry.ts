/** Provider-specific terminal JSONL collectors.
 *
 * They intentionally collect only terminal telemetry: session identity, final
 * assistant text, and normalized token usage. Tool/text activity is not exposed
 * as live progress and no on-disk provider transcript is read.
 */
import type { CodingAgent } from "./create.js";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface AttemptTelemetry {
  sessionId?: string;
  finalText?: string;
  usage?: TokenUsage;
  isError: boolean;
  errorType?: string;
}

export interface TerminalCollector {
  feed(chunk: string): void;
  result(): AttemptTelemetry;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseClaudeUsage(value: unknown): TokenUsage | undefined {
  const usage = record(value);
  if (!usage) return undefined;
  const inputTokens = nonNegative(usage.input_tokens);
  const outputTokens = nonNegative(usage.output_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: nonNegative(usage.cache_read_input_tokens) ?? 0,
    cacheCreationTokens: nonNegative(usage.cache_creation_input_tokens) ?? 0,
  };
}

/** Claude result.modelUsage is keyed by model and uses camelCase token fields. */
function parseClaudeModelUsage(value: unknown): TokenUsage | undefined {
  const modelUsage = record(value);
  if (!modelUsage) return undefined;
  let total: TokenUsage | undefined;
  for (const candidate of Object.values(modelUsage)) {
    const item = record(candidate);
    if (!item) continue;
    const inputTokens = nonNegative(item.inputTokens);
    const outputTokens = nonNegative(item.outputTokens);
    if (inputTokens === undefined || outputTokens === undefined) continue;
    total = addUsage(total, {
      inputTokens,
      outputTokens,
      cacheReadTokens: nonNegative(item.cacheReadInputTokens) ?? 0,
      cacheCreationTokens: nonNegative(item.cacheCreationInputTokens) ?? 0,
    });
  }
  return total;
}

interface RawCodexUsage {
  /** Codex input_tokens includes cached_input_tokens as a subset. */
  totalInputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

function parseRawCodexUsage(value: unknown): RawCodexUsage | undefined {
  const usage = record(value);
  if (!usage) return undefined;
  const totalInputTokens = nonNegative(usage.input_tokens);
  const outputTokens = nonNegative(usage.output_tokens);
  if (totalInputTokens === undefined || outputTokens === undefined) return undefined;
  return {
    totalInputTokens,
    outputTokens,
    cachedInputTokens: nonNegative(usage.cached_input_tokens) ?? 0,
  };
}

function normalizeCodexUsage(raw: RawCodexUsage): TokenUsage {
  const cacheReadTokens = Math.min(raw.totalInputTokens, raw.cachedInputTokens);
  return {
    inputTokens: Math.max(0, raw.totalInputTokens - cacheReadTokens),
    outputTokens: raw.outputTokens,
    cacheReadTokens,
    cacheCreationTokens: 0,
  };
}

function addUsage(a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
  };
}

function assistantText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const text = value
    .map((part) => {
      const block = record(part);
      return block?.type === "text" && typeof block.text === "string" ? block.text : "";
    })
    .join("");
  return text.trim() ? text : undefined;
}

function subtractRawCodexUsage(total: RawCodexUsage, baseline: RawCodexUsage): RawCodexUsage {
  return {
    totalInputTokens: Math.max(0, total.totalInputTokens - baseline.totalInputTokens),
    outputTokens: Math.max(0, total.outputTokens - baseline.outputTokens),
    cachedInputTokens: Math.max(0, total.cachedInputTokens - baseline.cachedInputTokens),
  };
}

function codexSnapshot(event: JsonRecord): { total?: RawCodexUsage; last?: RawCodexUsage } | undefined {
  if (event.type !== "event_msg") return undefined;
  const payload = record(event.payload);
  if (payload?.type !== "token_count") return undefined;
  const info = record(payload.info);
  if (!info) return undefined;
  const total = parseRawCodexUsage(info.total_token_usage);
  const last = parseRawCodexUsage(info.last_token_usage);
  return total || last ? { total, last } : undefined;
}

function codexText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const text = value.map(codexText).filter((part): part is string => part !== undefined).join("");
    return text || undefined;
  }
  const item = record(value);
  if (!item) return undefined;
  if (typeof item.text === "string") return item.text;
  if (typeof item.message === "string") return item.message;
  if (item.type === "text" && typeof item.content === "string") return item.content;
  return codexText(item.text) ?? codexText(item.message) ?? codexText(item.content);
}

function structuredText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function makeCollector(agent: CodingAgent): TerminalCollector {
  let buffer = "";
  let sessionId: string | undefined;
  let finalText: string | undefined;
  let usage: TokenUsage | undefined;
  let isError = false;
  let errorType: string | undefined;
  let codexBaseline: RawCodexUsage | undefined;
  let codexTerminalUsageSeen = false;
  let codexTurnCompleted = false;
  let codexTurnFailed = false;
  let codexDiagnosticError: string | undefined;

  const handle = (line: string): void => {
    let event: JsonRecord;
    try {
      const parsed = JSON.parse(line) as unknown;
      const parsedRecord = record(parsed);
      if (!parsedRecord) return;
      event = parsedRecord;
    } catch {
      return;
    }

    if (agent === "claude-code") {
      if (event.type === "system" && event.subtype === "init" && typeof event.session_id === "string") {
        sessionId = event.session_id;
      }
      if (event.type === "assistant") {
        const message = record(event.message);
        usage = parseClaudeUsage(message?.usage) ?? usage;
        finalText = assistantText(message?.content) ?? finalText;
      }
      if (event.type === "result") {
        usage = parseClaudeModelUsage(event.modelUsage) ?? parseClaudeUsage(event.usage) ?? usage;
        if (typeof event.result === "string") finalText = event.result;
        isError = event.is_error === true;
        if (typeof event.subtype === "string") errorType = event.subtype;
      }
      if (event.type === "error") {
        isError = true;
        errorType = typeof event.message === "string" ? event.message : "error";
      }
      return;
    }

    if (event.type === "thread.started") {
      const candidate = event.thread_id ?? event.session_id ?? event.id;
      if (typeof candidate === "string" && candidate.trim()) sessionId = candidate;
    }
    if (event.type === "event_msg" && !codexTerminalUsageSeen) {
      const snapshot = codexSnapshot(event);
      if (snapshot?.total) {
        if (!codexBaseline) {
          // Codex cumulative totals can include persisted historical session
          // usage. total-minus-last is the pre-subprocess baseline. Pievo does
          // not currently initiate resumes, but parsing remains future-compatible.
          codexBaseline = snapshot.last
            ? subtractRawCodexUsage(snapshot.total, snapshot.last)
            : { totalInputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
        }
        // Subtract cumulative history while values are still in Codex's raw
        // coordinate system, then split uncached input from cached input.
        usage = normalizeCodexUsage(subtractRawCodexUsage(snapshot.total, codexBaseline));
      } else if (snapshot?.last) {
        usage = normalizeCodexUsage(snapshot.last);
      }
    }
    if (event.type === "turn.completed") {
      codexTurnCompleted = true;
      const terminal = parseRawCodexUsage(event.usage);
      if (terminal) {
        usage = normalizeCodexUsage(terminal);
        codexTerminalUsageSeen = true;
      }
    }
    if (event.type === "turn.failed") {
      codexTurnFailed = true;
      const error = record(event.error);
      errorType = typeof error?.message === "string" ? error.message : "turn failed";
    } else if (event.type === "error") {
      // Codex emits generic diagnostics mid-stream. They only become the
      // failure fallback when no successful turn.completed event arrives.
      codexDiagnosticError = typeof event.message === "string" ? event.message : "error";
    }
    if (event.type === "item.completed") {
      const item = record(event.item);
      if (item?.type === "agent_message") {
        finalText = codexText(item.text)
          ?? codexText(item.message)
          ?? codexText(item.content)
          ?? structuredText(item.structured_content)
          ?? finalText;
      }
    }
  };

  const feed = (chunk: string): void => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) handle(line);
    }
  };

  let finished: AttemptTelemetry | undefined;
  return {
    feed,
    result: () => {
      if (finished) return finished;
      const tail = buffer.trim();
      buffer = "";
      if (tail) handle(tail);
      if (agent === "codex") {
        isError = codexTurnFailed || (!codexTurnCompleted && codexDiagnosticError !== undefined);
        if (!codexTurnFailed) errorType = isError ? codexDiagnosticError : undefined;
      }
      finished = { sessionId, finalText, usage, isError, errorType };
      return finished;
    },
  };
}

export function makeTerminalCollector(agent: CodingAgent): TerminalCollector {
  return makeCollector(agent);
}
