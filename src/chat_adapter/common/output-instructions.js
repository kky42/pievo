import { renderPrompt } from "../../prompts/index.js";
import { localTimeZoneInfo } from "../../utils.js";

function localTimePromptValues() {
  const { timeZone, utcOffset } = localTimeZoneInfo();
  return {
    local_timezone: timeZone,
    local_utc_offset: utcOffset
  };
}

export function buildPrivateOutputDeveloperInstructions() {
  return renderPrompt("additional-system/private-chat.md", localTimePromptValues());
}

export const PRIVATE_OUTPUT_DEVELOPER_INSTRUCTIONS = buildPrivateOutputDeveloperInstructions();

export function buildGroupOutputDeveloperInstructions({
  botName = "Pievo",
  botHandle = "@unknown"
} = {}) {
  return renderPrompt("additional-system/group-chat.md", {
    bot_name: botName,
    bot_handle: botHandle,
    ...localTimePromptValues()
  });
}
