import { buildPiArgs } from "../../pi_run/args.js";
import { eventToActions as piEventToActions } from "../../pi_run/events.js";
import { buildTurnInputMessage } from "../../pi_run/input-message.js";
import { createPiToolBridge } from "../../pi_tools/tool-bridge-server.js";
import { toErrorMessage } from "../../utils.js";
import { buildGroupInputMessage } from "./group-turn.js";
import {
  buildGroupOutputDeveloperInstructions,
  buildPrivateOutputDeveloperInstructions
} from "./output-instructions.js";

export const PI_RUN_ID = "pi";
export const PI_RUN_DISPLAY_NAME = "Pi";

export function looksLikeResumeFailure(text) {
  const normalized = String(text ?? "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    /(resume|session|thread)/.test(normalized) &&
    /(not found|no (?:resume|session|thread) found|unknown|missing|invalid|expired|cannot|can't|failed|does not exist|no such)/.test(
      normalized
    )
  );
}

const STDERR_TAIL_LIMIT = 4000;

function appendTextTail(previous, chunk, limit = STDERR_TAIL_LIMIT) {
  const next = `${previous ?? ""}${chunk ?? ""}`;
  return next.length > limit ? next.slice(-limit) : next;
}

function withStderrContext(message, stderrTail) {
  const normalizedTail = String(stderrTail ?? "").trim();
  if (!normalizedTail || String(message).includes(normalizedTail)) {
    return message;
  }
  return `${message}\nstderr:\n${normalizedTail}`;
}

export function redactDebugArgs(args, promptLength, additionalSystemPromptLength) {
  const redacted = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--append-system-prompt") {
      redacted.push(arg);
      if (index + 1 < args.length) {
        redacted.push(`<additional-system-prompt:${additionalSystemPromptLength}>`);
        index += 1;
      }
      continue;
    }
    redacted.push(arg);
  }

  if (redacted.length > 0) {
    redacted[redacted.length - 1] = `<prompt:${promptLength}>`;
  }
  return redacted;
}

function buildInputMessage(turn) {
  return turn.groupInput
    ? buildGroupInputMessage(turn.groupInput)
    : buildTurnInputMessage(turn);
}

function buildRelayInstructions(turn, isGroupTurn) {
  return turn.developerInstructions ??
    (isGroupTurn
      ? buildGroupOutputDeveloperInstructions(turn.groupIdentity ?? {})
      : buildPrivateOutputDeveloperInstructions());
}

function resolveAdditionalSystemPromptSnapshot(session, relayInstructions) {
  if (session.sessionId) {
    return {
      developerInstructions: session.additionalSystemPromptSnapshot,
      additionalSystemPromptSnapshot: session.additionalSystemPromptSnapshot
    };
  }

  const developerInstructions = session.buildFreshAdditionalSystemPrompt(relayInstructions);
  return {
    developerInstructions,
    additionalSystemPromptSnapshot: developerInstructions
  };
}

async function updateContextLengthAfterCompletedTurn({
  session,
  currentSessionId,
  completedTurn,
  resolveContextLength
}) {
  if (!completedTurn || !currentSessionId) {
    return;
  }

  const contextLength = await resolveContextLength(currentSessionId);
  if (contextLength !== null && contextLength !== undefined) {
    await session.updateContextLength(contextLength);
  }
}

async function handlePiAction({
  action,
  session,
  turn,
  isGroupTurn,
  mayRetryFailedResume,
  additionalSystemPromptSnapshot,
  state
}) {
  if (action.kind === "session_started" && action.sessionId) {
    state.currentSessionId = action.sessionId;
    await session.updateSessionId(action.sessionId, {
      additionalSystemPromptSnapshot
    });
    return;
  }

  if (action.kind === "turn_completed") {
    state.completedTurn = true;
    return;
  }

  if (action.kind === "context_length") {
    await session.updateContextLength(action.contextLength);
    return;
  }

  if (action.kind === "progress") {
    if (isGroupTurn) {
      session.logger(`${PI_RUN_ID} progress: ${action.text}`);
      return;
    }
    await session.renderProgressText(action.text, { replyTarget: turn.replyTarget });
    return;
  }

  if (action.kind === "error") {
    if (mayRetryFailedResume && looksLikeResumeFailure(action.text)) {
      state.resumeFailureMessage = action.text;
      return;
    }
    state.emittedError = true;
    await session.renderErrorText(action.text, { replyTarget: turn.replyTarget });
    return;
  }

  if (action.kind === "message") {
    try {
      if (isGroupTurn) {
        session.logger(`${PI_RUN_ID} final group text suppressed; use send_reply for visible group output.`);
      } else {
        await session.renderFinalMessage(action.text, { replyTarget: turn.replyTarget });
      }
    } catch (error) {
      state.emittedError = true;
      if (isGroupTurn) {
        await session.renderErrorText(
          `Failed to deliver group output: ${toErrorMessage(error)}`,
          { replyTarget: turn.replyTarget }
        );
        return;
      }
      throw error;
    }
  }
}

function cleanupTurn(session, toolBridge) {
  try {
    toolBridge?.dispose?.();
  } catch (error) {
    session.logger(`failed to dispose Pi tool bridge: ${toErrorMessage(error)}`);
  }
  session.activeRun = null;
  session.activeReplyTarget = null;
  session.isRunning = false;
  session.stopTyping();
  session.resetTransientTurnState();
}

async function handleResumeFailure({ session, turn }) {
  await session.clearProgressMessage();
  await session.clearSessionState();
  session.queue.unshift({
    ...turn,
    resumeRetryCount: turn.resumeRetryCount + 1
  });
  await session.sendText(
    "Stored session could not be resumed. Started a fresh session for this conversation.",
    { replyTarget: turn.replyTarget }
  );
}

export async function runFrontAgentTurn({
  session,
  turn,
  createAgentRun,
  resolveContextLength,
  createToolBridge = createPiToolBridge,
  eventToActions = piEventToActions
}) {
  session.activeReplyTarget = turn.replyTarget;
  session.startTyping(turn.replyTarget);
  session.resetTransientTurnState();

  let toolBridge = null;
  const state = {
    emittedError: false,
    currentSessionId: session.sessionId,
    completedTurn: false,
    resumeFailureMessage: null,
    stderrTail: ""
  };
  const isGroupTurn = turn.mode === "group";
  const initialSessionId = session.sessionId;
  const mayRetryFailedResume = Boolean(initialSessionId) && turn.resumeRetryCount === 0;

  try {
    const message = buildInputMessage(turn);
    const relayInstructions = buildRelayInstructions(turn, isGroupTurn);
    let developerInstructions;
    let additionalSystemPromptSnapshot;

    try {
      ({ developerInstructions, additionalSystemPromptSnapshot } =
        resolveAdditionalSystemPromptSnapshot(session, relayInstructions));
    } catch (error) {
      await session.renderErrorText(toErrorMessage(error), {
        replyTarget: turn.replyTarget
      });
      return;
    }

    try {
      toolBridge = await createToolBridge({
        session,
        isGroupTurn,
        replyTarget: turn.replyTarget,
        onSchedulesChanged: session.onSchedulesChanged,
        onToolCall: session.onPiToolCall,
        disableScheduleTools: false
      });
    } catch (error) {
      await session.renderErrorText(`Failed to start Pi tool bridge: ${toErrorMessage(error)}`, {
        replyTarget: turn.replyTarget
      });
      return;
    }

    const buildArgParams = {
      sessionId: session.sessionId,
      message,
      autoMode: session.auto,
      model: session.model,
      reasoningEffort: session.reasoningEffort,
      developerInstructions
    };
    const runParams = {
      workdir: session.workdir,
      extraEnv: toolBridge.env,
      ...buildArgParams
    };
    const redactedArgs = redactDebugArgs(
      buildPiArgs(buildArgParams),
      message.length,
      String(developerInstructions ?? "").length
    );
    session.logger(
      `starting ${PI_RUN_ID} run ${JSON.stringify({
        sessionId: session.sessionId,
        attachments: (turn.attachments ?? []).map((attachment) => ({
          kind: attachment.kind,
          localPath: attachment.localPath
        })),
        args: redactedArgs
      })}`
    );

    const run = createAgentRun({
      ...runParams,
      onEvent: async (event) => {
        const actions = eventToActions(event);
        for (const action of actions) {
          await handlePiAction({
            action,
            session,
            turn,
            isGroupTurn,
            mayRetryFailedResume,
            additionalSystemPromptSnapshot,
            state
          });
        }
      },
      onStdErr: (chunk) => {
        const stderrText = String(chunk);
        state.stderrTail = appendTextTail(state.stderrTail, stderrText);
        const stderrMessage = stderrText.trim();
        if (stderrMessage) {
          session.logger(`${PI_RUN_ID} stderr: ${stderrMessage}`);
        }
      }
    });

    session.activeRun = run;

    const result = await run.done;
    if (result.aborted) {
      return;
    }

    await updateContextLengthAfterCompletedTurn({
      session,
      currentSessionId: state.currentSessionId,
      completedTurn: state.completedTurn,
      resolveContextLength
    });

    if (state.completedTurn) {
      await session.clearProgressMessage();
    }

    if (!result.sawTerminalEvent && !state.emittedError && !state.resumeFailureMessage) {
      await session.renderErrorText(
        `${PI_RUN_DISPLAY_NAME} exited without a terminal JSON event.`,
        { replyTarget: turn.replyTarget }
      );
    }
  } catch (error) {
    const processErrorText = `${PI_RUN_DISPLAY_NAME} process error: ${withStderrContext(
      toErrorMessage(error),
      state.stderrTail
    )}`;
    if (mayRetryFailedResume && looksLikeResumeFailure(processErrorText)) {
      state.resumeFailureMessage = processErrorText;
    } else {
      await session.renderErrorText(processErrorText, {
        replyTarget: turn.replyTarget
      });
    }
  } finally {
    cleanupTurn(session, toolBridge);
    if (state.resumeFailureMessage) {
      await handleResumeFailure({ session, turn });
    }
  }
}
