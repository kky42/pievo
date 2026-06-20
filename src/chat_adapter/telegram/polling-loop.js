import { sleep, toErrorMessage } from "../../utils.js";
import { TelegramApiError } from "./telegram-api.js";

export class TelegramPollingLoop {
  constructor(runtime) {
    this.runtime = runtime;
  }

  async discardPendingUpdates() {
    const runtime = this.runtime;
    const updates = await runtime.botApi.getUpdates({
      offset: -1,
      limit: 1,
      timeout: 0
    });
    const lastUpdate = updates.at(-1);
    if (typeof lastUpdate?.update_id === "number") {
      runtime.offset = lastUpdate.update_id + 1;
    }
  }

  async start({ restoreScheduledConversations = true } = {}) {
    const runtime = this.runtime;
    if (runtime.polling) {
      return;
    }

    runtime.retiring = false;
    await runtime.initialize({ restoreScheduledConversations });
    runtime.polling = true;
    runtime.pollAbortController = new AbortController();

    runtime.pollPromise = (async () => {
      while (runtime.polling) {
        try {
          const updates = await runtime.botApi.getUpdates(
            {
              offset: runtime.offset,
              timeout: 50
            },
            {
              signal: runtime.pollAbortController.signal
            }
          );

          for (const update of updates) {
            await runtime.handleUpdate(update);
          }
        } catch (error) {
          if (!runtime.polling) {
            break;
          }

          if (error instanceof TelegramApiError) {
            runtime.log(`telegram polling error: ${error.message}`);
          } else {
            runtime.log(`polling failure: ${toErrorMessage(error)}`);
          }
          await sleep(2000);
        }
      }
    })();
  }

  async stop() {
    const runtime = this.runtime;
    runtime.requestStop();

    await runtime.abortBackgroundRuns({ suppressNotification: true });

    for (const session of runtime.sessions.values()) {
      session.queue = [];
      session.stopTyping();
      await session.abortCurrentRun();
    }

    if (runtime.pollPromise) {
      await runtime.pollPromise;
    }
  }
}

export function createTelegramPollingLoop(runtime) {
  return new TelegramPollingLoop(runtime);
}
