import { normalizeRunAt, normalizeScheduleTrigger } from "./schedule-time.js";

export const CONVERSATION_STATE_VERSION = 1;

export function cloneStateValue(value) {
  return value === null || value === undefined ? value : structuredClone(value);
}

export function normalizeString(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

export function normalizePromptSnapshot(value) {
  const normalized = String(value ?? "");
  return normalized || null;
}

export function normalizeContextLength(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeDeliveryAnchor(deliveryAnchor) {
  if (!deliveryAnchor || typeof deliveryAnchor !== "object" || Array.isArray(deliveryAnchor)) {
    return null;
  }

  const platformIdKey =
    typeof deliveryAnchor.chatId === "number" || typeof deliveryAnchor.chatId === "string"
      ? "chatId"
      : typeof deliveryAnchor.channelId === "string"
        ? "channelId"
        : null;
  if (!platformIdKey) {
    return null;
  }

  const normalized = {
    [platformIdKey]:
      platformIdKey === "chatId" ? Number(deliveryAnchor.chatId) : String(deliveryAnchor.channelId)
  };

  if (
    deliveryAnchor.replyTarget &&
    typeof deliveryAnchor.replyTarget === "object" &&
    !Array.isArray(deliveryAnchor.replyTarget)
  ) {
    normalized.replyTarget = cloneStateValue(deliveryAnchor.replyTarget);
  } else {
    normalized.replyTarget = null;
  }

  return normalized;
}

export function normalizeOverrides(overrides = {}) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    return {};
  }

  const normalized = {};
  for (const key of ["workdir", "auto", "model", "reasoningEffort"]) {
    const value = overrides[key];
    if (value === undefined || value === null || value === "") {
      continue;
    }
    normalized[key] = String(value);
  }
  return normalized;
}

function normalizeOptionalBoolean(value, fieldName) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  throw new Error(`${fieldName} must be a boolean`);
}

export function normalizeSchedule(schedule, index = 0) {
  if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) {
    throw new Error(`schedule[${index}] must be an object`);
  }

  const name = normalizeString(schedule.name);
  const mode = normalizeString(schedule.mode);
  const trigger = normalizeScheduleTrigger(schedule.trigger ?? schedule.kind, schedule);
  const cron = normalizeString(schedule.cron);
  const runAtValue = schedule.runAt ?? schedule.run_at;
  const prompt = typeof schedule.prompt === "string" ? schedule.prompt.trim() : "";
  const skipIfActive = normalizeOptionalBoolean(
    schedule.skipIfActive ?? schedule.skip_if_active,
    `schedule[${index}] skipIfActive`
  );
  if (!name || !mode || !prompt) {
    throw new Error(`schedule[${index}] must include name, mode, and prompt`);
  }
  if (mode !== "heartbeat" && mode !== "background") {
    throw new Error(`schedule[${index}] mode must be "heartbeat" or "background"`);
  }

  if (trigger === "once") {
    if (!runAtValue || cron) {
      throw new Error(`schedule[${index}] one-time schedules must include runAt and no cron`);
    }
    return {
      name,
      mode,
      trigger,
      runAt: normalizeRunAt(runAtValue),
      prompt,
      enabled: schedule.enabled !== false,
      ...(skipIfActive === false ? { skipIfActive } : {})
    };
  }

  if (!cron || runAtValue) {
    throw new Error(`schedule[${index}] cron schedules must include cron and no runAt`);
  }
  return {
    name,
    mode,
    trigger,
    cron,
    prompt,
    enabled: schedule.enabled !== false,
    ...(skipIfActive === false ? { skipIfActive } : {})
  };
}

export function normalizeSchedules(schedules = []) {
  if (!Array.isArray(schedules)) {
    throw new Error("schedules must be an array");
  }
  return schedules.map((schedule, index) => normalizeSchedule(schedule, index));
}

export function normalizeSession(session) {
  if (!session || typeof session !== "object" || Array.isArray(session)) {
    return null;
  }

  const id = normalizeString(session.id);
  const contextLength = normalizeContextLength(session.contextLength);
  const additionalSystemPromptSnapshot =
    typeof session.basis?.additionalSystemPromptSnapshot === "string"
      ? normalizePromptSnapshot(session.basis.additionalSystemPromptSnapshot)
      : null;
  const basis =
    session.basis && typeof session.basis === "object" && !Array.isArray(session.basis)
      ? {
          workdir: normalizeString(session.basis.workdir),
          additionalSystemPromptSnapshot
        }
      : null;

  if (!id && contextLength === null) {
    return null;
  }

  return {
    id,
    contextLength,
    basis
  };
}

export function defaultStateRecord(scope) {
  return {
    version: CONVERSATION_STATE_VERSION,
    conversation: {
      agentId: scope.agentId,
      platform: scope.platform,
      bindingId: scope.bindingId,
      conversationId: scope.conversationId
    },
    deliveryAnchor: null,
    session: null,
    overrides: {},
    schedules: []
  };
}

export function normalizeStateRecord(record, scope) {
  if (!record) {
    return defaultStateRecord(scope);
  }

  if (typeof record !== "object" || Array.isArray(record)) {
    throw new Error("state file must contain a JSON object");
  }
  if (record.version !== CONVERSATION_STATE_VERSION) {
    throw new Error(`unsupported conversation state version "${record.version}"`);
  }

  return {
    version: CONVERSATION_STATE_VERSION,
    conversation: {
      agentId: scope.agentId,
      platform: scope.platform,
      bindingId: scope.bindingId,
      conversationId: scope.conversationId
    },
    deliveryAnchor: normalizeDeliveryAnchor(record.deliveryAnchor),
    session: normalizeSession(record.session),
    overrides: normalizeOverrides(record.overrides),
    schedules: normalizeSchedules(record.schedules)
  };
}
