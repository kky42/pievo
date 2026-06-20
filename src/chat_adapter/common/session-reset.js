export async function prepareForSessionReset(session) {
  session.queue = [];
  await session.abortCurrentRun();
  session.stopTyping();
  session.resetTransientTurnState();
}

export async function resetSession(session, { clearSessionState = false } = {}) {
  await prepareForSessionReset(session);
  if (clearSessionState) {
    await session.clearSessionState();
  }
}
