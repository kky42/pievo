import { eventToActions as piEventToActions } from "../../pi_run/events.js";
import { createPiToolBridge } from "../../pi_tools/tool-bridge-server.js";
import { formatLocalTimestamp, toErrorMessage } from "../../utils.js";
import {
  buildGroupOutputDeveloperInstructions,
  PRIVATE_OUTPUT_DEVELOPER_INSTRUCTIONS
} from "./output-instructions.js";
import { buildBackgroundNotificationText, buildBackgroundPrompt } from "./schedules.js";

const PI_RUN_ID = "pi";
const PI_RUN_DISPLAY_NAME = "Pi";

function noop() {}

export class BackgroundScheduleRunner {
  constructor({
    log = noop,
    syncConversationSchedules,
    deliveryAnchorForSession = (session) => session.deliveryAnchor ?? null,
    isDirectConversation = () => true,
    groupIdentity = () => ({}),
    createToolBridge = createPiToolBridge,
    eventToActions = piEventToActions
  }) {
    if (typeof syncConversationSchedules !== "function") {
      throw new Error("BackgroundScheduleRunner requires syncConversationSchedules().");
    }
    this.log = log;
    this.syncConversationSchedules = syncConversationSchedules;
    this.deliveryAnchorForSession = deliveryAnchorForSession;
    this.isDirectConversation = isDirectConversation;
    this.groupIdentity = groupIdentity;
    this.createToolBridge = createToolBridge;
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
    const isDirect = await this.isDirectConversation({ session, deliveryAnchor });
    const isGroupRun = !isDirect;
    const triggeredAt = formatLocalTimestamp(Math.floor(now.getTime() / 1000));
    const messageParts = [];
    const toolCalls = [];
    let failureText = null;
    let toolBridge = null;
    let run = null;
    let resolveBackgroundDone = () => {};

    this.log(`background run starting: ${schedule.name} in ${session.conversationId}`);

    const relayInstructions = isGroupRun
      ? buildGroupOutputDeveloperInstructions(await this.groupIdentity({ session, deliveryAnchor }))
      : PRIVATE_OUTPUT_DEVELOPER_INSTRUCTIONS;
    const onToolCall = async (toolCall) => {
      toolCalls.push(toolCall);
      if (typeof session.onPiToolCall === "function") {
        await session.onPiToolCall(toolCall);
      }
    };

    try {
      try {
        toolBridge = await this.createToolBridge({
          session,
          isGroupTurn: isGroupRun,
          replyTarget,
          onSchedulesChanged: (changedSession) => this.syncConversationSchedules(changedSession),
          onToolCall,
          disableScheduleTools: true
        });
      } catch (error) {
        failureText = `Failed to start Pi tool bridge: ${toErrorMessage(error)}`;
        this.log(`background run bridge error: ${schedule.name} in ${session.conversationId}: ${failureText}`);
      }

      if (!failureText) {
        try {
          const developerInstructions = await session.buildFreshAdditionalSystemPrompt(relayInstructions);
          run = session.createAgentRun({
            workdir: session.workdir,
            sessionId: null,
            message: buildBackgroundPrompt(schedule.name, schedule.prompt),
            autoMode: session.auto,
            model: session.model,
            reasoningEffort: session.reasoningEffort,
            developerInstructions,
            extraEnv: toolBridge.env,
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
      }

      if (run?.suppressBackgroundNotification) {
        this.log(`background run notification suppressed: ${schedule.name} in ${session.conversationId}`);
        return;
      }

      if (isGroupRun && !failureText) {
        if (messageParts.some((text) => String(text ?? "").trim())) {
          session.logger?.(`${PI_RUN_ID} background final group text suppressed; use send_reply for visible group output.`);
        } else if (!toolCalls.some((call) => call?.tool === "send_reply" || call?.tool === "send_attachment")) {
          this.log(`background run produced no visible group output: ${schedule.name} in ${session.conversationId}`);
        }
        this.log(`background run finished: ${schedule.name} in ${session.conversationId} (failed=false)`);
        return;
      }

      await session.sendText(
        buildBackgroundNotificationText({
          scheduleName: schedule.name,
          triggeredAt,
          failed: Boolean(failureText),
          body: failureText ?? messageParts.join("\n\n")
        }),
        { replyTarget }
      );

      this.log(`background run finished: ${schedule.name} in ${session.conversationId} (failed=${Boolean(failureText)})`);
    } finally {
      if (run) {
        this.activeRuns.delete(run);
        resolveBackgroundDone();
      }
      try {
        toolBridge?.dispose?.();
      } catch (error) {
        session.logger?.(`failed to dispose Pi tool bridge: ${toErrorMessage(error)}`);
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
