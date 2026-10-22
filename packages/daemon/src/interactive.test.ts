import { expect, test } from "vitest";

import { runInteractive } from "./interactive.js";

test("force delete requires interactive double-confirmation before network mutation", async () => {
  let fetched = false;
  let err = "";
  const code = await runInteractive(["delete", "loop-1", "--force"], {
    out: () => {},
    err: (s) => { err += s; },
    server: "https://srv.test",
    token: "dk_test",
    fetchImpl: (async () => { fetched = true; throw new Error("must not fetch"); }) as typeof fetch,
    confirmForceDelete: async () => false,
  });
  expect(code).toBe(1);
  expect(fetched).toBe(false);
  expect(err).toContain("force delete canceled");
});
