import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { DEFAULT_STATE_PATH, ensureDir, readJsonFile, writeJsonFileAtomic } from "../../utils.js";
import { buildCacheScope } from "./cache-scope.js";
import { normalizeStateRecord, normalizeString } from "./conversation-state-schema.js";

function writeJsonFileAtomicSync(filePath, value) {
  fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
  const content = `${JSON.stringify(value, null, 2)}\n`;
  try {
    fsSync.writeFileSync(tempPath, content, "utf8");
    fsSync.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fsSync.unlinkSync(tempPath);
    } catch {
      // Ignore best-effort cleanup failures and report the original persistence error.
    }
    throw error;
  }
}

function scopeRecord(scope) {
  return {
    agentId: scope.agentId,
    platform: scope.platform,
    bindingId: scope.bindingId,
    conversationId: scope.conversationId,
    scopeKey: scope.scopeKey
  };
}

export class ConversationStateStore {
  constructor({ rootDir = DEFAULT_STATE_PATH } = {}) {
    this.rootDir = rootDir;
  }

  scopeFor({ agentId, platform, bindingId, conversationId }) {
    return buildCacheScope({
      cacheRootDir: this.rootDir,
      agentId,
      platform,
      bindingId,
      conversationId
    });
  }

  scopeDir(scope) {
    return path.join(this.rootDir, scope.scopeHash);
  }

  scopeJsonPath(scope) {
    return path.join(this.scopeDir(scope), "scope.json");
  }

  stateJsonPath(scope) {
    return path.join(this.scopeDir(scope), "state.json");
  }

  async loadRecord(scope) {
    const record = await readJsonFile(this.stateJsonPath(scope), null);
    return normalizeStateRecord(record, scope);
  }

  loadRecordSync(scope) {
    let record = null;
    try {
      const content = fsSync.readFileSync(this.stateJsonPath(scope), "utf8");
      record = JSON.parse(content);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    return normalizeStateRecord(record, scope);
  }

  async saveRecord(scope, record) {
    const normalizedRecord = normalizeStateRecord(record, scope);
    await ensureDir(this.scopeDir(scope));
    await writeJsonFileAtomic(this.scopeJsonPath(scope), scopeRecord(scope));
    await writeJsonFileAtomic(this.stateJsonPath(scope), normalizedRecord);
  }

  saveRecordSync(scope, record) {
    const normalizedRecord = normalizeStateRecord(record, scope);
    fsSync.mkdirSync(this.scopeDir(scope), { recursive: true });
    writeJsonFileAtomicSync(this.scopeJsonPath(scope), scopeRecord(scope));
    writeJsonFileAtomicSync(this.stateJsonPath(scope), normalizedRecord);
  }

  async loadMatchingRecords(matchesScope, options = {}) {
    const onError = options.onError ?? (() => {});
    let entries = [];
    try {
      entries = await fs.readdir(this.rootDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const records = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const scopeJsonPath = path.join(this.rootDir, entry.name, "scope.json");
      const stateJsonPath = path.join(this.rootDir, entry.name, "state.json");
      try {
        const scopeJson = await readJsonFile(scopeJsonPath, null);
        if (!scopeJson || typeof scopeJson !== "object" || Array.isArray(scopeJson)) {
          continue;
        }
        const scope = this.scopeFor({
          agentId: scopeJson.agentId,
          platform: scopeJson.platform,
          bindingId: scopeJson.bindingId,
          conversationId: scopeJson.conversationId
        });
        if (!matchesScope(scope)) {
          continue;
        }
        const stateJson = await readJsonFile(stateJsonPath, null);
        const record = normalizeStateRecord(stateJson, scope);
        records.push({ scope, record });
      } catch (error) {
        onError(error, { dirName: entry.name, scopeJsonPath, stateJsonPath });
      }
    }

    return records;
  }

  async loadBindingRecords({ agentId, platform, bindingId }, options = {}) {
    return this.loadMatchingRecords(
      (scope) =>
        scope.agentId === agentId &&
        scope.platform === platform &&
        scope.bindingId === bindingId,
      options
    );
  }

  async loadAgentRecords({ agentId }, options = {}) {
    const normalizedAgentId = normalizeString(agentId);
    if (!normalizedAgentId) {
      throw new Error("agent id must be a non-empty string");
    }

    return this.loadMatchingRecords((scope) => scope.agentId === normalizedAgentId, options);
  }
}
