import fs from "node:fs";

export function readPrompt(relativePath) {
  return fs.readFileSync(new URL(relativePath, import.meta.url), "utf8").trim();
}

export function interpolatePrompt(template, values = {}) {
  return String(template ?? "").replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (match, key) => {
    const value = values?.[key];
    return value === null || value === undefined ? match : String(value);
  });
}

export function renderPrompt(relativePath, values = {}) {
  return interpolatePrompt(readPrompt(relativePath), values).trim();
}

export function readPromptJson(relativePath) {
  return JSON.parse(fs.readFileSync(new URL(relativePath, import.meta.url), "utf8"));
}

export function loadToolPromptCatalog() {
  return readPromptJson("tools/chat-tools.json");
}
