/** Strict runtime decoder for the protocol-v4 poll response. */
import path from "node:path";

import type { Delivery } from "./runner.js";

export interface NeedsUpdate {
  current: string | null;
  required: string;
  command: string;
}

export interface PollResponse {
  delivery: Delivery | null;
  cancelRunIds: string[];
  needsUpdate?: NeedsUpdate;
}

type Decode<T> = { ok: true; value: T } | { ok: false; error: string };
type JsonObject = Record<string, unknown>;

const DELIVERY_FIELDS = new Set(["runId", "runIndex", "runToken", "loop", "roots", "task", "artifacts"]);
const LOOP_FIELDS = new Set(["id", "name", "workdir", "model", "reasoningEffort", "agent"]);
const RESPONSE_FIELDS = new Set(["delivery", "cancelRunIds", "needsUpdate"]);
const UPDATE_FIELDS = new Set(["current", "required", "command"]);
const RUN_TOKEN_RE = /^rk_[0-9a-f]{32}$/;

function record(value: unknown, label: string): Decode<JsonObject> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? { ok: true, value: value as JsonObject }
    : { ok: false, error: `${label} must be an object` };
}

function exactKeys(value: JsonObject, expected: Set<string>, label: string): string | undefined {
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  if (unknown.length) return `${label} has unknown field(s): ${unknown.join(", ")}`;
  const missing = [...expected].filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  return missing.length ? `${label} is missing required field(s): ${missing.join(", ")}` : undefined;
}

function text(value: unknown, label: string): Decode<string> {
  return typeof value === "string" && value.length > 0 && !value.includes("\0")
    ? { ok: true, value }
    : { ok: false, error: `${label} must be a non-empty NUL-free string` };
}

function nullableText(value: unknown, label: string): Decode<string | null> {
  if (value === null) return { ok: true, value: null };
  return text(value, label);
}

function textArray(value: unknown, label: string): Decode<string[]> {
  if (!Array.isArray(value)) return { ok: false, error: `${label} must be an array` };
  const decoded: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const item = text(value[index], `${label}[${index}]`);
    if (!item.ok) return item;
    decoded.push(item.value);
  }
  return { ok: true, value: decoded };
}

function decodeLoop(value: unknown): Decode<Delivery["loop"]> {
  const decoded = record(value, "delivery.loop");
  if (!decoded.ok) return decoded;
  const raw = decoded.value;
  const keyError = exactKeys(raw, LOOP_FIELDS, "delivery.loop");
  if (keyError) return { ok: false, error: keyError };

  const id = text(raw.id, "delivery.loop.id");
  if (!id.ok) return id;
  const name = text(raw.name, "delivery.loop.name");
  if (!name.ok) return name;
  const workdir = text(raw.workdir, "delivery.loop.workdir");
  if (!workdir.ok) return workdir;
  if (!path.isAbsolute(workdir.value)) {
    return { ok: false, error: "delivery.loop.workdir must be absolute on this daemon platform" };
  }
  const model = nullableText(raw.model, "delivery.loop.model");
  if (!model.ok) return model;
  const reasoningEffort = nullableText(raw.reasoningEffort, "delivery.loop.reasoningEffort");
  if (!reasoningEffort.ok) return reasoningEffort;
  if (raw.agent !== "claude-code" && raw.agent !== "codex" && raw.agent !== "pi") {
    return { ok: false, error: "delivery.loop.agent must be exactly claude-code|codex|pi" };
  }
  return {
    ok: true,
    value: {
      id: id.value,
      name: name.value,
      workdir: workdir.value,
      model: model.value,
      reasoningEffort: reasoningEffort.value,
      agent: raw.agent,
    },
  };
}

function decodeDelivery(value: unknown): Decode<Delivery | null> {
  if (value === null) return { ok: true, value: null };
  const decoded = record(value, "delivery");
  if (!decoded.ok) return decoded;
  const raw = decoded.value;
  const keyError = exactKeys(raw, DELIVERY_FIELDS, "delivery");
  if (keyError) return { ok: false, error: keyError };

  const runId = text(raw.runId, "delivery.runId");
  if (!runId.ok) return runId;
  if (typeof raw.runIndex !== "number" || !Number.isSafeInteger(raw.runIndex) || raw.runIndex < 1) {
    return { ok: false, error: "delivery.runIndex must be a positive integer" };
  }
  if (typeof raw.runToken !== "string" || !RUN_TOKEN_RE.test(raw.runToken)) {
    return { ok: false, error: "delivery.runToken has an invalid wire shape" };
  }
  const loop = decodeLoop(raw.loop);
  if (!loop.ok) return loop;
  const roots = textArray(raw.roots, "delivery.roots");
  if (!roots.ok) return roots;
  for (let index = 0; index < roots.value.length; index++) {
    if (!path.isAbsolute(roots.value[index]!)) {
      return { ok: false, error: `delivery.roots[${index}] must be absolute on this daemon platform` };
    }
  }
  const task = text(raw.task, "delivery.task");
  if (!task.ok) return task;
  const artifacts = textArray(raw.artifacts, "delivery.artifacts");
  if (!artifacts.ok) return artifacts;

  return {
    ok: true,
    value: {
      runId: runId.value,
      runIndex: raw.runIndex,
      runToken: raw.runToken,
      loop: loop.value,
      roots: roots.value,
      task: task.value,
      artifacts: artifacts.value,
    },
  };
}

function decodeNeedsUpdate(value: unknown): Decode<NeedsUpdate> {
  const decoded = record(value, "needsUpdate");
  if (!decoded.ok) return decoded;
  const raw = decoded.value;
  const keyError = exactKeys(raw, UPDATE_FIELDS, "needsUpdate");
  if (keyError) return { ok: false, error: keyError };
  const current = nullableText(raw.current, "needsUpdate.current");
  if (!current.ok) return current;
  const required = text(raw.required, "needsUpdate.required");
  if (!required.ok) return required;
  const command = text(raw.command, "needsUpdate.command");
  if (!command.ok) return command;
  return { ok: true, value: { current: current.value, required: required.value, command: command.value } };
}

/** Decode every required runner field and reject additions instead of trusting a
 * TypeScript assertion over untrusted JSON. A failed decode is retryable: callers
 * must not apply cancellation or start a delivery from that response. */
export function parsePollResponse(value: unknown): Decode<PollResponse> {
  const decoded = record(value, "poll response");
  if (!decoded.ok) return decoded;
  const raw = decoded.value;
  const unknown = Object.keys(raw).filter((key) => !RESPONSE_FIELDS.has(key));
  if (unknown.length) return { ok: false, error: `poll response has unknown field(s): ${unknown.join(", ")}` };
  for (const required of ["delivery", "cancelRunIds"]) {
    if (!Object.prototype.hasOwnProperty.call(raw, required)) {
      return { ok: false, error: `poll response is missing required field: ${required}` };
    }
  }

  const delivery = decodeDelivery(raw.delivery);
  if (!delivery.ok) return delivery;
  const cancelRunIds = textArray(raw.cancelRunIds, "cancelRunIds");
  if (!cancelRunIds.ok) return cancelRunIds;

  let needsUpdate: NeedsUpdate | undefined;
  if (Object.prototype.hasOwnProperty.call(raw, "needsUpdate")) {
    const update = decodeNeedsUpdate(raw.needsUpdate);
    if (!update.ok) return update;
    needsUpdate = update.value;
    if (delivery.value !== null) {
      return { ok: false, error: "poll response must not deliver work when needsUpdate is present" };
    }
  }

  return {
    ok: true,
    value: {
      delivery: delivery.value,
      cancelRunIds: cancelRunIds.value,
      ...(needsUpdate ? { needsUpdate } : {}),
    },
  };
}
