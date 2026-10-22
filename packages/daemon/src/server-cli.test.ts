import fs from "node:fs";
import { expect, test } from "vitest";

import { serverLauncherPath } from "./server-cli.js";

test("resolves the installed server package's lifecycle launcher", () => {
  const launcher = serverLauncherPath();
  expect(launcher).toMatch(/scripts[\\/]pievo-server\.mjs$/);
  expect(fs.existsSync(launcher)).toBe(true);
});
