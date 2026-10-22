import { defineConfig } from "vitest/config";

// Backend tests run in plain Node (no TanStack/Vite SSR plugin) against a
// per-worker temporary PGlite data dir (see test/setup.ts).
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
    setupFiles: ["./test/setup.ts"],
  },
});
