import {
  AUTO_DEFAULT,
  AUTO_LEVEL_HIGH,
  AUTO_LEVEL_LOW,
  AUTO_LEVEL_MEDIUM,
  normalizeAutoMode
} from "../auto-mode.js";
import {
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT,
  PI_CLI_DEFAULT_MODEL,
  PI_CLI_DEFAULT_REASONING_EFFORT
} from "../runtime-settings.js";

const PI_SANDBOX_MODES = {
  [AUTO_LEVEL_LOW]: "read-only",
  [AUTO_LEVEL_MEDIUM]: "workspace-write",
  [AUTO_LEVEL_HIGH]: "danger-full-access"
};

/**
 * @typedef {object} PiRunRequest
 * @property {string | null | undefined} [sessionId]
 * @property {string} message
 * @property {string} [autoMode]
 * @property {string} [model]
 * @property {string} [reasoningEffort]
 * @property {string | null | undefined} [developerInstructions]
 * @property {string | null | undefined} [sessionDir]
 * @property {boolean} [supportsSandboxFlag]
 * @property {string[]} [extensionPaths]
 * @property {boolean} [disableAmbientResources]
 */

/**
 * @param {PiRunRequest} request
 */
export function buildPiArgs({
  sessionId,
  message,
  autoMode = AUTO_DEFAULT,
  model = DEFAULT_MODEL,
  reasoningEffort = DEFAULT_REASONING_EFFORT,
  developerInstructions = null,
  sessionDir = null,
  supportsSandboxFlag = false,
  extensionPaths = [],
  disableAmbientResources = false
}) {
  const normalizedAutoMode = normalizeAutoMode(autoMode, "autoMode");
  const sandboxArgs = supportsSandboxFlag
    ? ["--sandbox", PI_SANDBOX_MODES[normalizedAutoMode]]
    : [];
  const modelArgs = model === PI_CLI_DEFAULT_MODEL ? [] : ["--model", model];
  const reasoningArgs =
    reasoningEffort === PI_CLI_DEFAULT_REASONING_EFFORT
      ? []
      : ["--thinking", reasoningEffort];
  const developerInstructionArgs = developerInstructions
    ? ["--append-system-prompt", developerInstructions]
    : [];
  const sessionDirArgs = sessionDir ? ["--session-dir", sessionDir] : [];
  const sessionArgs = sessionId ? ["--session", sessionId] : [];
  const extensionArgs = extensionPaths.flatMap((extensionPath) => ["--extension", extensionPath]);
  const ambientResourceArgs = disableAmbientResources
    ? ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"]
    : [];

  return [
    "-p",
    "--approve",
    "--mode",
    "json",
    ...ambientResourceArgs,
    ...sessionDirArgs,
    ...sandboxArgs,
    ...modelArgs,
    ...reasoningArgs,
    ...developerInstructionArgs,
    ...extensionArgs,
    ...sessionArgs,
    message
  ];
}
