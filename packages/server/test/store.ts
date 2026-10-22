import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";

import type * as Store from "../src/db/store.js";
import {
  artifactFiles,
  loops,
  runLeases,
  runReportReceipts,
  runs,
  terminalReportIncidents,
  type ArtifactFile,
  type NewRun,
  type Run,
} from "../src/db/schema.js";

type StoreModule = typeof Store;
type LoopSeedRequired = Pick<Store.CreateLoopInput, "machineId" | "name" | "cron" | "workdir">;
export type TestLoopSeed = LoopSeedRequired & Partial<Omit<Store.CreateLoopInput, keyof LoopSeedRequired>>;
type MachineCreateInput = Parameters<StoreModule["createMachine"]>[0];
type MachineSeedRequired = Pick<MachineCreateInput, "id" | "name" | "tokenHash">;
export type TestMachineSeed = MachineSeedRequired & Partial<Omit<MachineCreateInput, keyof MachineSeedRequired>>;

export type TestStore = Omit<StoreModule, "createLoop" | "createMachine"> & {
  createLoop(input: TestLoopSeed): ReturnType<StoreModule["createLoop"]>;
  createMachine(input: TestMachineSeed): ReturnType<StoreModule["createMachine"]>;
  addRun(input: AddRunInput): Promise<Run>;
  countTerminalReportIncidents(): Promise<number>;
  insertReportReceipt(input: typeof runReportReceipts.$inferInsert): Promise<void>;
  countReportReceipts(): Promise<number>;
  updateRun(id: string, patch: Partial<NewRun>): Promise<Run | undefined>;
  openRunsForLoop(loopId: string): Promise<Run[]>;
  listAllArtifactFiles(loopId: string): Promise<ArtifactFile[]>;
};

type AddRunInput = Omit<NewRun, "id" | "createdAt" | "updatedAt"> & {
  id?: string;
  createdAt?: string;
  updatedAt?: string;
};

type TestDb = typeof import("../src/db/index.js")["db"];
type TestStoreTx = Parameters<Parameters<TestDb["transaction"]>[0]>[0];

async function getTestDb(): Promise<TestDb> {
  return (await import("../src/db/index.js")).db;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function allocateRunIndex(tx: TestStoreTx, loopId: string): Promise<number> {
  const updated = (await tx.update(loops)
    .set({ lastRunIndex: sql`${loops.lastRunIndex} + 1` })
    .where(eq(loops.id, loopId))
    .returning({ runIndex: loops.lastRunIndex }))[0];
  if (!updated) throw new Error(`cannot allocate history index for missing loop ${loopId}`);
  return updated.runIndex;
}

export async function addRun(input: AddRunInput): Promise<Run> {
  const database = await getTestDb();
  return database.transaction(async (tx) => {
    const loop = (await tx.select().from(loops).where(eq(loops.id, input.loopId)).for("update"))[0];
    if (!loop) throw new Error(`cannot add run for missing loop ${input.loopId}`);
    let runIndex = input.runIndex;
    if (runIndex != null) {
      await tx.update(loops).set({ lastRunIndex: sql`greatest(${loops.lastRunIndex}, ${runIndex})` }).where(eq(loops.id, loop.id));
    } else if (input.phase !== "pending") {
      runIndex = await allocateRunIndex(tx, loop.id);
    }
    const executing = input.phase === "running";
    const at = input.ts;
    const row: NewRun = {
      ...input,
      ...(runIndex != null ? { runIndex } : {}),
      ...(executing ? {
        agent: input.agent ?? loop.agent,
        model: input.model ?? loop.model,
        reasoningEffort: input.reasoningEffort ?? loop.reasoningEffort,
      } : {}),
      id: input.id ?? randomUUID(),
      createdAt: input.createdAt ?? at,
      updatedAt: input.updatedAt ?? at,
    };
    return (await tx.insert(runs).values(row).returning())[0]!;
  });
}

export async function countTerminalReportIncidents(): Promise<number> {
  const database = await getTestDb();
  const row = (await database.select({ n: sql<number>`count(*)` }).from(terminalReportIncidents))[0];
  return Number(row?.n ?? 0);
}

export async function insertReportReceipt(input: typeof runReportReceipts.$inferInsert): Promise<void> {
  await (await getTestDb()).insert(runReportReceipts).values(input);
}

export async function countReportReceipts(): Promise<number> {
  const database = await getTestDb();
  const row = (await database.select({ n: sql<number>`count(*)` }).from(runReportReceipts))[0];
  return Number(row?.n ?? 0);
}

export async function updateRun(id: string, patch: Partial<NewRun>): Promise<Run | undefined> {
  const database = await getTestDb();
  await database.update(runs).set({ ...patch, updatedAt: new Date().toISOString() }).where(eq(runs.id, id));
  return (await database.select().from(runs).where(eq(runs.id, id)))[0];
}

export async function openRunsForLoop(loopId: string): Promise<Run[]> {
  return (await getTestDb()).select().from(runs).where(and(eq(runs.loopId, loopId), inArray(runs.phase, ["pending", "running"])));
}

export async function listAllArtifactFiles(loopId: string): Promise<ArtifactFile[]> {
  return (await getTestDb()).select().from(artifactFiles).where(eq(artifactFiles.loopId, loopId)).orderBy(artifactFiles.path);
}

export interface RunLeaseRegistration {
  runId: string;
  loopId: string;
  machineId: string;
}

export async function registerRunLease(caps: RunLeaseRegistration): Promise<string> {
  const token = `rk_${randomBytes(16).toString("hex")}`;
  await (await getTestDb()).insert(runLeases).values({
    tokenHash: sha256(token),
    runId: caps.runId,
    loopId: caps.loopId,
    machineId: caps.machineId,
    createdAt: new Date().toISOString(),
  });
  return token;
}

/** Test-only seed adapter. It keeps lifecycle tests terse while every actual store
 * call receives the same complete, current internal row shape as canonical writes. */
export function testStore(store: StoreModule): TestStore {
  return {
    ...store,
    addRun,
    countTerminalReportIncidents,
    insertReportReceipt,
    countReportReceipts,
    updateRun,
    openRunsForLoop,
    listAllArtifactFiles,
    createLoop(input) {
      const scheduleMode = input.scheduleMode ?? "cron";
      const timezone = input.timezone !== undefined
        ? input.timezone
        : scheduleMode === "cron" ? "UTC" : null;
      return store.createLoop({
        prompt: "Test prompt.",
        statusKeep: "Keep the test result.",
        statusNoChange: "No test change was needed.",
        statusBlock: "The test needs owner input.",
        agent: "claude-code",
        cronOverlap: "queue-one",
        continuousDelayMinutes: 1,
        ...input,
        scheduleMode,
        timezone,
      } as Store.CreateLoopInput);
    },
    createMachine(input) {
      return store.createMachine(input as MachineCreateInput);
    },
  };
}
