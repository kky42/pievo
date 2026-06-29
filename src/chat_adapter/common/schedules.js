import { renderPrompt } from "../../prompts/index.js";
import { formatLocalTimestamp } from "../../utils.js";
import { delayUntilCronOccurrence, parseCronExpression } from "./cron.js";
import {
  isOneTimeSchedule,
  parseRunAtDate,
  SCHEDULE_TRIGGERS
} from "./schedule-time.js";

export const SCHEDULE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
export const SCHEDULE_MODES = new Set(["heartbeat", "background"]);
export { SCHEDULE_TRIGGERS };

export function validateScheduleName(name) {
  const normalized = String(name ?? "").trim();
  if (!normalized || !SCHEDULE_NAME_PATTERN.test(normalized)) {
    throw new Error("Schedule name must contain only letters, numbers, \"_\", or \"-\".");
  }
  return normalized;
}

export function buildScheduleListText(schedules) {
  if (!Array.isArray(schedules) || schedules.length === 0) {
    return "No schedules.";
  }

  const sorted = [...schedules].sort((left, right) => left.name.localeCompare(right.name));
  return sorted
    .map((schedule) => {
      const status = schedule.enabled === false ? "disabled" : "enabled";
      let oneTime = false;
      let triggerLine = "trigger: invalid";
      let next = "disabled";

      try {
        oneTime = isOneTimeSchedule(schedule);
        triggerLine = oneTime ? `once: ${schedule.runAt ?? schedule.run_at}` : `cron: ${schedule.cron}`;
        if (schedule.enabled !== false) {
          const nextDate = describeNextSchedule(schedule);
          next = formatLocalTimestamp(Math.floor(nextDate.getTime() / 1000));
        }
      } catch {
        next = schedule.enabled === false
          ? "disabled"
          : triggerLine === "trigger: invalid"
            ? "invalid schedule"
            : oneTime
              ? "invalid run_at"
              : "invalid cron";
      }

      return [
        `${status}  ${schedule.mode}  ${schedule.name}`,
        triggerLine,
        `next: ${next}`
      ].join("\n");
    })
    .join("\n\n");
}

export function buildScheduleConfirmation(action, schedule) {
  const lines = [`${action} schedule "${schedule.name}".`];
  if (schedule.mode) {
    lines.push(`mode: ${schedule.mode}`);
  }
  if (isOneTimeSchedule(schedule)) {
    lines.push(`once: ${schedule.runAt ?? schedule.run_at}`);
  } else if (schedule.cron) {
    lines.push(`cron: ${schedule.cron}`);
  }
  return lines.join("\n");
}

export function buildHeartbeatPrivatePrompt(scheduleName, prompt) {
  return renderPrompt("templates/heartbeat-private.md", {
    schedule_name: scheduleName,
    prompt: String(prompt ?? "").trim()
  });
}

export function buildHeartbeatGroupTranscriptMessage(scheduleName, prompt, now = new Date()) {
  return renderPrompt("templates/heartbeat-group-message.md", {
    timestamp: formatLocalTimestamp(Math.floor(now.getTime() / 1000)),
    schedule_name: scheduleName,
    prompt: String(prompt ?? "").trim()
  });
}

export function buildBackgroundTaskPrompt(scheduleName, prompt) {
  return renderPrompt("templates/background-task.md", {
    schedule_name: scheduleName,
    prompt: String(prompt ?? "").trim()
  });
}

export function buildBackgroundTriggerPrompt({
  scheduleName,
  task,
  triggeredAt,
  completedAt,
  failed = false,
  body
}) {
  const header = failed
    ? "Background schedule failed"
    : "Background schedule result";
  const normalizedBody = String(body ?? "").trim() || "(no final response)";
  return renderPrompt("templates/background-trigger.md", {
    header,
    schedule_name: scheduleName,
    triggered_at: triggeredAt,
    completed_at: completedAt,
    task: String(task ?? "").trim(),
    body: normalizedBody
  });
}

export function describeNextSchedule(schedule, now = new Date()) {
  if (isOneTimeSchedule(schedule)) {
    return parseRunAtDate(schedule.runAt ?? schedule.run_at);
  }
  const { next } = delayUntilCronOccurrence(parseCronExpression(schedule.cron), now);
  return next;
}
