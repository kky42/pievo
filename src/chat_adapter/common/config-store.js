export const NOOP_CONFIG_STORE = {
  async loadChatBindingConfig() {
    throw new Error("Config reload is unavailable.");
  },
  async loadAgentProfile() {
    throw new Error("Config reload is unavailable.");
  }
};
