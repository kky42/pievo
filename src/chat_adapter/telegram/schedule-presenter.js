import { formatLocalTimestamp, toErrorMessage } from "../../utils.js";
import {
  buildScheduleConfirmation,
  buildScheduleListText,
  describeNextSchedule
} from "../common/schedules.js";
import { isOneTimeSchedule } from "../common/schedule-time.js";

function inlineValue(value) {
  return String(value ?? "").replace(/\s*\r?\n\s*/g, " ").trim();
}

function markdownKeyValues(rows) {
  return rows.map(([key, value]) => `- **${key}:** ${inlineValue(value)}`).join("\n");
}

function buildTelegramScheduleListMarkdown(schedules) {
  if (!Array.isArray(schedules) || schedules.length === 0) {
    return "No schedules.";
  }

  const blocks = [...schedules]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((schedule) => {
      const status = schedule.enabled === false ? "disabled" : "enabled";
      let oneTime = false;
      let triggerLine = "  - trigger: invalid";
      let next = "disabled";

      try {
        oneTime = isOneTimeSchedule(schedule);
        triggerLine = oneTime
          ? `  - once: \`${inlineValue(schedule.runAt ?? schedule.run_at)}\``
          : `  - cron: \`${inlineValue(schedule.cron)}\``;
        if (schedule.enabled !== false) {
          next = formatLocalTimestamp(Math.floor(describeNextSchedule(schedule).getTime() / 1000));
        }
      } catch {
        next = schedule.enabled === false
          ? "disabled"
          : triggerLine === "  - trigger: invalid"
            ? "invalid schedule"
            : oneTime
              ? "invalid run_at"
              : "invalid cron";
      }

      return [
        `- **${inlineValue(schedule.name)}** (${inlineValue(schedule.mode)}, ${status})`,
        triggerLine,
        `  - next: ${inlineValue(next)}`
      ].join("\n");
    });

  return ["# Schedules", "", blocks.join("\n")].join("\n");
}

function buildTelegramScheduleConfirmationMarkdown(action, schedule) {
  const rows = [];
  if (schedule.mode) {
    rows.push(["mode", schedule.mode]);
  }
  if (isOneTimeSchedule(schedule)) {
    rows.push(["once", schedule.runAt ?? schedule.run_at]);
  } else if (schedule.cron) {
    rows.push(["cron", schedule.cron]);
  }
  return [
    `**${action} schedule \"${schedule.name}\".**`,
    rows.length ? "" : null,
    rows.length ? markdownKeyValues(rows) : null
  ].filter(Boolean).join("\n");
}

async function sendRichOrText(session, markdown, fallbackText, options = {}) {
  if (typeof session.sendRichText === "function") {
    await session.sendRichText(markdown, { ...options, fallbackText });
    return;
  }
  await session.sendText(fallbackText, options);
}

export function createTelegramSchedulePresenter() {
  return {
    async sendList({ session, schedules, options = {} }) {
      await sendRichOrText(
        session,
        buildTelegramScheduleListMarkdown(schedules),
        buildScheduleListText(schedules),
        options
      );
    },

    async sendConfirmation({ session, action, schedule, options = {} }) {
      await sendRichOrText(
        session,
        buildTelegramScheduleConfirmationMarkdown(action, schedule),
        buildScheduleConfirmation(action, schedule),
        options
      );
    },

    async sendError({ session, error, options = {} }) {
      await session.sendText(toErrorMessage(error), options);
    }
  };
}
