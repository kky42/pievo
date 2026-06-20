import { renderPrompt, readPrompt } from "../../prompts/index.js";

export const PRIVATE_OUTPUT_DEVELOPER_INSTRUCTIONS = readPrompt("additional-system/private-chat.md");

export function buildGroupOutputDeveloperInstructions({
  botName = "Pievo",
  botHandle = "@unknown"
} = {}) {
  return renderPrompt("additional-system/group-chat.md", {
    bot_name: botName,
    bot_handle: botHandle
  });
}
