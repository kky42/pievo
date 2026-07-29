import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import { PIEVO_DIR } from "./config.js";

test("tests never resolve the production daemon home", () => {
  expect(process.env.PIEVO_HOME).toBeTruthy();
  expect(PIEVO_DIR).toBe(process.env.PIEVO_HOME);
  expect(PIEVO_DIR).not.toBe(path.join(os.homedir(), ".pievo"));
});
