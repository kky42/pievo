export const SCHEDULE_TRIGGERS = new Set(["cron", "once"]);

const RUN_AT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|[+-]\d{2}:\d{2})$/;

function parseIntegerToken(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${fieldName} must be an integer.`);
  }
  return parsed;
}

function assertRange(value, min, max, fieldName) {
  if (value < min || value > max) {
    throw new Error(`${fieldName} must be between ${min} and ${max}.`);
  }
}

function offsetMinutes(offsetText) {
  if (offsetText === "Z") {
    return 0;
  }
  const sign = offsetText.startsWith("-") ? -1 : 1;
  const hours = parseIntegerToken(offsetText.slice(1, 3), "run_at timezone hour");
  const minutes = parseIntegerToken(offsetText.slice(4, 6), "run_at timezone minute");
  assertRange(hours, 0, 23, "run_at timezone hour");
  assertRange(minutes, 0, 59, "run_at timezone minute");
  return sign * ((hours * 60) + minutes);
}

function partsFromUtcMsInOffset(utcMs, offset) {
  const shifted = new Date(utcMs + offset * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds()
  };
}

export function normalizeScheduleTrigger(trigger, schedule = {}) {
  const normalized = String(trigger ?? "").trim().toLowerCase();
  if (SCHEDULE_TRIGGERS.has(normalized)) {
    return normalized;
  }
  if (!normalized) {
    return schedule.runAt || schedule.run_at ? "once" : "cron";
  }
  throw new Error('Schedule trigger must be "cron" or "once".');
}

export function isOneTimeSchedule(schedule) {
  const candidate = schedule && typeof schedule === "object" ? schedule : {};
  return normalizeScheduleTrigger(candidate.trigger, candidate) === "once";
}

export function normalizeRunAt(value) {
  const runAt = String(value ?? "").trim();
  if (!runAt) {
    throw new Error("run_at is required for one-time schedules.");
  }

  const match = RUN_AT_PATTERN.exec(runAt);
  if (!match) {
    throw new Error(
      "run_at must use ISO 8601 with seconds and timezone, for example 2026-06-22T09:00:00+08:00."
    );
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetText] = match;
  const parts = {
    year: parseIntegerToken(yearText, "run_at year"),
    month: parseIntegerToken(monthText, "run_at month"),
    day: parseIntegerToken(dayText, "run_at day"),
    hour: parseIntegerToken(hourText, "run_at hour"),
    minute: parseIntegerToken(minuteText, "run_at minute"),
    second: parseIntegerToken(secondText, "run_at second")
  };

  assertRange(parts.month, 1, 12, "run_at month");
  assertRange(parts.day, 1, 31, "run_at day");
  assertRange(parts.hour, 0, 23, "run_at hour");
  assertRange(parts.minute, 0, 59, "run_at minute");
  assertRange(parts.second, 0, 59, "run_at second");

  const offset = offsetMinutes(offsetText);
  const utcMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  ) - offset * 60 * 1000;
  const checked = partsFromUtcMsInOffset(utcMs, offset);
  if (
    checked.year !== parts.year ||
    checked.month !== parts.month ||
    checked.day !== parts.day ||
    checked.hour !== parts.hour ||
    checked.minute !== parts.minute ||
    checked.second !== parts.second
  ) {
    throw new Error("run_at is not a valid calendar time.");
  }

  return runAt;
}

export function parseRunAtDate(value) {
  const runAt = normalizeRunAt(value);
  return new Date(runAt);
}

export function assertFutureRunAt(value, now = new Date()) {
  const runAt = normalizeRunAt(value);
  const runAtDate = parseRunAtDate(runAt);
  if (runAtDate.getTime() <= now.getTime()) {
    throw new Error("run_at must be in the future.");
  }
  return runAt;
}
