import { formatAuto, parseAutoArgument } from "../../auto-mode.js";
import { normalizeSettingArgument } from "../../runtime-settings.js";
import {
  expandWorkdirPath,
  formatTokenCountK,
  INVALID_WORKDIR_MESSAGE,
  resolveWorkdirPath,
  toErrorMessage
} from "../../utils.js";
import { renderStatusMessage } from "./render.js";
import { prepareForSessionReset } from "./session-reset.js";

const PI_RUN_DISPLAY_NAME = "Pi";

export function workdirValidationError() {
  return `Invalid workdir. ${INVALID_WORKDIR_MESSAGE}`;
}

export async function resolveRequestedWorkdir(args) {
  try {
    return await resolveWorkdirPath(args, {
      homeDir: this.resolveHomeDir ? this.resolveHomeDir() : undefined
    });
  } catch (error) {
    if (error instanceof Error && error.message === INVALID_WORKDIR_MESSAGE) {
      throw new Error(this.workdirValidationError());
    }
    throw error;
  }
}

export async function handleWorkdir(args, options = {}) {
  const requestedWorkdir = normalizeSettingArgument(args);
  if (!requestedWorkdir) {
    await this.sendText(`Current workdir: ${this.workdir}.`, options);
    return;
  }

  const homeDir = this.resolveHomeDir ? this.resolveHomeDir() : undefined;
  let normalizedWorkdir;
  try {
    normalizedWorkdir = expandWorkdirPath(requestedWorkdir, { homeDir });
  } catch (error) {
    if (error instanceof Error && error.message === INVALID_WORKDIR_MESSAGE) {
      await this.sendText(this.workdirValidationError(), options);
      return;
    }
    await this.sendText(toErrorMessage(error), options);
    return;
  }

  if (normalizedWorkdir === this.workdir) {
    await this.sendText(`Workdir is already set to ${normalizedWorkdir}.`, options);
    return;
  }

  let nextWorkdir;
  try {
    nextWorkdir = await this.resolveRequestedWorkdir(normalizedWorkdir);
  } catch (error) {
    await this.sendText(toErrorMessage(error), options);
    return;
  }

  await prepareForSessionReset(this);
  await this.applyRuntimeSettings({ workdir: nextWorkdir });
  await this.clearSessionState();

  await this.sendText(
    `Workdir set to ${nextWorkdir}. Started a new session. The next message will open a fresh ${PI_RUN_DISPLAY_NAME} session.`,
    options
  );
}

export function statusText() {
  return renderStatusMessage({
    isRunning: this.isRunning,
    workdir: this.workdir,
    auto: this.auto,
    model: this.model,
    reasoningEffort: this.reasoningEffort,
    usage: {
      contextLength: formatTokenCountK(this.contextLength)
    },
    queue: this.queue,
    schedules: this.schedules
  });
}

export async function handleStatus(options = {}) {
  await this.sendText(this.statusText(), options);
}

export async function handleAuto(args, options = {}) {
  const normalized = String(args || "").trim();
  if (!normalized) {
    await this.sendText(`Current auto level: ${formatAuto(this.auto)}.`, options);
    return;
  }

  const nextAuto = parseAutoArgument(normalized);
  if (nextAuto === null) {
    await this.sendText(
      "Unknown auto level. Use /auto, /auto low, /auto medium, or /auto high.",
      options
    );
    return;
  }

  const previousAuto = this.auto;
  try {
    await this.applyRuntimeSettings({ auto: nextAuto });
  } catch (error) {
    await this.sendText(`Failed to persist auto level: ${toErrorMessage(error)}`, options);
    return;
  }

  if (this.isRunning) {
    await this.sendText(
      `Auto level set to ${formatAuto(nextAuto)}. The current run stays on ${formatAuto(previousAuto)}; the next run will use ${formatAuto(nextAuto)}.`,
      options
    );
    return;
  }

  await this.sendText(`Auto level set to ${formatAuto(nextAuto)}.`, options);
}

export async function handleModel(args, options = {}) {
  const nextModel = normalizeSettingArgument(args);
  if (!nextModel) {
    await this.sendText(`Current model: ${this.model}.`, options);
    return;
  }

  const previousModel = this.model;
  try {
    await this.applyRuntimeSettings({ model: nextModel });
  } catch (error) {
    await this.sendText(`Failed to persist model setting: ${toErrorMessage(error)}`, options);
    return;
  }

  if (this.isRunning) {
    await this.sendText(
      `Model set to ${nextModel}. The current run stays on ${previousModel}; the next run will use ${nextModel}.`,
      options
    );
    return;
  }

  await this.sendText(`Model set to ${nextModel}.`, options);
}

export async function handleReasoningEffort(args, options = {}) {
  const nextReasoningEffort = normalizeSettingArgument(args);
  if (!nextReasoningEffort) {
    await this.sendText(`Current reasoning effort: ${this.reasoningEffort}.`, options);
    return;
  }

  const previousReasoningEffort = this.reasoningEffort;
  try {
    await this.applyRuntimeSettings({ reasoningEffort: nextReasoningEffort });
  } catch (error) {
    await this.sendText(
      `Failed to persist reasoning effort setting: ${toErrorMessage(error)}`,
      options
    );
    return;
  }

  if (this.isRunning) {
    await this.sendText(
      `Reasoning effort set to ${nextReasoningEffort}. The current run stays on ${previousReasoningEffort}; the next run will use ${nextReasoningEffort}.`,
      options
    );
    return;
  }

  await this.sendText(`Reasoning effort set to ${nextReasoningEffort}.`, options);
}

const SESSION_SETTINGS_METHODS = {
  workdirValidationError,
  resolveRequestedWorkdir,
  handleWorkdir,
  statusText,
  handleStatus,
  handleAuto,
  handleModel,
  handleReasoningEffort
};

export function installSessionSettingsMethods(ChatSessionClass) {
  for (const [name, value] of Object.entries(SESSION_SETTINGS_METHODS)) {
    Object.defineProperty(ChatSessionClass.prototype, name, {
      value,
      writable: true,
      configurable: true
    });
  }
}
