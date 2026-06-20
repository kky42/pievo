import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AUTO_DEFAULT } from "./auto-mode.js";
import {
  DEFAULT_CONFIG_PATH,
  ensureDir,
  normalizeAgentId,
  writeJsonFileAtomic
} from "./utils.js";
import {
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT
} from "./runtime-settings.js";

async function pathExists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function buildCanonicalAgentConfig({ workdir = os.homedir() } = {}) {
  return {
    profile: {
      workdir: path.resolve(workdir),
      auto: AUTO_DEFAULT,
      model: DEFAULT_MODEL,
      reasoningEffort: DEFAULT_REASONING_EFFORT
    },
    bindings: {
      telegram: {
        allowedUsernames: ["your-telegram-username"],
        managerUsernames: ["your-telegram-username"],
        bots: []
      },
      mattermost: {
        allowedUsernames: ["your-mattermost-username"],
        managerUsernames: ["your-mattermost-username"],
        bots: []
      }
    }
  };
}

export async function addAgentConfig({
  agentId,
  configPath = DEFAULT_CONFIG_PATH,
  homeDir = os.homedir()
}) {
  const normalizedAgentId = normalizeAgentId(agentId, "agent-name");
  const agentsRoot = path.resolve(configPath);
  if (path.basename(agentsRoot) === "config.json") {
    throw new Error("pievo add requires --config to point to an agents directory.");
  }

  const agentDir = path.join(agentsRoot, normalizedAgentId);
  const configFilePath = path.join(agentDir, "config.json");
  await ensureDir(agentsRoot, { mode: 0o700, chmod: true });
  if (await pathExists(agentDir)) {
    throw new Error(`Agent directory already exists: ${agentDir}`);
  }

  await ensureDir(agentDir, { mode: 0o700, chmod: true });
  await writeJsonFileAtomic(
    configFilePath,
    buildCanonicalAgentConfig({
      workdir: homeDir
    }),
    { mode: 0o600 }
  );

  return {
    agentId: normalizedAgentId,
    agentDir,
    configFilePath
  };
}
