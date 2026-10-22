import type { Loop, Run } from "../db/schema.js";
import * as store from "../db/store.js";
import { loopFileNames } from "./loopFiles.js";
import { buildRunTask } from "./prompt.js";

export async function buildDelivery(loop: Loop, queuedRun: Run, runToken: string, roots: string[]) {
  if (queuedRun.runIndex == null) throw new Error(`claimed run ${queuedRun.id} has no history index`);
  const notices = await store.previousRunFileNotices(loop.id, queuedRun.runIndex);
  return {
    runId: queuedRun.id,
    runIndex: queuedRun.runIndex,
    runToken,
    roots,
    loop: {
      id: loop.id,
      name: loop.name,
      workdir: loop.workdir,
      model: loop.model ?? null,
      reasoningEffort: loop.reasoningEffort ?? null,
      agent: loop.agent,
    },
    task: buildRunTask(loop, notices),
    files: loopFileNames(loop),
  };
}
