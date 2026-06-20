import { toErrorMessage } from "../utils.js";
import { chatBindingKey, runtimeBindingKey } from "./runtime-registry.js";

function bindingRestartSignature(binding) {
  return JSON.stringify({
    platform: binding?.platform ?? null,
    bindingId: binding?.bindingId ?? null,
    username: binding?.username ?? null,
    serverUrl: binding?.serverUrl ?? null,
    token: binding?.token ?? null
  });
}

function bindingConfigSignature(binding) {
  return JSON.stringify(binding ?? null);
}

function replaceObjectContents(target, source) {
  // Runtime bot configs are normalized plain JSON objects.
  for (const key of Object.keys(target)) {
    delete target[key];
  }
  Object.assign(target, structuredClone(source));
}

export function classifyBindings(currentRuntimes, desiredBindings) {
  const currentByKey = new Map(currentRuntimes.map((runtime) => [runtimeBindingKey(runtime), runtime]));
  const desiredByKey = new Map(desiredBindings.map((binding) => [chatBindingKey(binding), binding]));
  const removed = [];
  const added = [];
  const unchanged = [];
  const updated = [];
  const restarted = [];

  for (const [key, runtime] of currentByKey.entries()) {
    const desired = desiredByKey.get(key);
    if (!desired) {
      removed.push({ key, runtime });
      continue;
    }
    if (bindingRestartSignature(runtime.botConfig) !== bindingRestartSignature(desired)) {
      restarted.push({ key, runtime, desired });
      continue;
    }
    if (bindingConfigSignature(runtime.botConfig) !== bindingConfigSignature(desired)) {
      updated.push({ key, runtime, desired });
      continue;
    }
    unchanged.push({ key, runtime, desired });
  }

  for (const [key, desired] of desiredByKey.entries()) {
    if (!currentByKey.has(key)) {
      added.push({ key, desired });
    }
  }

  return { removed, added, unchanged, updated, restarted };
}

export class RuntimeReconciler {
  constructor({ runtimeRegistry, createRuntime }) {
    this.runtimeRegistry = runtimeRegistry;
    this.createRuntime = createRuntime;
  }

  classifyBindings(currentRuntimes, desiredBindings) {
    return classifyBindings(currentRuntimes, desiredBindings);
  }

  requestRuntimeStop(runtime, failures) {
    try {
      if (typeof runtime.requestStop === "function") {
        runtime.requestStop();
      } else {
        runtime.retiring = true;
      }
      return true;
    } catch (error) {
      failures.push({
        target: runtimeBindingKey(runtime),
        message: toErrorMessage(error)
      });
      return false;
    }
  }

  async stopRuntime(runtime, failures) {
    try {
      await runtime.stop();
      return true;
    } catch (error) {
      failures.push({
        target: runtimeBindingKey(runtime),
        message: toErrorMessage(error)
      });
      return false;
    }
  }

  async stopPendingRuntimes(pendingStops, failures) {
    for (const runtime of pendingStops) {
      await this.stopRuntime(runtime, failures);
    }
  }

  async startRuntime(bindingConfig, failures, startOptions = {}) {
    const key = chatBindingKey(bindingConfig);
    try {
      const runtime = this.createRuntime(structuredClone(bindingConfig));
      await runtime.start(startOptions);
      return runtime;
    } catch (error) {
      failures.push({
        target: key,
        message: toErrorMessage(error)
      });
      return null;
    }
  }

  retireConflictingRuntimeForAddedBinding({ key, desired, agentId, failures, pendingStops }) {
    const existing = this.runtimeRegistry.find({
      platform: desired.platform,
      bindingId: desired.bindingId
    });
    if (!existing) {
      return true;
    }

    const existingAgentId = existing.botConfig?.agent?.id;
    if (existingAgentId === agentId) {
      failures.push({
        target: key,
        message: "Chat binding runtime is already registered for this agent."
      });
      return false;
    }

    const stopRequested = this.requestRuntimeStop(existing, failures);
    if (!stopRequested) {
      return false;
    }
    this.runtimeRegistry.removeByKey(key);
    pendingStops.push(existing);
    return true;
  }

  async reconcileAgentRuntimes({
    agentId,
    desiredBindings,
    failures,
    beforeRetireRuntime = async () => {}
  }) {
    const pendingStops = [];
    const currentRuntimes = this.runtimeRegistry.forAgent(agentId);
    const classified = this.classifyBindings(currentRuntimes, desiredBindings);
    const counts = {
      added: 0,
      removed: 0,
      restarted: 0,
      updated: 0,
      unchanged: classified.unchanged.length
    };

    for (const { key, desired } of classified.added) {
      const canAdd = this.retireConflictingRuntimeForAddedBinding({
        key,
        desired,
        agentId,
        failures,
        pendingStops
      });
      if (!canAdd) {
        continue;
      }
      const runtime = await this.startRuntime(desired, failures, {
        restoreScheduledConversations: false
      });
      if (runtime) {
        this.runtimeRegistry.add(runtime);
        counts.added += 1;
      }
    }

    for (const { key, runtime, desired } of classified.restarted) {
      const replacement = await this.startRuntime(desired, failures, {
        restoreScheduledConversations: false
      });
      if (!replacement) {
        continue;
      }
      await beforeRetireRuntime(runtime);
      const stopRequested = this.requestRuntimeStop(runtime, failures);
      if (!stopRequested) {
        this.requestRuntimeStop(replacement, failures);
        pendingStops.push(replacement);
        continue;
      }
      this.runtimeRegistry.replaceByKey(key, replacement);
      pendingStops.push(runtime);
      counts.restarted += 1;
    }

    for (const { key, runtime } of classified.removed) {
      await beforeRetireRuntime(runtime);
      const stopRequested = this.requestRuntimeStop(runtime, failures);
      if (!stopRequested) {
        continue;
      }
      this.runtimeRegistry.removeByKey(key);
      pendingStops.push(runtime);
      counts.removed += 1;
    }

    for (const { runtime, desired } of classified.updated) {
      replaceObjectContents(runtime.botConfig, desired);
      counts.updated += 1;
    }

    return { counts, pendingStops, classified };
  }
}
