import { toErrorMessage } from "../../utils.js";
import {
  buildScheduleConfirmation,
  buildScheduleListText
} from "./schedules.js";

export function createPlainSchedulePresenter() {
  return {
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

function mergeSchedulePresenter(presenter) {
  return {
    ...createPlainSchedulePresenter(),
    ...(presenter ?? {})
  };
}

export class ScheduleCommandHandler {
  constructor({ presenter = null } = {}) {
    this.presenter = mergeSchedulePresenter(presenter);
  }

  async handle(session, args, options = {}) {
    const trimmedArgs = String(args ?? "").trim();
    const schedules = session.schedules;

    try {
      if (!trimmedArgs) {
        await this.presenter.sendList({ session, schedules, options });
        return;
      }

      throw new Error(
        "/schedule only lists scheduled tasks. To create or remove schedules, ask me in natural language."
      );
    } catch (error) {
      await this.presenter.sendError({ session, error, options });
    }
  }
}
