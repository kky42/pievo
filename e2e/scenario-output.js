export class ScenarioOutput {
  constructor(recorder) {
    this.recorder = recorder;
  }

  resetTransientState() {}
  startTyping() {}
  stopTyping() {}
  async clearProgressMessage() {}

  async sendMessageChunk(text, options = {}) {
    this.recorder("text", { text: String(text ?? ""), options });
  }

  async editMessageChunk(_messageId, text, options = {}) {
    this.recorder("text_edit", { text: String(text ?? ""), options });
  }

  async sendSplitText(text, options = {}) {
    this.recorder("text", { text: String(text ?? ""), options });
  }

  async renderProgressText(text, options = {}) {
    this.recorder("progress", { text: String(text ?? ""), options });
  }

  async renderFinalMessage(text, options = {}) {
    this.recorder("final", { text: String(text ?? ""), options });
  }

  async renderGroupFinalMessage(text, options = {}) {
    this.recorder("suppressed_group_final", { text: String(text ?? ""), options });
  }

  async renderErrorText(text, options = {}) {
    this.recorder("error", { text: String(text ?? ""), options });
  }

  async sendText(text, options = {}) {
    this.recorder("text", { text: String(text ?? ""), options });
  }

  async sendNativeAttachment(entry, options = {}) {
    this.recorder("attachment", { entry, options });
  }
}

export function createEventRecorder(state, { now = () => new Date() } = {}) {
  return (kind, payload = {}) => {
    const event = {
      stepId: state.currentStepId,
      at: now().toISOString(),
      kind,
      ...payload,
      payload
    };
    state.events.push(event);
    return event;
  };
}
