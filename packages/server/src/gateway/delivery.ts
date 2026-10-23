import type { Loop, Run } from "../db/schema.js";
import * as store from "../db/store.js";
import { nowIso } from "./http.js";
import { buildRunTask } from "./prompt.js";

export async function buildDelivery(loop: Loop, queuedRun: Run, runToken: string, contextToken: string, roots: string[]) {
  if (queuedRun.runIndex == null) throw new Error(`claimed run ${queuedRun.id} has no history index`);
  const previous = await store.previousTerminalRun(loop.id, queuedRun.runIndex);
  return {
    runId: queuedRun.id,
    runIndex: queuedRun.runIndex,
    runToken,
    contextToken,
    roots,
    loop: {
      id: loop.id,
      name: loop.name,
      workdir: loop.workdir,
      model: loop.model ?? null,
      reasoningEffort: loop.reasoningEffort ?? null,
      agent: loop.agent,
    },
    task: buildRunTask(loop, { runIndex: queuedRun.runIndex, now: nowIso(), previous }),
    memory: { text: loop.memory },
  };
}
