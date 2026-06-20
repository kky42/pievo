import fs from "node:fs/promises";
import path from "node:path";

import { parseYamlScenario } from "./scenario-yaml.js";

export const DEFAULT_TIMEOUT_MS = 180_000;
export const DEFAULT_SCENARIOS_DIR = path.join("e2e", "scenarios");

export async function defaultScenarioPaths({ scenariosDir = DEFAULT_SCENARIOS_DIR } = {}) {
  const resolvedScenariosDir = path.resolve(scenariosDir);
  let entries;
  try {
    entries = await fs.readdir(resolvedScenariosDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
    .map((entry) => path.join(resolvedScenariosDir, entry.name))
    .sort();
}

export function applyScenarioDefaults(scenario, filePath) {
  const normalized = scenario && typeof scenario === "object" ? scenario : {};
  normalized.__filePath = path.resolve(filePath);
  if (!normalized.name) {
    normalized.name = path.basename(filePath).replace(/\.ya?ml$/i, "");
  }
  if (!Array.isArray(normalized.steps) || normalized.steps.length === 0) {
    throw new Error(`${filePath} must define at least one step`);
  }
  normalized.mode = normalized.mode === "private" ? "private" : "group";
  return normalized;
}

export async function loadScenario(filePath) {
  const source = await fs.readFile(filePath, "utf8");
  return applyScenarioDefaults(parseYamlScenario(source), filePath);
}
