import type * as Store from "../src/db/store.js";
import type { NewMachine } from "../src/db/schema.js";

type StoreModule = typeof Store;
type LoopSeedRequired = Pick<Store.CreateLoopInput, "userId" | "machineId" | "name" | "cron" | "workdir">;
export type TestLoopSeed = LoopSeedRequired & Partial<Omit<Store.CreateLoopInput, keyof LoopSeedRequired>>;
type MachineCreateInput = Parameters<StoreModule["createMachine"]>[0];
type MachineSeedRequired = Pick<MachineCreateInput, "id" | "userId" | "name" | "tokenHash">;
export type TestMachineSeed = MachineSeedRequired & Partial<Omit<MachineCreateInput, keyof MachineSeedRequired>>;

export type TestStore = Omit<StoreModule, "createLoop" | "createMachine"> & {
  createLoop(input: TestLoopSeed): ReturnType<StoreModule["createLoop"]>;
  createMachine(input: TestMachineSeed): ReturnType<StoreModule["createMachine"]>;
};

/** Test-only seed adapter. It keeps lifecycle tests terse while every actual store
 * call receives the same complete, current internal row shape as canonical writes. */
export function testStore(store: StoreModule): TestStore {
  return {
    ...store,
    createLoop(input) {
      const scheduleMode = input.scheduleMode ?? "cron";
      const timezone = input.timezone !== undefined
        ? input.timezone
        : scheduleMode === "cron" ? "UTC" : null;
      return store.createLoop({
        teamId: `team-${input.userId}`,
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
      return store.createMachine({ teamId: `team-${input.userId}`, ...input } as MachineCreateInput);
    },
  };
}
