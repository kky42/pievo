import { eventToActions as piEventToActions } from "../../pi_run/events.js";
import { formatLocalTimestamp, toErrorMessage } from "../../utils.js";
import { buildBackgroundTaskPrompt, buildBackgroundTriggerPrompt } from "./schedules.js";

const PI_RUN_ID = "pi";
const PI_RUN_DISPLAY_NAME = "Pi";

function noop() {}

export class BackgroundScheduleRunner {
  constructor({
    log = noop,
    deliveryAnchorForSession = (session) => session.deliveryAnchor ?? null,
    // Adapter callback signature: async ({ session, deliveryAnchor }) => boolean.
    // True means route the background result as a private/direct front-agent turn;
    // false means route it as a group-style front-agent turn.
    isDirectConversation = () => true,
    groupIdentity = () => ({}),
    eventToActions = piEventToActions
  } = {}) {
    this.log = log;
    this.deliveryAnchorForSession = deliveryAnchorForSession;
    this.isDirectConversation = isDirectConversation;
    this.groupIdentity = groupIdentity;
    this.eventToActions = eventToActions;
    this.activeRuns = new Set();
  }

  getActiveRunCount() {
    return this.activeRuns.size;
  }

  hasActiveRuns() {
    return this.activeRuns.size > 0;
  }

  async run(session, schedule, now = new Date()) {
    const deliveryAnchor = await this.deliveryAnchorForSession(session);
    const replyTarget = deliveryAnchor?.replyTarget ?? null;
    const triggeredAt = formatLocalTimestamp(Math.floor(now.getTime() / 1000));
    const messageParts = [];
    let failureText = null;
    let run = null;
    let resolveBackgroundDone = () => {};

    this.log(`background run starting: ${schedule.name} in ${session.conversationId}`);

    try {
      try {
        const developerInstructions = await session.buildFreshAdditionalSystemPrompt(null);
        run = session.createAgentRun({
          workdir: session.workdir,
          sessionId: null,
          message: buildBackgroundTaskPrompt(schedule.name, schedule.prompt),
          autoMode: session.auto,
          model: session.model,
          reasoningEffort: session.reasoningEffort,
          developerInstructions,
          enablePievoTools: false,
          onEvent: async (event) => {
            const actions = this.eventToActions(event);
            for (const action of actions) {
              if (action.kind === "message") {
                if (String(action.text ?? "").trim()) {
                  messageParts.push(String(action.text));
                }
                continue;
              }
              if (action.kind === "error" && !failureText) {
                failureText = action.text;
              }
            }
          },
          onStdErr: (chunk) => {
            const stderrText = String(chunk ?? "").trim();
            if (stderrText) {
              session.logger?.(`${PI_RUN_ID} background stderr: ${stderrText}`);
            }
          }
        });
        this.activeRuns.add(run);
        run.backgroundDone = new Promise((resolve) => {
          resolveBackgroundDone = resolve;
        });

        const result = await run.done;
        if (result?.aborted) {
          failureText = "Background run was aborted before completion.";
          this.log(`background run aborted: ${schedule.name} in ${session.conversationId}`);
        } else if (!failureText && !result?.sawTerminalEvent) {
          failureText = `${PI_RUN_DISPLAY_NAME} exited without a terminal JSON event.`;
        }
      } catch (error) {
        failureText = `${PI_RUN_DISPLAY_NAME} process error: ${toErrorMessage(error)}`;
        this.log(`background run error: ${schedule.name} in ${session.conversationId}: ${failureText}`);
      }

      if (run?.suppressBackgroundNotification) {
        this.log(`background run notification suppressed: ${schedule.name} in ${session.conversationId}`);
        return;
      }

      const completedAt = formatLocalTimestamp(Math.floor(Date.now() / 1000));
      const triggerPrompt = buildBackgroundTriggerPrompt({
        scheduleName: schedule.name,
        task: schedule.prompt,
        triggeredAt,
        completedAt,
        failed: Boolean(failureText),
        body: failureText ?? messageParts.join("\n\n")
      });

      if (await this.isDirectConversation({ session, deliveryAnchor })) {
        await session.enqueueTurn({
          mode: "private",
          promptText: triggerPrompt,
          replyTarget,
          scheduleName: schedule.name,
          suppressQueueNotice: true
        });
      } else {
        await session.enqueueTurn({
          mode: "group",
          groupInput: { messages: [triggerPrompt] },
          groupIdentity: this.groupIdentity(),
          replyTarget,
          scheduleName: schedule.name,
          suppressQueueNotice: true
        });
      }

      this.log(`background run finished: ${schedule.name} in ${session.conversationId} (failed=${Boolean(failureText)})`);
    } finally {
      if (run) {
        this.activeRuns.delete(run);
        resolveBackgroundDone();
      }
    }
  }

  async stop({ suppressNotification = false } = {}) {
    const backgroundRuns = [...this.activeRuns];
    for (const run of backgroundRuns) {
      if (suppressNotification) {
        run.suppressBackgroundNotification = true;
      }
      run.abort?.();
    }
    await Promise.allSettled(
      backgroundRuns.map((run) => (run.backgroundDone ?? run.done ?? Promise.resolve()).catch(() => null))
    );
    return backgroundRuns.length;
  }
}
