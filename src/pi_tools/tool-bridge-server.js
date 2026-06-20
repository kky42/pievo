import crypto from "node:crypto";
import http from "node:http";

import { parseCronExpression } from "../chat_adapter/common/cron.js";
import {
  buildScheduleConfirmation,
  buildScheduleListText,
  SCHEDULE_MODES,
  validateScheduleName
} from "../chat_adapter/common/schedules.js";
import { toErrorMessage } from "../utils.js";

const MAX_REQUEST_BYTES = 1024 * 1024;
const SCHEDULE_TOOLS = new Set(["add_schedule", "list_schedule", "remove_schedule"]);

let bridgeState = null;

function jsonResponse(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_REQUEST_BYTES) {
        reject(new Error("Tool bridge request body is too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function bearerToken(request) {
  const header = String(request.headers.authorization ?? "").trim();
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : "";
}

async function handleBridgeRequest(request, response, handlers) {
  if (request.method !== "POST" || request.url !== "/tool") {
    jsonResponse(response, 404, { ok: false, error: "Not found." });
    return;
  }

  const token = bearerToken(request);
  const handler = handlers.get(token);
  if (!handler) {
    jsonResponse(response, 401, { ok: false, error: "Unauthorized tool bridge request." });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(await readRequestBody(request));
  } catch (error) {
    jsonResponse(response, 400, { ok: false, error: toErrorMessage(error) });
    return;
  }

  try {
    const result = await handler(payload);
    jsonResponse(response, 200, { ok: true, ...result });
  } catch (error) {
    jsonResponse(response, 500, { ok: false, error: toErrorMessage(error) });
  }
}

async function ensureBridgeServer() {
  if (bridgeState) {
    return bridgeState;
  }

  const handlers = new Map();
  const server = http.createServer((request, response) => {
    void handleBridgeRequest(request, response, handlers);
  });
  server.unref?.();

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not start Pievo tool bridge server.");
  }

  bridgeState = {
    server,
    handlers,
    url: `http://127.0.0.1:${address.port}/tool`
  };
  return bridgeState;
}

function normalizeToolPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Tool bridge payload must be a JSON object.");
  }
  const tool = String(payload.tool ?? "").trim();
  if (!tool) {
    throw new Error("Tool bridge payload missing tool name.");
  }
  const params = payload.params && typeof payload.params === "object" && !Array.isArray(payload.params)
    ? payload.params
    : {};
  return { tool, params };
}

function normalizeScheduleMode(mode) {
  const normalized = String(mode ?? "").trim().toLowerCase();
  if (!SCHEDULE_MODES.has(normalized)) {
    throw new Error("Schedule mode must be \"heartbeat\" or \"background\".");
  }
  return normalized;
}

function normalizeCron(cron) {
  const normalized = String(cron ?? "").trim();
  parseCronExpression(normalized);
  return normalized;
}

function normalizeScheduleTask(task) {
  const normalized = String(task ?? "").trim();
  if (!normalized) {
    throw new Error("Schedule task is required.");
  }
  return normalized;
}

function normalizeAttachmentKind(kind) {
  const normalized = String(kind ?? "document").trim().toLowerCase() || "document";
  return normalized;
}

async function notifySchedulesChanged(callback, session) {
  if (typeof callback === "function") {
    await callback(session);
  }
}

async function dispatchTool({
  payload,
  session,
  isGroupTurn,
  replyTarget,
  onSchedulesChanged,
  onToolCall,
  disableScheduleTools = false
}) {
  const { tool, params } = normalizeToolPayload(payload);
  if (disableScheduleTools && SCHEDULE_TOOLS.has(tool)) {
    throw new Error("Schedule tools are disabled for scheduled runs.");
  }
  if (typeof onToolCall === "function") {
    await onToolCall({ tool, params });
  }

  switch (tool) {
    case "send_reply": {
      if (!isGroupTurn) {
        throw new Error("send_reply is only available in group chats.");
      }
      const text = String(params.text ?? "").trim();
      if (!text) {
        throw new Error("send_reply.text is required.");
      }
      await session.sendText(text, { replyTarget });
      return {
        text: "Reply sent.",
        terminate: true,
        details: { delivered: true }
      };
    }

    case "send_attachment": {
      const filePath = String(params.path ?? "").trim();
      if (!filePath) {
        throw new Error("send_attachment.path is required.");
      }
      await session.output.sendNativeAttachment({
        path: filePath,
        kind: normalizeAttachmentKind(params.kind),
        fileName: String(params.fileName ?? "").trim() || null,
        caption: String(params.caption ?? "").trim() || null
      }, {
        workdir: session.workdir,
        replyTarget
      });
      return {
        text: "Attachment sent.",
        terminate: true,
        details: { delivered: true, path: filePath }
      };
    }

    case "add_schedule": {
      const schedule = {
        mode: normalizeScheduleMode(params.mode),
        name: validateScheduleName(params.name),
        cron: normalizeCron(params.cron),
        prompt: normalizeScheduleTask(params.task ?? params.prompt),
        enabled: true
      };
      if (session.schedules.some((candidate) => candidate.name === schedule.name)) {
        throw new Error(`Schedule "${schedule.name}" already exists.`);
      }
      await session.replaceSchedules([...session.schedules, schedule]);
      await notifySchedulesChanged(onSchedulesChanged, session);
      return {
        text: buildScheduleConfirmation("Added", schedule),
        details: { schedule }
      };
    }

    case "list_schedule": {
      return {
        text: buildScheduleListText(session.schedules),
        details: { schedules: session.schedules }
      };
    }

    case "remove_schedule": {
      const name = validateScheduleName(params.name);
      const schedule = session.schedules.find((candidate) => candidate.name === name);
      if (!schedule) {
        throw new Error(`Schedule "${name}" does not exist.`);
      }
      await session.replaceSchedules(session.schedules.filter((candidate) => candidate.name !== name));
      session.removeQueuedScheduledTurns(name);
      await notifySchedulesChanged(onSchedulesChanged, session);
      return {
        text: buildScheduleConfirmation("Removed", schedule),
        details: { schedule }
      };
    }

    default:
      throw new Error(`Unknown Pievo tool: ${tool}`);
  }
}

export async function createPiToolBridge({
  session,
  isGroupTurn,
  replyTarget = null,
  onSchedulesChanged = null,
  onToolCall = null,
  disableScheduleTools = false
}) {
  const bridge = await ensureBridgeServer();
  const token = crypto.randomBytes(32).toString("hex");

  bridge.handlers.set(token, (payload) => dispatchTool({
    payload,
    session,
    isGroupTurn,
    replyTarget,
    onSchedulesChanged,
    onToolCall,
    disableScheduleTools
  }));

  return {
    env: {
      PIEVO_TOOL_BRIDGE_URL: bridge.url,
      PIEVO_TOOL_BRIDGE_TOKEN: token,
      PIEVO_CHAT_MODE: isGroupTurn ? "group" : "private",
      ...(disableScheduleTools ? { PIEVO_DISABLE_SCHEDULE_TOOLS: "1" } : {})
    },
    dispose() {
      bridge.handlers.delete(token);
    }
  };
}
