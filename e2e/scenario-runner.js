import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { ChatSession } from "../src/chat_adapter/common/chat-session.js";
import { ConversationStateStore } from "../src/chat_adapter/common/conversation-state.js";
import { buildGroupInputMessage } from "../src/chat_adapter/common/group-turn.js";
import {
  buildHeartbeatGroupTranscriptMessage,
  buildHeartbeatPrivatePrompt
} from "../src/chat_adapter/common/schedules.js";
import { startPiRun } from "../src/pi_run/runner.js";
import { DEFAULT_MODEL, DEFAULT_REASONING_EFFORT } from "../src/runtime-settings.js";
import { sleep, toErrorMessage } from "../src/utils.js";
import { assertExpectations } from "./scenario-assertions.js";
import { normalizeStepMessages, sanitizeFileName, stepAttachments, writeScenarioFiles } from "./scenario-format.js";
import { createEventRecorder, ScenarioOutput } from "./scenario-output.js";

async function waitForIdle(session, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (session.isRunning || session.queue.length > 0) {
    if (Date.now() > deadline) {
      await session.abortCurrentRun().catch(() => {});
      throw new Error(`Timed out after ${timeoutMs}ms waiting for agent turn`);
    }
    await sleep(250);
  }
}

function hasExplicitPrompt(step) {
  return Object.prototype.hasOwnProperty.call(step ?? {}, "prompt");
}

export async function runStep({ scenario, step, stepIndex, session, workdir, state }) {
  const stepId = String(step.id ?? `step-${stepIndex + 1}`);
  state.currentStepId = stepId;
  const startEventIndex = state.events.length;
  const startedAt = Date.now();

  try {
    await writeScenarioFiles(workdir, step.files ?? []);

    if (step.triggerSchedule) {
      const triggerSpec = step.triggerSchedule;
      const scheduleName = typeof triggerSpec === "string" ? triggerSpec.trim() : "";
      const scheduleMatch = triggerSpec && typeof triggerSpec === "object" && !Array.isArray(triggerSpec)
        ? triggerSpec
        : null;
      const schedule = scheduleName
        ? session.schedules.find((candidate) => candidate.name === scheduleName)
        : session.schedules.find((candidate) => Object.entries(scheduleMatch ?? {}).every(
            ([key, value]) => candidate?.[key] === value
          ));
      if (!schedule) {
        throw new Error(`triggerSchedule: no matching schedule ${JSON.stringify(triggerSpec)}`);
      }
      if (schedule.mode !== "heartbeat") {
        throw new Error(`triggerSchedule: schedule ${scheduleName} is ${schedule.mode}, not heartbeat`);
      }
      if (scenario.mode === "private") {
        await session.enqueueTurn({
          mode: "private",
          promptText: buildHeartbeatPrivatePrompt(schedule.name, schedule.prompt),
          attachments: [],
          replyTarget: null,
          scheduleName: schedule.name,
          suppressQueueNotice: true
        });
      } else {
        await session.enqueueTurn({
          mode: "group",
          groupInput: {
            messages: [buildHeartbeatGroupTranscriptMessage(schedule.name, schedule.prompt)]
          },
          groupIdentity: {
            botName: scenario.bot?.name ?? "Pievo",
            botHandle: scenario.bot?.handle ?? "@relaybot"
          },
          attachments: [],
          replyTarget: scenario.replyTarget ?? null,
          scheduleName: schedule.name,
          suppressQueueNotice: true
        });
      }
    } else if (scenario.mode === "private") {
      const promptText = String(step.prompt ?? step.text ?? "").trim();
      await session.enqueueTurn({
        mode: "private",
        promptText,
        attachments: stepAttachments(step, workdir),
        replyTarget: null
      });
    } else {
      const attachments = stepAttachments(step, workdir);
      const explicitPrompt = hasExplicitPrompt(step);
      const messages = explicitPrompt ? null : normalizeStepMessages(step, stepIndex, { attachments });
      const promptText = explicitPrompt
        ? String(step.prompt ?? "").trim()
        : buildGroupInputMessage({ messages });
      await session.enqueueTurn({
        mode: "group",
        promptText,
        ...(messages ? { groupInput: { messages } } : {}),
        groupIdentity: {
          botName: scenario.bot?.name ?? "Pievo",
          botHandle: scenario.bot?.handle ?? "@relaybot"
        },
        attachments: messages ? [] : attachments,
        replyTarget: scenario.replyTarget ?? null,
        mergeKey: null
      });
    }

    await waitForIdle(session, Number(step.timeoutMs ?? state.timeoutMs));
    const durationMs = Date.now() - startedAt;
    const stepEvents = state.events.slice(startEventIndex).filter((event) => event.stepId === stepId);
    const result = { id: stepId, durationMs, events: stepEvents };
    assertExpectations({ scenario, step, stepResult: result, session });
    return result;
  } finally {
    state.currentStepId = null;
  }
}

export async function runScenario(scenario, options) {
  const safeScenarioName = sanitizeFileName(scenario.name);
  const runDir = options.outDir
    ? path.resolve(options.outDir, safeScenarioName)
    : path.resolve(await fs.mkdtemp(path.join(os.tmpdir(), `pievo-e2e-${safeScenarioName}-`)));
  await fs.mkdir(runDir, { recursive: true });
  const workdir = path.join(runDir, "workdir");
  const cacheRootDir = path.join(runDir, "cache");
  const stateRootDir = path.join(runDir, "state");
  const piSessionDir = path.join(runDir, "pi-sessions");
  await fs.mkdir(workdir, { recursive: true });
  await fs.mkdir(piSessionDir, { recursive: true });
  await writeScenarioFiles(workdir, scenario.files ?? []);

  const events = [];
  const logs = [];
  const state = {
    currentStepId: null,
    events,
    timeoutMs: options.timeoutMs
  };
  const record = createEventRecorder(state);

  const output = new ScenarioOutput(record);
  const model = options.model || scenario.model || DEFAULT_MODEL;
  const reasoningEffort = options.reasoningEffort || scenario.reasoningEffort || DEFAULT_REASONING_EFFORT;
  const agent = {
    id: safeScenarioName,
    workdir,
    auto: scenario.auto || "medium",
    model,
    reasoningEffort,
    profileInstructionsPath: path.join(runDir, "AGENTS.md")
  };
  if (scenario.profileInstructions) {
    await fs.writeFile(agent.profileInstructionsPath, String(scenario.profileInstructions), "utf8");
  }

  const session = new ChatSession({
    bindingConfig: {
      platform: "e2e",
      bindingId: safeScenarioName,
      agent
    },
    output,
    logger: (message) => logs.push({ stepId: state.currentStepId, at: new Date().toISOString(), message }),
    platform: "e2e",
    bindingId: safeScenarioName,
    conversationId: `${safeScenarioName}:${scenario.mode ?? "group"}`,
    cacheRootDir,
    stateStore: new ConversationStateStore({ rootDir: stateRootDir }),
    createAgentRun: (params) => startPiRun({
      ...params,
      disableAmbientResources: true,
      sessionDir: piSessionDir,
      extraEnv: {
        ...params.extraEnv
      }
    }),
    onSchedulesChanged: () => {},
    onPiToolCall: ({ tool, params }) => record("tool_call", { tool, params })
  });

  const stepResults = [];
  let failure = null;
  try {
    for (let index = 0; index < scenario.steps.length; index += 1) {
      const step = scenario.steps[index];
      process.stderr.write(`→ ${scenario.name}/${step.id ?? `step-${index + 1}`}\n`);
      const result = await runStep({ scenario, step, stepIndex: index, session, workdir, state });
      stepResults.push(result);
      if (options.verbose) {
        process.stderr.write(`${JSON.stringify(result.events, null, 2)}\n`);
      }
      process.stderr.write(`✓ ${scenario.name}/${result.id} (${(result.durationMs / 1000).toFixed(1)}s)\n`);
    }
  } catch (error) {
    failure = toErrorMessage(error);
  }

  const report = {
    scenario: scenario.name,
    scenarioFile: scenario.__filePath,
    mode: scenario.mode ?? "group",
    model,
    reasoningEffort,
    runDir,
    workdir,
    piSessionDir,
    steps: stepResults,
    schedules: session.schedules,
    logs,
    events,
    failure
  };
  const reportPath = path.join(runDir, "report.json");
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (failure) {
    throw new Error(`${failure}; report: ${reportPath}`);
  }
  return report;
}
