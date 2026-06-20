import { toErrorMessage } from "../../utils.js";
import {
  buildScheduleConfirmation,
  buildScheduleListText,
  parseScheduleAddArgs,
  parseScheduleMutationArgs,
  scheduleCommandHelp
} from "./schedules.js";

export function createPlainSchedulePresenter(commandName = "schedule") {
  return {
    async sendHelp({ session, options = {} }) {
      await session.sendText(scheduleCommandHelp(commandName), options);
    },

    async sendList({ session, schedules, options = {} }) {
      await session.sendText(buildScheduleListText(schedules), options);
    },

    async sendConfirmation({ session, action, schedule, options = {} }) {
      await session.sendText(buildScheduleConfirmation(action, schedule), options);
    },

    async sendError({ session, error, options = {} }) {
      await session.sendText(toErrorMessage(error), options);
    }
  };
}

function mergeSchedulePresenter(presenter, commandName) {
  return {
    ...createPlainSchedulePresenter(commandName),
    ...(presenter ?? {})
  };
}

export class ScheduleCommandHandler {
  constructor({ presenter = null, commandName = "schedule", syncConversationSchedules }) {
    if (typeof syncConversationSchedules !== "function") {
      throw new Error("ScheduleCommandHandler requires syncConversationSchedules().");
    }
    this.presenter = mergeSchedulePresenter(presenter, commandName);
    this.syncConversationSchedules = syncConversationSchedules;
  }

  async handle(session, args, options = {}) {
    const trimmedArgs = String(args ?? "").trim();
    if (!trimmedArgs) {
      await this.presenter.sendHelp({ session, options });
      return;
    }

    const action = trimmedArgs.split(/\s+/, 1)[0]?.toLowerCase();
    const schedules = session.schedules;

    try {
      if (action === "list") {
        await this.presenter.sendList({ session, schedules, options });
        return;
      }

      if (action === "add") {
        const schedule = parseScheduleAddArgs(trimmedArgs);
        if (schedules.some((candidate) => candidate.name === schedule.name)) {
          throw new Error(`Schedule "${schedule.name}" already exists.`);
        }
        await session.replaceSchedules([...schedules, { ...schedule, enabled: true }]);
        this.syncConversationSchedules(session);
        await this.presenter.sendConfirmation({
          session,
          action: "Added",
          schedule,
          options
        });
        return;
      }

      if (action === "remove") {
        const name = parseScheduleMutationArgs(trimmedArgs, "remove");
        const schedule = schedules.find((candidate) => candidate.name === name);
        if (!schedule) {
          throw new Error(`Schedule "${name}" does not exist.`);
        }
        await session.replaceSchedules(schedules.filter((candidate) => candidate.name !== name));
        session.removeQueuedScheduledTurns(name);
        this.syncConversationSchedules(session);
        await this.presenter.sendConfirmation({
          session,
          action: "Removed",
          schedule,
          options
        });
        return;
      }

      if (action === "enable" || action === "disable") {
        const name = parseScheduleMutationArgs(trimmedArgs, action);
        const schedule = schedules.find((candidate) => candidate.name === name);
        if (!schedule) {
          throw new Error(`Schedule "${name}" does not exist.`);
        }
        const enabled = action === "enable";
        const nextSchedules = schedules.map((candidate) =>
          candidate.name === name ? { ...candidate, enabled } : candidate
        );
        await session.replaceSchedules(nextSchedules);
        if (!enabled) {
          session.removeQueuedScheduledTurns(name);
        }
        this.syncConversationSchedules(session);
        await this.presenter.sendConfirmation({
          session,
          action: enabled ? "Enabled" : "Disabled",
          schedule: {
            ...schedule,
            enabled
          },
          options
        });
        return;
      }

      await this.presenter.sendHelp({ session, options });
    } catch (error) {
      await this.presenter.sendError({ session, error, options });
    }
  }
}
