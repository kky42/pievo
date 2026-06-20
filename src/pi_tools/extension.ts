import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum, Type } from "@earendil-works/pi-ai";

import { loadToolPromptCatalog } from "../prompts/index.js";

const ATTACHMENT_KINDS = ["document", "photo", "video", "audio", "voice", "animation"];
const SCHEDULE_MODES = ["heartbeat", "background"];
const TOOL_PROMPTS = loadToolPromptCatalog();

function chatMode() {
	return process.env.PIEVO_CHAT_MODE === "group" ? "group" : "private";
}

function toolPrompt(toolName: string) {
	const prompt = TOOL_PROMPTS[toolName] ?? {};
	return {
		label: prompt.label ?? toolName,
		description: prompt.description ?? toolName,
		promptSnippet: prompt.promptSnippet,
		promptGuidelines: [
			...(Array.isArray(prompt.promptGuidelines) ? prompt.promptGuidelines : []),
			...(chatMode() === "group" && Array.isArray(prompt.groupPromptGuidelines)
				? prompt.groupPromptGuidelines
				: []),
			...(chatMode() === "private" && Array.isArray(prompt.privatePromptGuidelines)
				? prompt.privatePromptGuidelines
				: []),
		],
	};
}

function parameterDescription(toolName: string, parameterName: string) {
	return TOOL_PROMPTS[toolName]?.parameters?.[parameterName]?.description ?? parameterName;
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
				fileName: Type.Optional(Type.String({ description: parameterDescription("send_attachment", "fileName") })),
				caption: Type.Optional(Type.String({ description: parameterDescription("send_attachment", "caption") })),
			}),
			async execute(_toolCallId, params, signal) {
				const body = await callBridge("send_attachment", params, signal);
				return bridgeResult(body, "Attachment sent.", true);
			},
		});
	}

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
				cron: Type.String({ description: parameterDescription("add_schedule", "cron") }),
				prompt: Type.String({ description: parameterDescription("add_schedule", "prompt") }),
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
