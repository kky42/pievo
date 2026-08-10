import path from "node:path";

import { Cron } from "croner";

import type {
  CodingAgent,
  CronOverlap,
  Loop,
  LoopSchedule,
  NewLoop,
  StatusDefinitions,
} from "../db/schema.js";
import { CODING_AGENTS, coerceCodingAgent } from "../types.js";
import { validateLoopTags } from "../lib/loopTags.js";
import { WIRE_TEXT_CAP } from "./http.js";

export const LOOP_CONFIG_FIELDS = [
  "name",
  "tags",
  "schedule",
  "workdir",
  "agent",
  "model",
  "reasoningEffort",
  "prompt",
  "statusDefinitions",
  "artifacts",
  "enabled",
] as const;

export const LOOP_EDIT_FIELDS = new Set<string>(LOOP_CONFIG_FIELDS);
const SAFE_RETAINED_CRON = "0 0 1 1 *";

type Validation<T> = { ok: true; value: T } | { ok: false; detail: string };

export interface CanonicalLoopConfig {
  name: string;
  tags: string[];
  schedule: LoopSchedule;
  workdir: string;
  agent: CodingAgent;
  model: string | null;
  reasoningEffort: string | null;
  prompt: string;
  statusDefinitions: StatusDefinitions;
  artifacts: string[];
  enabled: boolean;
}

export interface ValidatedLoopCreate {
  config: CanonicalLoopConfig;
  row: Pick<
    NewLoop,
    | "name"
    | "tags"
    | "cron"
    | "scheduleMode"
    | "cronOverlap"
    | "continuousDelayMinutes"
    | "timezone"
    | "workdir"
    | "agent"
    | "model"
    | "reasoningEffort"
    | "prompt"
    | "statusKeep"
    | "statusNoChange"
    | "statusBlock"
    | "artifacts"
    | "enabled"
  > & { timezone: string | null };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requiredText(value: unknown, field: string, preserve = false): Validation<string> {
  if (typeof value !== "string" || !value.trim()) return { ok: false, detail: `${field} is required` };
  if (value.includes("\0")) return { ok: false, detail: `${field} must not contain NUL` };
  if (value.length > WIRE_TEXT_CAP) return { ok: false, detail: `${field} exceeds ${WIRE_TEXT_CAP} characters` };
  return { ok: true, value: preserve ? value : value.trim() };
}

/** The server may validate a workdir for a daemon on another OS. Accept only
 * absolute POSIX or Windows syntax; never resolve a relative path against the
 * server process cwd. */
export function isAbsoluteWorkdir(value: string): boolean {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

function validateWorkdir(value: unknown): Validation<string> {
  const workdir = requiredText(value, "workdir");
  if (!workdir.ok) return workdir;
  return isAbsoluteWorkdir(workdir.value)
    ? workdir
    : { ok: false, detail: "workdir must be an absolute path" };
}

function normalizeProviderSetting(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const value = input.replaceAll("\0", "").trim();
  return value || null;
}

function optionalProvider(value: unknown, field: string): Validation<string | null> {
  if (value !== undefined && value !== null && typeof value !== "string") {
    return { ok: false, detail: `${field} must be a string or null` };
  }
  return { ok: true, value: normalizeProviderSetting(value) };
}

const PI_THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
function validateReasoningEffort(value: unknown, agent: CodingAgent): Validation<string | null> {
  const result = optionalProvider(value, "reasoningEffort");
  if (!result.ok) return result;
  if (agent === "pi" && result.value !== null && !PI_THINKING.has(result.value)) {
    return { ok: false, detail: "reasoningEffort for pi must be one of off, minimal, low, medium, high, xhigh, max, or null" };
  }
  return result;
}

function validTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

function validateCron(cron: string, timezone: string): Validation<string> {
  try {
    const probe = new Cron(cron, { paused: true, timezone });
    try {
      const first = probe.nextRun();
      const second = first ? probe.nextRun(first) : null;
      if (!first || !second) return { ok: false, detail: "schedule.cron must have future occurrences" };
      if (second.getTime() - first.getTime() < 60_000) {
        return { ok: false, detail: "schedule.cron must not run more than once per minute" };
      }
    } finally {
      probe.stop();
    }
    return { ok: true, value: cron };
  } catch (error) {
    return { ok: false, detail: `invalid schedule.cron: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function validateSchedule(value: unknown): Validation<LoopSchedule> {
  const raw = object(value);
  if (!raw) return { ok: false, detail: "schedule is required" };
  if (raw.mode === "cron") {
    const unknown = Object.keys(raw).filter((key) => !["mode", "cron", "timezone", "overlap"].includes(key));
    if (unknown.length) return { ok: false, detail: `cron schedule has unknown field(s): ${unknown.join(", ")}` };
    const cron = requiredText(raw.cron, "schedule.cron");
    if (!cron.ok) return cron;
    const timezone = requiredText(raw.timezone, "schedule.timezone");
    if (!timezone.ok) return timezone;
    if (!validTimezone(timezone.value)) return { ok: false, detail: `invalid schedule.timezone: ${timezone.value}` };
    const validCron = validateCron(cron.value, timezone.value);
    if (!validCron.ok) return validCron;
    if (raw.overlap !== "skip" && raw.overlap !== "queue-one") {
      return { ok: false, detail: "schedule.overlap must be skip|queue-one" };
    }
    return {
      ok: true,
      value: { mode: "cron", cron: validCron.value, timezone: timezone.value, overlap: raw.overlap as CronOverlap },
    };
  }
  if (raw.mode === "continuous") {
    const unknown = Object.keys(raw).filter((key) => !["mode", "delayMinutes"].includes(key));
    if (unknown.length) return { ok: false, detail: `continuous schedule has unknown field(s): ${unknown.join(", ")}` };
    if (typeof raw.delayMinutes !== "number" || !Number.isInteger(raw.delayMinutes) || raw.delayMinutes < 1) {
      return { ok: false, detail: "schedule.delayMinutes must be a JSON integer >= 1" };
    }
    return { ok: true, value: { mode: "continuous", delayMinutes: raw.delayMinutes } };
  }
  return { ok: false, detail: "schedule.mode must be cron|continuous" };
}

export function validateStatusDefinitions(value: unknown): Validation<StatusDefinitions> {
  const raw = object(value);
  if (!raw) return { ok: false, detail: "statusDefinitions is required" };
  const unknown = Object.keys(raw).filter((key) => !["keep", "noChange", "block"].includes(key));
  if (unknown.length) return { ok: false, detail: `statusDefinitions has unknown field(s): ${unknown.join(", ")}` };
  const keep = requiredText(raw.keep, "statusDefinitions.keep", true);
  if (!keep.ok) return keep;
  const noChange = requiredText(raw.noChange, "statusDefinitions.noChange", true);
  if (!noChange.ok) return noChange;
  const block = requiredText(raw.block, "statusDefinitions.block", true);
  if (!block.ok) return block;
  return { ok: true, value: { keep: keep.value, noChange: noChange.value, block: block.value } };
}

export function validateArtifactPaths(value: unknown): Validation<string[]> {
  if (value === undefined || value === null) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, detail: "artifacts must be an array of exact relative file paths" };
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) return { ok: false, detail: "artifact paths must be non-empty strings" };
    if (entry.includes("\0")) return { ok: false, detail: "artifact path must not contain NUL" };
    if (entry.startsWith("/") || entry.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(entry)) {
      return { ok: false, detail: `artifact path must be relative to workdir: ${entry}` };
    }
    const parts = entry.split(/[\\/]/);
    if (parts.some((part) => part === "" || part === "." || part === "..")) {
      return { ok: false, detail: `artifact path must not traverse or alias another path: ${entry}` };
    }
    if (seen.has(entry)) return { ok: false, detail: `duplicate artifact path: ${entry}` };
    seen.add(entry);
    paths.push(entry);
  }
  return { ok: true, value: paths };
}

function rowSchedule(schedule: LoopSchedule, retainedCron = SAFE_RETAINED_CRON): Pick<NewLoop, "cron" | "scheduleMode" | "cronOverlap" | "continuousDelayMinutes" | "timezone"> & { timezone: string | null } {
  return schedule.mode === "cron"
    ? {
        cron: schedule.cron,
        scheduleMode: "cron",
        cronOverlap: schedule.overlap,
        continuousDelayMinutes: 1,
        timezone: schedule.timezone,
      }
    : {
        cron: retainedCron,
        scheduleMode: "continuous",
        cronOverlap: "queue-one",
        continuousDelayMinutes: schedule.delayMinutes,
        timezone: null,
      };
}

export function scheduleFromLoop(loop: Loop): LoopSchedule {
  if (loop.scheduleMode === "continuous") {
    return { mode: "continuous", delayMinutes: loop.continuousDelayMinutes };
  }
  if (loop.scheduleMode === "cron") {
    if (!loop.timezone) throw new Error(`invariant: cron loop ${loop.id} has no timezone`);
    return {
      mode: "cron",
      cron: loop.cron,
      timezone: loop.timezone,
      overlap: loop.cronOverlap,
    };
  }
  throw new Error(`invariant: loop ${loop.id} has unknown schedule mode: ${String(loop.scheduleMode)}`);
}

export function statusDefinitionsFromLoop(loop: Loop): StatusDefinitions {
  return { keep: loop.statusKeep, noChange: loop.statusNoChange, block: loop.statusBlock };
}

export function canonicalLoopEnvelope(loop: Loop): CanonicalLoopConfig & { id: string } {
  return {
    id: loop.id,
    name: loop.name,
    tags: loop.tags,
    schedule: scheduleFromLoop(loop),
    workdir: loop.workdir,
    agent: loop.agent,
    model: loop.model ?? null,
    reasoningEffort: loop.reasoningEffort ?? null,
    prompt: loop.prompt,
    statusDefinitions: statusDefinitionsFromLoop(loop),
    artifacts: loop.artifacts,
    enabled: loop.enabled,
  };
}

export function validateLoopCreate(value: unknown): Validation<ValidatedLoopCreate> {
  const raw = object(value);
  if (!raw) return { ok: false, detail: "loop config must be an object" };
  const unknown = Object.keys(raw).filter((key) => !LOOP_CONFIG_FIELDS.includes(key as (typeof LOOP_CONFIG_FIELDS)[number]));
  if (unknown.length) return { ok: false, detail: `unknown field(s): ${unknown.join(", ")} — allowed: ${LOOP_CONFIG_FIELDS.join(", ")}` };
  const name = requiredText(raw.name, "name");
  if (!name.ok) return name;
  const tags = validateLoopTags(raw.tags);
  if (!tags.ok) return tags;
  const workdir = validateWorkdir(raw.workdir);
  if (!workdir.ok) return workdir;
  const prompt = requiredText(raw.prompt, "prompt", true);
  if (!prompt.ok) return prompt;
  const schedule = validateSchedule(raw.schedule);
  if (!schedule.ok) return schedule;
  const statusDefinitions = validateStatusDefinitions(raw.statusDefinitions);
  if (!statusDefinitions.ok) return statusDefinitions;
  const artifacts = validateArtifactPaths(raw.artifacts);
  if (!artifacts.ok) return artifacts;
  const model = optionalProvider(raw.model, "model");
  if (!model.ok) return model;
  const agent = coerceCodingAgent(raw.agent);
  if (!agent) return { ok: false, detail: `agent is required and must be one of ${CODING_AGENTS.join(", ")}` };
  const reasoningEffort = validateReasoningEffort(raw.reasoningEffort, agent);
  if (!reasoningEffort.ok) return reasoningEffort;
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") return { ok: false, detail: "enabled must be boolean" };
  const config: CanonicalLoopConfig = {
    name: name.value,
    tags: tags.value,
    schedule: schedule.value,
    workdir: workdir.value,
    agent,
    model: model.value,
    reasoningEffort: reasoningEffort.value,
    prompt: prompt.value,
    statusDefinitions: statusDefinitions.value,
    artifacts: artifacts.value,
    enabled: raw.enabled !== false,
  };
  return {
    ok: true,
    value: {
      config,
      row: {
        name: config.name,
        tags: config.tags,
        ...rowSchedule(config.schedule),
        workdir: config.workdir,
        agent: config.agent,
        model: config.model,
        reasoningEffort: config.reasoningEffort,
        prompt: config.prompt,
        statusKeep: config.statusDefinitions.keep,
        statusNoChange: config.statusDefinitions.noChange,
        statusBlock: config.statusDefinitions.block,
        artifacts: config.artifacts,
        enabled: config.enabled,
      },
    },
  };
}

export function validateLoopEdit(loop: Loop, value: unknown): Validation<Partial<NewLoop>> {
  const raw = object(value);
  if (!raw) return { ok: false, detail: "loop patch must be an object" };
  const unknown = Object.keys(raw).filter((key) => !LOOP_EDIT_FIELDS.has(key));
  if (unknown.length) return { ok: false, detail: `unknown field(s): ${unknown.join(", ")} — allowed: ${[...LOOP_EDIT_FIELDS].join(", ")}` };
  const update: Partial<NewLoop> = {};
  if (raw.name !== undefined) {
    const result = requiredText(raw.name, "name");
    if (!result.ok) return result;
    update.name = result.value;
  }
  if (raw.tags !== undefined) {
    const result = validateLoopTags(raw.tags);
    if (!result.ok) return result;
    update.tags = result.value;
  }
  if (raw.workdir !== undefined) {
    const result = validateWorkdir(raw.workdir);
    if (!result.ok) return result;
    update.workdir = result.value;
  }
  if (raw.prompt !== undefined) {
    const result = requiredText(raw.prompt, "prompt", true);
    if (!result.ok) return result;
    update.prompt = result.value;
  }
  if (raw.schedule !== undefined) {
    const result = validateSchedule(raw.schedule);
    if (!result.ok) return result;
    Object.assign(update, rowSchedule(result.value, loop.cron));
  }
  if (raw.statusDefinitions !== undefined) {
    const result = validateStatusDefinitions(raw.statusDefinitions);
    if (!result.ok) return result;
    update.statusKeep = result.value.keep;
    update.statusNoChange = result.value.noChange;
    update.statusBlock = result.value.block;
  }
  if (raw.artifacts !== undefined) {
    const result = validateArtifactPaths(raw.artifacts);
    if (!result.ok) return result;
    update.artifacts = result.value;
  }
  if (raw.model !== undefined) {
    const result = optionalProvider(raw.model, "model");
    if (!result.ok) return result;
    update.model = result.value;
  }
  let effectiveAgent = loop.agent;
  if (raw.agent !== undefined) {
    const agent = coerceCodingAgent(raw.agent);
    if (!agent) return { ok: false, detail: `agent must be one of ${CODING_AGENTS.join(", ")}` };
    effectiveAgent = agent;
    update.agent = agent;
  }
  if (raw.reasoningEffort !== undefined || raw.agent !== undefined) {
    const effectiveEffort = raw.reasoningEffort !== undefined ? raw.reasoningEffort : loop.reasoningEffort;
    const result = validateReasoningEffort(effectiveEffort, effectiveAgent);
    if (!result.ok) return result;
    if (raw.reasoningEffort !== undefined) update.reasoningEffort = result.value;
  }
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== "boolean") return { ok: false, detail: "enabled must be boolean" };
    update.enabled = raw.enabled;
  }
  return { ok: true, value: update };
}
