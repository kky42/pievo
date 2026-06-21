import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum, Type } from "@earendil-works/pi-ai";

import { loadToolPromptCatalog } from "../prompts/index.js";
import { formatUtcOffset } from "../utils.js";

const ATTACHMENT_KINDS = ["document", "photo", "video", "audio", "voice", "animation"];
const SCHEDULE_MODES = ["heartbeat", "background"];
const SCHEDULE_TRIGGERS = ["cron", "once"];
const TOOL_PROMPTS = loadToolPromptCatalog();

function chatMode() {
	return process.env.PIEVO_CHAT_MODE === "group" ? "group" : "private";
}

function scheduleToolsEnabled() {
	return process.env.PIEVO_DISABLE_SCHEDULE_TOOLS !== "1";
}

function fallbackUtcOffset() {
	return formatUtcOffset(-new Date().getTimezoneOffset());
}

function promptValue(key: string) {
	switch (key) {
		case "local_timezone":
			return process.env.PIEVO_LOCAL_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
		case "local_utc_offset":
			return process.env.PIEVO_LOCAL_UTC_OFFSET || fallbackUtcOffset();
		default:
			return null;
	}
}

function interpolateToolPromptText(value: unknown) {
	return String(value ?? "").replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (match, key) => promptValue(key) ?? match);
}

function toolPrompt(toolName: string) {
	const prompt = TOOL_PROMPTS[toolName] ?? {};
	return {
		label: interpolateToolPromptText(prompt.label ?? toolName),
		description: interpolateToolPromptText(prompt.description ?? toolName),
		promptSnippet: prompt.promptSnippet ? interpolateToolPromptText(prompt.promptSnippet) : prompt.promptSnippet,
		promptGuidelines: [
			...(Array.isArray(prompt.promptGuidelines) ? prompt.promptGuidelines : []),
			...(chatMode() === "group" && Array.isArray(prompt.groupPromptGuidelines)
				? prompt.groupPromptGuidelines
				: []),
			...(chatMode() === "private" && Array.isArray(prompt.privatePromptGuidelines)
				? prompt.privatePromptGuidelines
				: []),
		].map(interpolateToolPromptText),
	};
}

function parameterDescription(toolName: string, parameterName: string) {
	return interpolateToolPromptText(TOOL_PROMPTS[toolName]?.parameters?.[parameterName]?.description ?? parameterName);
}

async function callBridge(tool: string, params: unknown, signal?: AbortSignal) {
	const url = process.env.PIEVO_TOOL_BRIDGE_URL;
	const token = process.env.PIEVO_TOOL_BRIDGE_TOKEN;
	if (!url || !token) {
		throw new Error("Pievo tool bridge is not available for this run.");
	}

	const response = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({ tool, params }),
		signal,
	});

	let body: any = null;
	try {
		body = await response.json();
	} catch {
		// handled below
	}

	if (!response.ok || !body?.ok) {
		throw new Error(body?.error || `Pievo tool bridge request failed (${response.status})`);
	}

	return body;
}

function bridgeResult(body: any, fallbackText: string, terminate = false) {
	return {
		content: [{ type: "text" as const, text: String(body?.text || fallbackText) }],
		details: body?.details ?? {},
		terminate: Boolean(body?.terminate ?? terminate),
	};
}

export default function pievoChatTools(pi: ExtensionAPI) {
	if (chatMode() === "group") {
		const prompt = toolPrompt("send_reply");
		pi.registerTool({
			name: "send_reply",
			label: prompt.label,
			description: prompt.description,
			promptSnippet: prompt.promptSnippet,
			promptGuidelines: prompt.promptGuidelines,
			parameters: Type.Object({
				text: Type.String({ description: parameterDescription("send_reply", "text") }),
			}),
			async execute(_toolCallId, params, signal) {
				const body = await callBridge("send_reply", params, signal);
				return bridgeResult(body, "Reply sent.", true);
			},
		});
	}

	{
		const prompt = toolPrompt("send_attachment");
		pi.registerTool({
			name: "send_attachment",
			label: prompt.label,
			description: prompt.description,
			promptSnippet: prompt.promptSnippet,
			promptGuidelines: prompt.promptGuidelines,
			parameters: Type.Object({
				path: Type.String({ description: parameterDescription("send_attachment", "path") }),
				kind: Type.Optional(StringEnum(ATTACHMENT_KINDS, { description: parameterDescription("send_attachment", "kind") })),
				caption: Type.Optional(Type.String({ description: parameterDescription("send_attachment", "caption") })),
			}),
			async execute(_toolCallId, params, signal) {
				const body = await callBridge("send_attachment", params, signal);
				return bridgeResult(body, "Attachment sent.", true);
			},
		});
	}

	if (scheduleToolsEnabled()) {
		{
			const prompt = toolPrompt("add_schedule");
			pi.registerTool({
				name: "add_schedule",
				label: prompt.label,
				description: prompt.description,
				promptSnippet: prompt.promptSnippet,
				promptGuidelines: prompt.promptGuidelines,
				parameters: Type.Object({
					mode: StringEnum(SCHEDULE_MODES, { description: parameterDescription("add_schedule", "mode") }),
					name: Type.String({ description: parameterDescription("add_schedule", "name") }),
					trigger: Type.Optional(StringEnum(SCHEDULE_TRIGGERS, { description: parameterDescription("add_schedule", "trigger") })),
					cron: Type.Optional(Type.String({ description: parameterDescription("add_schedule", "cron") })),
					run_at: Type.Optional(Type.String({ description: parameterDescription("add_schedule", "run_at") })),
					task: Type.String({ description: parameterDescription("add_schedule", "task") }),
				}),
				async execute(_toolCallId, params, signal) {
					const body = await callBridge("add_schedule", params, signal);
					return bridgeResult(body, "Schedule added.");
				},
			});
		}

		{
			const prompt = toolPrompt("list_schedule");
			pi.registerTool({
				name: "list_schedule",
				label: prompt.label,
				description: prompt.description,
				promptSnippet: prompt.promptSnippet,
				promptGuidelines: prompt.promptGuidelines,
				parameters: Type.Object({}),
				async execute(_toolCallId, params, signal) {
					const body = await callBridge("list_schedule", params, signal);
					return bridgeResult(body, "Schedules listed.");
				},
			});
		}

		{
			const prompt = toolPrompt("remove_schedule");
			pi.registerTool({
				name: "remove_schedule",
				label: prompt.label,
				description: prompt.description,
				promptSnippet: prompt.promptSnippet,
				promptGuidelines: prompt.promptGuidelines,
				parameters: Type.Object({
					name: Type.String({ description: parameterDescription("remove_schedule", "name") }),
				}),
				async execute(_toolCallId, params, signal) {
					const body = await callBridge("remove_schedule", params, signal);
					return bridgeResult(body, "Schedule removed.");
				},
			});
		}
	}
}
