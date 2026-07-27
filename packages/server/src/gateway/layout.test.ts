import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

/**
 * Gateway layout guard - pins the module structure the two extraction cuts
 * (ArtifactSync -> sync.ts, CliGateway -> cli.ts) established, so it can't
 * silently regress in review noise (same test-as-guardrail pattern as the
 * daemon's sync-skill.test.ts):
 *
 *   - dependency direction is one-way: cli.ts / sync.ts import index.ts,
 *     never the reverse (no cycles, the core never depends on its satellites);
 *   - both write surfaces import the ONE validators module (the anti-drift
 *     invariant documented in validate.ts);
 *   - http.ts stays a leaf (shared wire helpers must not grow gateway deps).
 */

const read = (name: string): string => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

/** The module specifiers a file imports via `from "..."` (static imports only -
 *  the gateway modules under test use no dynamic import of siblings). */
const importsOf = (source: string): string[] =>
  [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);

test("index.ts never imports its extracted satellites (cli.ts / sync.ts)", () => {
  const imports = importsOf(read("index.ts"));
  expect(imports).not.toContain("./cli.js");
  expect(imports).not.toContain("./sync.js");
});

test("cli.ts and sync.ts do not import each other", () => {
  expect(importsOf(read("cli.ts"))).not.toContain("./sync.js");
  expect(importsOf(read("sync.ts"))).not.toContain("./cli.js");
});

test("all device gateway modules reuse the full-token-hash auth helper", () => {
  for (const module of ["index.ts", "cli.ts", "sync.ts"]) {
    expect(importsOf(read(module))).toContain("./deviceAuth.js");
  }
});

test("gateway create/edit use the canonical loop config validator", () => {
  expect(importsOf(read("index.ts"))).toContain("./loopConfig.js");
  expect(importsOf(read("cli.ts"))).toContain("./loopConfig.js");
});

test("http.ts is a leaf module (no gateway-internal imports)", () => {
  expect(importsOf(read("http.ts")).filter((s) => s.startsWith("./"))).toEqual([]);
});
