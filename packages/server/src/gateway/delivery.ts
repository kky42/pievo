import type { CodingAgent, Loop, Run } from "../db/schema.js";
import { buildRunTask } from "./prompt.js";

export interface Delivery {
  runId: string;
  runIndex: number;
  runToken: string;
  loop: {
    id: string;
    name: string;
    workdir: string;
    model: string | null;
    reasoningEffort: string | null;
    agent: CodingAgent;
  };
  roots: string[];
  task: string;
  /** Exact paths relative to workdir; collected once after provider exit. */
  artifacts: string[];
}

export async function buildDelivery(loop: Loop, queuedRun: Run, runToken: string, roots: string[]): Promise<Delivery> {
  if (queuedRun.runIndex == null) throw new Error(`claimed run ${queuedRun.id} has no history index`);
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
    task: buildRunTask(loop),
    artifacts: loop.artifacts,
  };
}
