import { formatLocalTimestamp, toErrorMessage } from "../../utils.js";
import {
  buildScheduleConfirmation,
  buildScheduleListText,
  describeNextSchedule,
  scheduleCommandHelp
} from "../common/schedules.js";

function inlineValue(value) {
  return String(value ?? "").replace(/\s*\r?\n\s*/g, " ").trim();
}

function markdownKeyValues(rows) {
  return rows.map(([key, value]) => `- **${key}:** ${inlineValue(value)}`).join("\n");
}

function buildTelegramScheduleHelpMarkdown(commandName = "/schedule") {
  return [
    "# Schedule Commands",
    "",
    "- List schedules:",
    `  - \`${commandName} list\``,
    "- Add heartbeat:",
    `  - \`${commandName} add heartbeat <name>\``,
    "  - next line: `<cron>`",
    "  - remaining lines: `<prompt>`",
    "- Add background:",
    `  - \`${commandName} add background <name>\``,
    "  - next line: `<cron>`",
    "  - remaining lines: `<prompt>`",
    "- Single-line add:",
    `  - \`${commandName} add background <name> <5 cron fields> <prompt>\``,
    "- Manage:",
    `  - \`${commandName} remove <name>\``,
    `  - \`${commandName} enable <name>\``,
    `  - \`${commandName} disable <name>\``
  ].join("\n");
}

function buildTelegramScheduleListMarkdown(schedules) {
  if (!Array.isArray(schedules) || schedules.length === 0) {
    return "No schedules.";
  }

  const blocks = [...schedules]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((schedule) => {
      const status = schedule.enabled === false ? "disabled" : "enabled";
      let next = "disabled";
      if (schedule.enabled !== false) {
        try {
          next = formatLocalTimestamp(Math.floor(describeNextSchedule(schedule).getTime() / 1000));
        } catch {
          next = "invalid cron";
        }
      }
      return [
        `- **${inlineValue(schedule.name)}** (${inlineValue(schedule.mode)}, ${status})`,
        `  - cron: \`${inlineValue(schedule.cron)}\``,
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
  if (schedule.cron) {
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

export function createTelegramSchedulePresenter(commandName = "/schedule") {
  return {
    async sendHelp({ session, options = {} }) {
      await sendRichOrText(
        session,
        buildTelegramScheduleHelpMarkdown(commandName),
        scheduleCommandHelp(commandName),
        options
      );
    },

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
