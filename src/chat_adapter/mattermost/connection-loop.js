import { sleep, toErrorMessage } from "../../utils.js";

export const DEFAULT_RECONNECT_DELAY_MS = 2000;
export const DEFAULT_WATCHDOG_INTERVAL_MS = 30000;
export const DEFAULT_STALE_WEBSOCKET_MS = 5 * 60 * 1000;

export class MattermostConnectionLoop {
  constructor(runtime) {
    this.runtime = runtime;
  }

  async connect() {
    const runtime = this.runtime;
    if (runtime.websocket?.socket?.readyState === 1) {
      return runtime.websocket;
    }
    runtime.websocket?.close?.();
    runtime.websocket = null;

    let pendingWebSocket = null;
    try {
      const websocket = await runtime.botApi.connectWebSocket({
        onClient: (client) => {
          pendingWebSocket = client;
          runtime.pendingWebSocket = client;
          if (runtime.stopRequested) {
            client.close?.();
          }
        },
        onOpen: (client) => {
          runtime.lastWsOpenAt = client.openedAt ?? Date.now();
          runtime.lastWsActivityAt = client.lastActivityAt ?? client.lastMessageAt ?? runtime.lastWsOpenAt;
          runtime.lastWsMessageAt = client.lastMessageAt ?? runtime.lastWsOpenAt;
          runtime.log(`websocket open: reconnect_count=${runtime.reconnectCount}`);
        },
        onActivity: (now) => {
          runtime.lastWsActivityAt = now;
        },
        onMessage: () => {
          const now = Date.now();
          runtime.lastWsActivityAt = now;
          runtime.lastWsMessageAt = now;
        },
        onError: () => {
          runtime.lastWsErrorAt = Date.now();
        },
        onClose: ({ code, reason } = {}, client) => {
          runtime.lastWsCloseAt = Date.now();
          runtime.log(`websocket close observed: code=${code ?? "unknown"} reason=${reason || "none"}`);
          if (!client || runtime.websocket === client) {
            runtime.websocket = null;
          }
          runtime.wakeConnectionLoop?.();
        },
        onEvent: async (event) => {
          if (event.event === "posted") {
            await runtime.handleEvent(event);
          }
        }
      });

      if (runtime.pendingWebSocket === pendingWebSocket) {
        runtime.pendingWebSocket = null;
      }

      if (runtime.stopRequested) {
        websocket.close?.();
        return null;
      }

      runtime.websocket = websocket;
      runtime.reconnectCount += 1;
      runtime.log(`websocket reconnect success: count=${runtime.reconnectCount}`);

      for (const session of runtime.sessions.values()) {
        session.setWebSocket(runtime.websocket);
      }

      return runtime.websocket;
    } catch (error) {
      if (runtime.pendingWebSocket === pendingWebSocket) {
        runtime.pendingWebSocket = null;
      }
      throw error;
    }
  }

  isWebSocketStale(now = Date.now()) {
    const runtime = this.runtime;
    if (!runtime.websocket || runtime.websocket.socket?.readyState !== 1) {
      return false;
    }
    const lastActivityAt =
      runtime.websocket.lastActivityAt ?? runtime.websocket.lastMessageAt ?? runtime.lastWsActivityAt ?? runtime.lastWsMessageAt ?? runtime.lastWsOpenAt;
    return Boolean(lastActivityAt && now - lastActivityAt > runtime.staleWebSocketMs);
  }

  closeStaleWebSocket(now = Date.now()) {
    const runtime = this.runtime;
    if (!runtime.isWebSocketStale(now)) {
      return false;
    }
    const lastActivityAt =
      runtime.websocket?.lastActivityAt ?? runtime.websocket?.lastMessageAt ?? runtime.lastWsActivityAt ?? runtime.lastWsMessageAt ?? runtime.lastWsOpenAt;
    runtime.log(
      `websocket stale: last_activity_at=${lastActivityAt ?? "unknown"} stale_ms=${now - lastActivityAt}; reconnecting`
    );
    const websocket = runtime.websocket;
    runtime.websocket = null;
    websocket?.close?.();
    return true;
  }

  waitForConnectionLoopWake(ms) {
    const runtime = this.runtime;
    return new Promise((resolve) => {
      const previousWake = runtime.wakeConnectionLoop;
      let settled = false;
      let timer = null;
      const wake = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        if (runtime.wakeConnectionLoop === wake) {
          runtime.wakeConnectionLoop = previousWake;
        }
        resolve();
      };
      runtime.wakeConnectionLoop = wake;
      timer = setTimeout(wake, ms);
      if (runtime.stopRequested || runtime.websocket?.socket?.readyState !== 1) {
        wake();
      }
    });
  }

  async start({ restoreScheduledConversations = true } = {}) {
    const runtime = this.runtime;
    if (runtime.running) {
      return;
    }
    runtime.stopRequested = false;
    await runtime.initialize({ restoreScheduledConversations });
    runtime.running = true;
    runtime.connectPromise = (async () => {
      while (!runtime.stopRequested) {
        try {
          await runtime.connect();
          while (!runtime.stopRequested && runtime.websocket?.socket?.readyState === 1) {
            if (runtime.closeStaleWebSocket()) {
              break;
            }
            await runtime.waitForConnectionLoopWake(runtime.watchdogIntervalMs);
          }
        } catch (error) {
          if (runtime.stopRequested) {
            break;
          }
          runtime.lastWsErrorAt = Date.now();
          runtime.log(`mattermost connection failure: ${toErrorMessage(error)}; retrying in ${runtime.reconnectDelayMs}ms`);
          await sleep(runtime.reconnectDelayMs);
        }
      }
    })();
  }

  async stop() {
    const runtime = this.runtime;
    runtime.requestStop();
    await runtime.abortBackgroundRuns({ suppressNotification: true });
    for (const session of runtime.sessions.values()) {
      session.queue = [];
      session.stopTyping();
      await session.abortCurrentRun();
    }
    if (runtime.connectPromise) {
      await runtime.connectPromise;
    }
  }
}

export function createMattermostConnectionLoop(runtime) {
  return new MattermostConnectionLoop(runtime);
}
