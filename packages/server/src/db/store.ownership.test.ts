import { beforeAll, beforeEach, expect, test } from "vitest";

import { db, runMigrations } from "./index.js";
import { connectKeys, loops, machines } from "./schema.js";
import * as rawStore from "./store.js";
import { testStore } from "../../test/store.js";

const store = testStore(rawStore);

beforeAll(async () => {
  await runMigrations();
});

beforeEach(async () => {
  await db.delete(connectKeys);
  await db.delete(loops);
  await db.delete(machines);
});

test("loop and machine lists scope directly to owner userId", async () => {
  await store.createMachine({ id: "machine-a", userId: "user-a", name: "Alpha", tokenHash: "hash-a" });
  await store.createMachine({ id: "machine-b", userId: "user-b", name: "Beta", tokenHash: "hash-b" });
  await store.createLoop({
    id: "loop-a",
    userId: "user-a",
    machineId: "machine-a",
    name: "Alpha loop",
    cron: "0 6 * * *",
    workdir: "/work/a",
  });
  await store.createLoop({
    id: "loop-b",
    userId: "user-b",
    machineId: "machine-b",
    name: "Beta loop",
    cron: "0 7 * * *",
    workdir: "/work/b",
  });

  expect((await store.listLoops()).map((loop) => loop.id).sort()).toEqual(["loop-a", "loop-b"]);
  expect((await store.listLoopsForUser("user-a")).map((loop) => loop.id)).toEqual(["loop-a"]);
  expect((await store.listMachines()).map((machine) => machine.id)).toEqual(["machine-a", "machine-b"]);
  expect((await store.listMachinesForUser("user-b")).map((machine) => machine.id)).toEqual(["machine-b"]);
});

test("loop creation requires the machine owner", async () => {
  await store.createMachine({ id: "machine-owner", userId: "user-a", name: "Owner", tokenHash: "hash-owner" });

  await expect(store.createLoop({
    id: "loop-wrong-owner",
    userId: "user-b",
    machineId: "machine-owner",
    name: "Wrong owner",
    cron: "0 8 * * *",
    workdir: "/work/wrong",
  })).rejects.toThrow("machine machine-owner is owned by a different user");
  expect(await store.getLoop("loop-wrong-owner")).toBeUndefined();
});

test("owner-checked machine deletion atomically removes loops and enrollment", async () => {
  await store.createMachine({ id: "machine-delete", userId: "user-a", name: "Delete", tokenHash: "hash-delete" });
  await store.createMachine({ id: "machine-keep", userId: "user-b", name: "Keep", tokenHash: "hash-keep" });
  await store.createLoop({
    id: "loop-delete",
    userId: "user-a",
    machineId: "machine-delete",
    name: "Delete loop",
    cron: "0 9 * * *",
    workdir: "/work/delete",
  });
  await db.insert(connectKeys).values([
    { machineId: "machine-delete", userId: "user-a", mintedAt: "2025-01-01T00:00:00.000Z" },
    { machineId: "machine-keep", userId: "user-b", mintedAt: "2025-01-01T00:00:00.000Z" },
  ]);

  expect(await store.forceDeleteMachine("machine-delete", "user-b")).toEqual({ state: "forbidden" });
  expect(await store.getMachine("machine-delete")).toBeDefined();
  expect(await store.getLoop("loop-delete")).toBeDefined();

  expect(await store.forceDeleteMachine("machine-delete", "user-a")).toEqual({
    state: "deleted",
    loopIds: ["loop-delete"],
  });
  expect(await store.getMachine("machine-delete")).toBeUndefined();
  expect(await store.getLoop("loop-delete")).toBeUndefined();
  expect(await db.select().from(connectKeys)).toEqual([
    expect.objectContaining({ machineId: "machine-keep", userId: "user-b" }),
  ]);
  expect(await store.getMachine("machine-keep")).toBeDefined();
});
