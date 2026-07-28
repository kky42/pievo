import { describe, expect, test, vi } from "vitest";

import { LatestDaemonVersion, fetchNpmLatest } from "./daemonVersion.js";

function jsonFetch(body: unknown, ok = true): typeof fetch {
  return (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;
}

describe("fetchNpmLatest", () => {
  test("returns dist-tags.latest on a good response", async () => {
    const v = await fetchNpmLatest(jsonFetch({ "dist-tags": { latest: "0.9.0" } }));
    expect(v).toBe("0.9.0");
  });

  test("non-ok response → null", async () => {
    expect(await fetchNpmLatest(jsonFetch({}, false))).toBeNull();
  });

  test("malformed body → null (no latest tag)", async () => {
    expect(await fetchNpmLatest(jsonFetch({ "dist-tags": {} }))).toBeNull();
    expect(await fetchNpmLatest(jsonFetch({ "dist-tags": { latest: 42 } }))).toBeNull();
  });

  test("a throwing/aborting fetch → null (fail-silent, never throws)", async () => {
    const boom = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    await expect(fetchNpmLatest(boom)).resolves.toBeNull();
  });
});

describe("LatestDaemonVersion cache", () => {
  test("get() is null until refreshed, then returns the cached value", async () => {
    const c = new LatestDaemonVersion(jsonFetch({ "dist-tags": { latest: "0.9.0" } }), 1000, () => 0);
    expect(c.get()).toBeNull();
    expect(await c.refresh()).toBe("0.9.0");
    expect(c.get()).toBe("0.9.0");
  });

  test("a failed refresh keeps the last good value and advances the stamp", async () => {
    let ok = true;
    const fetchImpl = (async () => ({ ok, json: async () => ({ "dist-tags": { latest: "0.9.0" } }) })) as unknown as typeof fetch;
    let now = 0;
    const c = new LatestDaemonVersion(fetchImpl, 1000, () => now);
    expect(await c.refresh()).toBe("0.9.0");
    ok = false;
    now = 5000;
    expect(await c.refresh()).toBe("0.9.0");
  });

  test("does not refetch while fresh (within TTL)", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ "dist-tags": { latest: "0.9.0" } }) })) as unknown as typeof fetch;
    let now = 0;
    const c = new LatestDaemonVersion(fetchImpl, 1000, () => now);
    await c.refresh();
    now = 500;
    c.get();
    c.get();
    await Promise.resolve();
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1);
  });
});
