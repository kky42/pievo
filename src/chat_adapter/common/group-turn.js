import { readPrompt, renderPrompt } from "../../prompts/index.js";

export function buildGroupInputMessage(groupInput = {}) {
  const messages = Array.isArray(groupInput.messages) ? groupInput.messages.filter(Boolean) : [];
  if (messages.length === 0) {
    return "";
  }

  const intro = readPrompt("templates/group-transcript-incremental-intro.md");

  return renderPrompt("templates/group-transcript.md", {
    intro,
    messages: messages.join("\n\n")
  });
}

export function mergeGroupInput(target = {}, source = {}) {
  return {
    messages: [
      ...(Array.isArray(target.messages) ? target.messages : []),
      ...(Array.isArray(source.messages) ? source.messages : [])
    ]
  };
}

export function mergeGroupTurns(target, source) {
  target.groupInput = mergeGroupInput(target.groupInput, source.groupInput);
  target.promptText = buildGroupInputMessage(target.groupInput);
  return target;
}
