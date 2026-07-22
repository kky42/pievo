/**
 * A delivery is everything the daemon needs to run one loop tick: the loop's
 * machine-side config + the server-composed system prompt and task. The daemon
 * writes the prompt to a file, then runs the selected coding agent.
 */
import type { CodingAgent, Loop, Run } from "../db/schema.js";
import {
  buildSteerPrompt,
  buildSteerTask,
  buildEvolvePrompt,
  buildEvolveTask,
  buildExecTask,
  buildLoopSystemPrompt,
} from "./prompt.js";

export interface Delivery {
  runId: string;
  runIndex: number;
  runToken: string;
  role: "exec" | "evolve" | "steer";
  loop: {
    id: string;
    name: string;
    /** Machine-side cwd; null ⇒ daemon picks a scratch dir. */
    workdir: string | null;
    taskFile: string | null;
    model: string | null;
    reasoningEffort: string | null;
    allowControl: boolean;
    /** Coding agent to EXECUTE this loop with (the daemon branches spawn +
     *  credentials on this — claude-code | codex). */
    agent: CodingAgent;
  };
  /** Machine workdir jail (server-configured; daemon enforces). [] = unrestricted. */
  roots: string[];
  systemPrompt: string;
  task: string;
}

export async function buildDelivery(loop: Loop, queuedRun: Run, runToken: string, roots: string[]): Promise<Delivery> {
  const runId = queuedRun.id;
  if (queuedRun.runIndex == null) throw new Error(`claimed run ${runId} has no history index`);
  const runIndex = queuedRun.runIndex;
  const role: Delivery["role"] = queuedRun.role;
  let systemPrompt: string;
  let task: string;
  switch (role) {
    case "evolve":
      systemPrompt = buildEvolvePrompt();
      task = buildEvolveTask(loop, runIndex);
      break;
    case "steer":
      systemPrompt = buildSteerPrompt();
      task = buildSteerTask(loop, queuedRun.requestText ?? "(no instruction - make no change and report that)", runIndex);
      break;
    case "exec":
      systemPrompt = buildLoopSystemPrompt(loop);
      task = buildExecTask(loop, runIndex);
      break;
    default:
      throw new Error(`unsupported run role: ${String(role)}`);
  }
  return {
    runId,
    runIndex,
    runToken,
    role,
    roots,
    loop: {
      id: loop.id,
      name: loop.name || loop.id,
      workdir: loop.workdir ?? null,
      taskFile: loop.taskFile ?? null,
      model: loop.model ?? null,
      reasoningEffort: loop.reasoningEffort ?? null,
      allowControl: loop.allowControl,
      agent: loop.agent,
    },
    systemPrompt,
    task,
  };
}
