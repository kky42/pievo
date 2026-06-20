export function resultTextForConversation(session) {
  return `Reset this conversation to current agent profile defaults. Started a new Pi session with workdir ${session.workdir}, auto ${session.auto}, model ${session.model}, reasoning effort ${session.reasoningEffort}.`;
}

export function formatAgentProfileResetSummary(result) {
  const status = result.ok ? "Reset agent profile" : "Reset agent profile with errors";
  const lines = [
    `${status} ${result.agentId}.`,
    `Bindings: ${result.bindings.added} added, ${result.bindings.removed} removed, ${result.bindings.restarted} restarted, ${result.bindings.updated} updated, ${result.bindings.unchanged} unchanged, ${result.bindings.failed} failed.`,
    `Conversations: ${result.conversations.live} live reset, ${result.conversations.durable} durable reset.`,
    `Schedules: ${result.schedules.timers} active timers resynced.`
  ];
  if (result.runs.aborted > 0 || result.runs.queuesCleared > 0) {
    lines.push(`Runs: ${result.runs.aborted} aborted, ${result.runs.queuesCleared} queues cleared.`);
  }
  if (result.failures.length > 0) {
    lines.push("Failed:");
    for (const failure of result.failures) {
      lines.push(`${failure.target}: ${failure.message}`);
    }
  }
  return lines.join("\n");
}
